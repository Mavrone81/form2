import 'package:sqflite/sqflite.dart';

import 'models.dart';

/// SQLite-backed local storage for the offline-first app: the cached form
/// `bundle` (one row per form) and the `records` queue (one row per
/// technician-filled record, from first draft through terminal
/// `synced`/`error`).
///
/// The bundle is replaced wholesale on every successful `GET /bundle` --
/// see [replaceBundle], which upserts the fetched forms AND deletes the rows
/// for forms the server no longer offers, in one transaction. That deletion
/// is the point: a form withdrawn, made `inactive`, or unmapped server-side
/// used to linger on the device for ever, still offered to a technician as
/// something to start a record against. Records are a separate table and are
/// never touched by it -- a draft against a form that has since disappeared
/// survives intact; it simply cannot be joined to a form definition any
/// more, and no NEW record can be started against one.
///
/// The [DatabaseFactory] and [path] are both constructor parameters, never
/// hard-coded, specifically so tests can point this at
/// `sqflite_common_ffi`'s in-memory factory (`databaseFactoryFfiNoIsolate`
/// with [inMemoryDatabasePath]) and never touch a platform channel; a real
/// app wires in `sqflite`'s default factory and a real on-disk path.
class LocalDb {
  // The public parameter names (`databaseFactory`, `path`) are kept
  // distinct from the private field names on purpose -- an initializing
  // formal (`this._databaseFactory`) would force callers in other
  // libraries to pass a private-named argument, which Dart does not allow.
  LocalDb({required DatabaseFactory databaseFactory, required String path})
      // ignore: prefer_initializing_formals
      : _databaseFactory = databaseFactory,
        // ignore: prefer_initializing_formals
        _path = path;

  final DatabaseFactory _databaseFactory;
  final String _path;
  Database? _db;

  Future<Database> get _database async => _db ??= await _open();

  Future<Database> _open() async {
    return _databaseFactory.openDatabase(
      _path,
      options: OpenDatabaseOptions(
        version: 1,
        // Each LocalDb already caches its own single Database instance in
        // [_db]; singleInstance:false here just stops the *factory's own*
        // path-keyed cache from handing two different LocalDb instances
        // (e.g. two tests that both use [inMemoryDatabasePath], which is
        // the same literal string every time) the same underlying
        // in-memory database, which would leak state across tests.
        singleInstance: false,
        onCreate: (db, version) async {
          await db.execute('''
            CREATE TABLE bundle (
              form_id INTEGER PRIMARY KEY,
              json TEXT NOT NULL,
              fetched_at TEXT NOT NULL
            )
          ''');
          await db.execute('''
            CREATE TABLE records (
              client_uuid TEXT PRIMARY KEY,
              form_id INTEGER NOT NULL,
              frequency TEXT NOT NULL,
              machine_id TEXT NOT NULL,
              values_json TEXT NOT NULL,
              signature_png TEXT NOT NULL,
              signed_at TEXT NOT NULL,
              status TEXT NOT NULL,
              server_id INTEGER,
              server_state TEXT,
              error TEXT
            )
          ''');
          // Records a record's creating username, purely device-local -- never
          // sent to the server (a record's sync payload is exactly
          // `LocalRecord.toSyncRecord()`, which does not include this). This
          // is what lets a shared device tell "my queued records" from
          // "the previous technician's queued records" apart once a
          // different username signs in: see [getRecordOwner] /
          // [setRecordOwner] / [getRecordsByStatusOwnedBy]. A row with no
          // entry here (older data, or a record inserted before this table
          // existed) is treated as unowned -- visible/syncable under any
          // signed-in technician -- rather than orphaned.
          await db.execute('''
            CREATE TABLE record_owners (
              client_uuid TEXT PRIMARY KEY,
              username TEXT NOT NULL
            )
          ''');
        },
      ),
    );
  }

  Future<void> close() async {
    final db = _db;
    if (db != null) {
      await db.close();
      _db = null;
    }
  }

  // -------------------------------------------------------------------
  // bundle
  // -------------------------------------------------------------------

  /// Replaces (or inserts) the cached bundle JSON for one form, stamping
  /// `fetched_at` with [fetchedAt] (defaults to now) -- a plain upsert, since
  /// the bundle is a full snapshot the server hands back each time, never
  /// something the device merges into.
  Future<void> upsertBundle(int formId, String json, {DateTime? fetchedAt}) async {
    final db = await _database;
    await db.insert(
      'bundle',
      {
        'form_id': formId,
        'json': json,
        'fetched_at': (fetchedAt ?? DateTime.now()).toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Makes the cached bundle exactly match one `GET /bundle` response, in a
  /// single transaction: every form in [jsonByFormId] is upserted (same
  /// semantics as [upsertBundle]), and every bundle row whose `form_id` is
  /// neither in it nor in [keep] is deleted.
  ///
  /// [keep] is for the server's own `skipped` list -- a form whose file the
  /// server could not read this time is NOT gone, it is temporarily
  /// unreadable, and dropping the copy this device already has (the only
  /// copy it has) over a transient server-side file problem would take a
  /// form away from a technician for no reason. Those ids are therefore
  /// spared without being refreshed.
  ///
  /// An empty [jsonByFormId] and [keep] deletes everything: a server that
  /// genuinely offers no ready forms is a real answer, and the device
  /// showing forms the server has withdrawn is exactly the state this
  /// replaces. (A failed fetch never gets here at all -- `refreshBundle`
  /// throws before calling this, leaving the cache untouched.)
  Future<void> replaceBundle(
    Map<int, String> jsonByFormId, {
    Set<int> keep = const {},
    DateTime? fetchedAt,
  }) async {
    final db = await _database;
    final stamp = (fetchedAt ?? DateTime.now()).toIso8601String();
    final keepIds = <int>{...jsonByFormId.keys, ...keep}.toList();
    await db.transaction((txn) async {
      for (final entry in jsonByFormId.entries) {
        await txn.insert(
          'bundle',
          {'form_id': entry.key, 'json': entry.value, 'fetched_at': stamp},
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
      if (keepIds.isEmpty) {
        await txn.delete('bundle');
      } else {
        // Built from the ids' own count, and every id bound as a parameter --
        // never interpolated -- so this stays a parameterised statement no
        // matter what the server sent.
        final placeholders = List.filled(keepIds.length, '?').join(',');
        await txn.delete('bundle', where: 'form_id NOT IN ($placeholders)', whereArgs: keepIds);
      }
    });
  }

  Future<Map<String, Object?>?> getBundle(int formId) async {
    final db = await _database;
    final rows = await db.query('bundle', where: 'form_id = ?', whereArgs: [formId], limit: 1);
    return rows.isEmpty ? null : rows.first;
  }

  Future<List<Map<String, Object?>>> getAllBundles() async {
    final db = await _database;
    return db.query('bundle');
  }

  // -------------------------------------------------------------------
  // records
  // -------------------------------------------------------------------

  /// Inserts a brand-new record. There is no prior status to guard against
  /// here -- [isValidRecordTransition] only applies to changing an existing
  /// row -- so a record may be first written as `draft` (the normal case) or
  /// directly as `queued`.
  Future<void> insertRecord(LocalRecord record) async {
    final db = await _database;
    await db.insert('records', record.toDbMap());
  }

  Future<LocalRecord?> getRecord(String clientUuid) async {
    final db = await _database;
    final rows = await db.query('records', where: 'client_uuid = ?', whereArgs: [clientUuid], limit: 1);
    return rows.isEmpty ? null : LocalRecord.fromDbMap(rows.first);
  }

  Future<List<LocalRecord>> getRecordsByStatus(RecordStatus status) async {
    final db = await _database;
    final rows = await db.query('records', where: 'status = ?', whereArgs: [status.dbValue]);
    return rows.map(LocalRecord.fromDbMap).toList();
  }

  Future<List<LocalRecord>> getQueuedRecords() => getRecordsByStatus(RecordStatus.queued);

  Future<List<LocalRecord>> getAllRecords() async {
    final db = await _database;
    final rows = await db.query('records');
    return rows.map(LocalRecord.fromDbMap).toList();
  }

  /// Writes [updated] over the existing row for `updated.clientUuid`,
  /// enforcing [isValidRecordTransition] against whatever status is
  /// currently stored. Use this for a draft edit (`draft` -> `draft`) or a
  /// draft -> queued submit; [markSynced]/[markError]/[requeue] cover the
  /// three sync-driven transitions and apply the same guard.
  Future<void> updateRecord(LocalRecord updated) async {
    final current = await getRecord(updated.clientUuid);
    if (current == null) {
      throw ArgumentError('No existing record ${updated.clientUuid} to update');
    }
    _assertValidTransition(current.status, updated.status, updated.clientUuid);
    final db = await _database;
    await db.update('records', updated.toDbMap(), where: 'client_uuid = ?', whereArgs: [updated.clientUuid]);
  }

  /// Marks a `queued` record `synced`, storing the server's assigned id and
  /// (optionally) the server's `state` string -- present for every
  /// no-error result, including "adjudicated" ones like `rejected` or
  /// `pending_lead`, which the sync contract still counts as "the server
  /// holds it" from the device's perspective.
  Future<void> markSynced(String clientUuid, {required int? serverId, String? state}) async {
    final current = await _requireRecord(clientUuid);
    _assertValidTransition(current.status, RecordStatus.synced, clientUuid);
    final db = await _database;
    await db.update(
      'records',
      {'status': RecordStatus.synced.dbValue, 'server_id': serverId, 'server_state': state, 'error': null},
      where: 'client_uuid = ?',
      whereArgs: [clientUuid],
    );
  }

  /// Marks a `queued` record `error`, storing [message] (typically
  /// `"$code: $message"` from the server's per-record error).
  Future<void> markError(String clientUuid, String message) async {
    final current = await _requireRecord(clientUuid);
    _assertValidTransition(current.status, RecordStatus.error, clientUuid);
    final db = await _database;
    await db.update(
      'records',
      {'status': RecordStatus.error.dbValue, 'error': message},
      where: 'client_uuid = ?',
      whereArgs: [clientUuid],
    );
  }

  /// Retries an `error` record by moving it back to `queued` so the next
  /// [SyncQueue.replay] picks it up again, clearing the stale [error]
  /// message that would otherwise linger and misdescribe a fresh attempt.
  /// (The same guard also legally accepts `draft` -> `queued` -- the plain
  /// first-submit case, identical to what [updateRecord] would do -- since
  /// [isValidRecordTransition] doesn't distinguish "retry" from "submit";
  /// both just mean "this record is ready to go out.")
  Future<void> requeue(String clientUuid) async {
    final current = await _requireRecord(clientUuid);
    _assertValidTransition(current.status, RecordStatus.queued, clientUuid);
    final db = await _database;
    await db.update(
      'records',
      {'status': RecordStatus.queued.dbValue, 'error': null},
      where: 'client_uuid = ?',
      whereArgs: [clientUuid],
    );
  }

  Future<LocalRecord> _requireRecord(String clientUuid) async {
    final current = await getRecord(clientUuid);
    if (current == null) {
      throw ArgumentError('No existing record $clientUuid');
    }
    return current;
  }

  void _assertValidTransition(RecordStatus from, RecordStatus to, String clientUuid) {
    if (!isValidRecordTransition(from, to)) {
      throw InvalidRecordTransition(from, to, clientUuid);
    }
  }

  // -------------------------------------------------------------------
  // record ownership (device-local only; see the `record_owners` doc above)
  // -------------------------------------------------------------------

  Future<void> setRecordOwner(String clientUuid, String username) async {
    final db = await _database;
    await db.insert(
      'record_owners',
      {'client_uuid': clientUuid, 'username': username},
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<String?> getRecordOwner(String clientUuid) async {
    final db = await _database;
    final rows = await db.query('record_owners', where: 'client_uuid = ?', whereArgs: [clientUuid], limit: 1);
    return rows.isEmpty ? null : rows.first['username'] as String?;
  }

  /// Every [status] record either unowned (no `record_owners` row -- legacy
  /// or pre-ownership data) or owned by [username] -- i.e. every record
  /// [username] may safely view, edit, or sync. A record owned by a
  /// DIFFERENT username is excluded: it stays in `records` untouched
  /// (nothing here mutates it), simply invisible to this query, so it can
  /// neither be replayed to the server under the wrong device token nor
  /// edited by the wrong technician.
  Future<List<LocalRecord>> getRecordsByStatusOwnedBy(RecordStatus status, String username) async {
    final rows = await getRecordsByStatus(status);
    final result = <LocalRecord>[];
    for (final r in rows) {
      final owner = await getRecordOwner(r.clientUuid);
      if (owner == null || owner == username) result.add(r);
    }
    return result;
  }

  Future<List<LocalRecord>> getQueuedRecordsOwnedBy(String username) =>
      getRecordsByStatusOwnedBy(RecordStatus.queued, username);

  /// Every NOT-YET-SYNCED record on this device (draft/queued/error) that is
  /// NOT owned by [username] -- i.e. left behind by a previously signed-in
  /// technician and still needing attention. Used to show a "N records
  /// belong to another technician" notice; never used to decide what to
  /// sync (see [getQueuedRecordsOwnedBy] for that). `synced` records are
  /// deliberately excluded: a synced record is already safely on the
  /// server and needs nothing further from anyone, so it has no business
  /// prompting a "belongs to someone else" notice on a device that is,
  /// otherwise, doing nothing wrong.
  Future<int> countRecordsOwnedByOthers(String username) async {
    final all = await getAllRecords();
    var count = 0;
    for (final r in all) {
      if (r.status == RecordStatus.synced) continue;
      final owner = await getRecordOwner(r.clientUuid);
      if (owner != null && owner != username) count++;
    }
    return count;
  }
}
