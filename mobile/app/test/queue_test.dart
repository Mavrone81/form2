import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/sync/queue.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

LocalDb _newDb() {
  return LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);
}

LocalRecord _queuedRecord(String clientUuid) {
  return LocalRecord(
    clientUuid: clientUuid,
    formId: 5,
    frequency: '1M',
    machineId: 'GEN-1',
    values: {'field_a': 'Pass'},
    signaturePng: 'base64pngdata',
    signedAt: '2026-08-14T10:00:00.000Z',
    status: RecordStatus.queued,
  );
}

const _uuidA = '11111111-1111-4111-8111-111111111111';
const _uuidB = '22222222-2222-4222-8222-222222222222';
const _uuidC = '33333333-3333-4333-8333-333333333333';

/// Answers every `sync` call with [resultsFor], keyed by client_uuid, and
/// counts how many times it was called and with how many records --
/// exactly what the "double replay sends nothing the second time" test
/// needs to assert against.
class _ScriptedApiClient extends ApiClient {
  _ScriptedApiClient(this.resultsFor);

  final Map<String, SyncResult> resultsFor;
  int callCount = 0;
  final List<int> batchSizes = [];

  @override
  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    callCount++;
    batchSizes.add(records.length);
    return records.map((r) => resultsFor[r.clientUuid]!).toList();
  }
}

/// Always throws [ApiException] -- simulates a whole-batch transport
/// failure (expired token, network drop, ...).
class _AlwaysFailsApiClient extends ApiClient {
  int callCount = 0;

  @override
  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    callCount++;
    throw ApiException(401, 'device token expired');
  }
}

/// Simulates a crash *during* a replay: the server has genuinely already
/// processed the first record (this fake writes that fact straight to
/// [db], standing in for the write `SyncQueue.replay` itself would have
/// done after receiving a real response) before the process dies -- here,
/// before the `sync` call can return anything to its caller at all. A
/// second, ordinary `replay()` afterwards must not re-send the
/// already-synced record and must still get the remaining ones through.
class _CrashMidBatchApiClient extends ApiClient {
  _CrashMidBatchApiClient(this.db);

  final LocalDb db;

  @override
  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    await db.markSynced(records.first.clientUuid, serverId: 900, state: 'pending_lead');
    throw ApiException(500, 'connection reset mid-batch');
  }
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  group('SyncQueue.replay success', () {
    test('marks every queued record synced and stores server_id + state', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));
      await db.insertRecord(_queuedRecord(_uuidB));

      final api = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, submissionId: 100, state: 'pending_lead'),
        _uuidB: SyncResult(clientUuid: _uuidB, submissionId: 101, state: 'approved'),
      });

      final result = await SyncQueue(db).replay(api);

      expect(result.synced.toSet(), {_uuidA, _uuidB});
      expect(result.errored, isEmpty);

      final a = await db.getRecord(_uuidA);
      expect(a!.status, RecordStatus.synced);
      expect(a.serverId, 100);
      expect(a.serverState, 'pending_lead');

      final b = await db.getRecord(_uuidB);
      expect(b!.status, RecordStatus.synced);
      expect(b.serverId, 101);
    });

    test('a rejected-state result (no error) still counts as synced, with state stored', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));

      final api = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, submissionId: 55, state: 'rejected'), // error deliberately absent
      });

      final result = await SyncQueue(db).replay(api);

      expect(result.synced, [_uuidA]);
      expect(result.errored, isEmpty);

      final a = await db.getRecord(_uuidA);
      expect(a!.status, RecordStatus.synced);
      expect(a.serverId, 55);
      expect(a.serverState, 'rejected');
      expect(a.error, isNull);
    });
  });

  group('SyncQueue.replay per-record errors', () {
    test('one failing record is marked error without stopping the others', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));
      await db.insertRecord(_queuedRecord(_uuidB));
      await db.insertRecord(_queuedRecord(_uuidC));

      final api = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, submissionId: 1, state: 'pending_lead'),
        _uuidB: SyncResult(
          clientUuid: _uuidB,
          error: SyncRecordError('INVALID', 'client_uuid must be a UUID.'),
        ),
        _uuidC: SyncResult(clientUuid: _uuidC, submissionId: 3, state: 'pending_lead'),
      });

      final result = await SyncQueue(db).replay(api);

      expect(result.synced.toSet(), {_uuidA, _uuidC});
      expect(result.errored, [_uuidB]);

      final b = await db.getRecord(_uuidB);
      expect(b!.status, RecordStatus.error);
      expect(b.error, 'INVALID: client_uuid must be a UUID.');

      expect((await db.getRecord(_uuidA))!.status, RecordStatus.synced);
      expect((await db.getRecord(_uuidC))!.status, RecordStatus.synced);
    });
  });

  group('SyncQueue.replay ApiException', () {
    test('a whole-batch ApiException leaves every record queued', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));
      await db.insertRecord(_queuedRecord(_uuidB));

      final api = _AlwaysFailsApiClient();

      await expectLater(() => SyncQueue(db).replay(api), throwsA(isA<ApiException>()));

      expect((await db.getRecord(_uuidA))!.status, RecordStatus.queued);
      expect((await db.getRecord(_uuidB))!.status, RecordStatus.queued);
      expect(api.callCount, 1);
    });
  });

  group('SyncQueue.replay idempotency', () {
    test('an empty queue never calls the API at all', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _ScriptedApiClient({});

      final result = await SyncQueue(db).replay(api);

      expect(result.synced, isEmpty);
      expect(result.errored, isEmpty);
      expect(api.callCount, 0);
    });

    test('double replay sends nothing the second time', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));
      await db.insertRecord(_queuedRecord(_uuidB));

      final api = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, submissionId: 1, state: 'pending_lead'),
        _uuidB: SyncResult(clientUuid: _uuidB, submissionId: 2, state: 'pending_lead'),
      });

      final first = await SyncQueue(db).replay(api);
      expect(first.synced.toSet(), {_uuidA, _uuidB});
      expect(api.callCount, 1);
      expect(api.batchSizes, [2]);

      final second = await SyncQueue(db).replay(api);
      expect(second.synced, isEmpty);
      expect(second.errored, isEmpty);
      // The second replay found nothing queued, so it never called the API
      // again -- a synced record is never re-sent.
      expect(api.callCount, 1);
    });

    test('a synced record is never re-selected even if a new record is queued alongside it', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));

      final firstApi = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, submissionId: 1, state: 'pending_lead'),
      });
      await SyncQueue(db).replay(firstApi);

      await db.insertRecord(_queuedRecord(_uuidB));
      final secondApi = _ScriptedApiClient({
        _uuidB: SyncResult(clientUuid: _uuidB, submissionId: 2, state: 'pending_lead'),
      });
      await SyncQueue(db).replay(secondApi);

      expect(secondApi.batchSizes, [1]); // only uuidB, not uuidA again
      expect((await db.getRecord(_uuidA))!.serverId, 1);
    });
  });

  group('SyncQueue.replay interrupted mid-batch', () {
    test('a crash after the first record is written leaves it synced and the rest queued, '
        'and a follow-up replay only resends the still-queued ones', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));
      await db.insertRecord(_queuedRecord(_uuidB));
      await db.insertRecord(_queuedRecord(_uuidC));

      final crashingApi = _CrashMidBatchApiClient(db);
      await expectLater(() => SyncQueue(db).replay(crashingApi), throwsA(isA<ApiException>()));

      final a = await db.getRecord(_uuidA);
      expect(a!.status, RecordStatus.synced);
      expect(a.serverId, 900);

      expect((await db.getRecord(_uuidB))!.status, RecordStatus.queued);
      expect((await db.getRecord(_uuidC))!.status, RecordStatus.queued);

      // Follow-up replay: only the still-queued B and C go out, and A
      // (already synced) is left alone.
      final followUpApi = _ScriptedApiClient({
        _uuidB: SyncResult(clientUuid: _uuidB, submissionId: 901, state: 'pending_lead'),
        _uuidC: SyncResult(clientUuid: _uuidC, submissionId: 902, state: 'pending_lead'),
      });
      final result = await SyncQueue(db).replay(followUpApi);

      expect(result.synced.toSet(), {_uuidB, _uuidC});
      expect(followUpApi.batchSizes, [2]);
      expect((await db.getRecord(_uuidA))!.serverId, 900); // untouched, not resent
    });
  });
}
