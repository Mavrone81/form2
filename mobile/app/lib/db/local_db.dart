import 'package:sqflite/sqflite.dart';

import 'models.dart';

/// SQLite-backed local storage for the offline-first app: the cached form
/// `bundle` (one row per form, replaced wholesale on every successful
/// `GET /bundle`) and the `records` queue (one row per technician-filled
/// record, from first draft through terminal `synced`/`error`).
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
}
