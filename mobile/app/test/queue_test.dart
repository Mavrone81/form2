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

/// Simulates the "lost mark" case named in the brief: the server genuinely
/// held the record (it is not lost server-side), but *this device* never
/// found out -- the response never arrived (connection dropped, app killed
/// before the `Future` resolved, whatever). From the device's point of
/// view that is indistinguishable from "the whole batch failed": nothing
/// gets marked, the record stays `queued`, and it goes out again next
/// replay. This fake's first call throws; its second call answers as the
/// real server would on a retried `client_uuid` -- the *same* `submissionId`
/// for the *same* uuid, proving convergence rather than a duplicate. The
/// server side of that dedupe guarantee (same client_uuid -> same
/// submissionId, no duplicate row) is exercised in the server's own suite,
/// not here -- see `test/sync.test.js`, "replaying the same batch is
/// idempotent: same submissionId, still exactly one signature, no error".
class _LostMarkApiClient extends ApiClient {
  int callCount = 0;
  final List<List<String>> batches = [];

  @override
  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    callCount++;
    batches.add(records.map((r) => r.clientUuid).toList());
    if (callCount == 1) {
      throw ApiException(500, 'connection reset before response');
    }
    return records.map((r) => SyncResult(clientUuid: r.clientUuid, submissionId: 777, state: 'pending_lead')).toList();
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

    test('a stored error message is capped at 500 chars, matching the server\'s parse_error convention', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));

      final longMessage = 'x' * 600;
      final api = _ScriptedApiClient({
        _uuidA: SyncResult(clientUuid: _uuidA, error: SyncRecordError('ERROR', longMessage)),
      });

      await SyncQueue(db).replay(api);

      final a = await db.getRecord(_uuidA);
      expect(a!.status, RecordStatus.error);
      // "ERROR: " prefix (7 chars) + the 500-char cap.
      expect(a.error!.length, 500);
      expect(a.error, startsWith('ERROR: '));
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

  group('SyncQueue.replay lost mark (server held it, response never arrived)', () {
    test('the record stays queued after the lost response and converges to the server\'s id on retry', () async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_queuedRecord(_uuidA));

      final api = _LostMarkApiClient();

      // First attempt: the batch call itself throws, exactly like any other
      // whole-batch transport failure -- from this device's perspective
      // nothing was ever marked, so the record is untouched: still queued.
      await expectLater(() => SyncQueue(db).replay(api), throwsA(isA<ApiException>()));
      expect((await db.getRecord(_uuidA))!.status, RecordStatus.queued);
      expect(api.callCount, 1);

      // Second attempt: proves this isn't the "already synced, filtered out
      // by the queued-rows query" shape from the mid-batch-crash test above
      // -- the record genuinely gets resent (the fake's own recorded batch
      // contents prove it), and the server's dedupe-by-client_uuid contract
      // (tested server-side) hands back the *same* submissionId it would
      // have on the very first successful attempt.
      final result = await SyncQueue(db).replay(api);

      expect(api.callCount, 2);
      expect(api.batches[1], [_uuidA]); // resent, not skipped
      expect(result.synced, [_uuidA]);

      final a = await db.getRecord(_uuidA);
      expect(a!.status, RecordStatus.synced);
      expect(a.serverId, 777);
    });
  });
}
