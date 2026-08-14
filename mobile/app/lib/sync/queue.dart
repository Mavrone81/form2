import '../api/client.dart';
import '../db/local_db.dart';
import '../db/models.dart';

/// What one [SyncQueue.replay] call did, for a caller that wants to show
/// the technician a summary ("3 synced, 1 needs attention") without
/// re-querying [LocalDb] itself.
class SyncReplayResult {
  SyncReplayResult({required this.synced, required this.errored});

  /// Empty batch: nothing was queued, so `api.sync` was never called.
  const SyncReplayResult.empty()
      : synced = const [],
        errored = const [];

  final List<String> synced;
  final List<String> errored;
}

/// Pushes every `queued` [LocalRecord] to the server in one batch and
/// reconciles the per-record results back into [LocalDb].
///
/// **Failure semantics**, matching `ApiClient.sync`'s own contract:
///  - A [SyncResult] with an `error` -> that one record is marked `error`
///    locally (message stored), and every other record in the batch is
///    still processed normally. One bad record never blocks the rest.
///  - A [SyncResult] without an `error` -> that record is marked `synced`,
///    storing `submissionId` as `server_id` and `state` (which may be
///    `pending_lead`, `rejected`, `approved`, ... -- all mean "the server
///    now holds this record", per the Task 6 contract) even when `state`
///    describes a rejection. This is not a bug: a rejected record is not
///    re-sent by a later replay, since only `queued` rows are ever selected
///    here again.
///  - An [ApiException] from `api.sync` itself (the whole HTTP call failed
///    -- e.g. an expired token) is left to propagate out of [replay]
///    uncaught. Nothing has been written to the database at that point
///    (the write loop only starts once a response is in hand), so every
///    record in the batch is simply still `queued` and will be retried on
///    the next call. Callers that want a soft failure instead of a thrown
///    exception should wrap the call in their own try/catch; this class
///    does not swallow it, so "did the whole batch fail" is never
///    confused with "one record failed".
///
/// Per-record statuses are written to [LocalDb] one at a time, in the order
/// results are iterated, and each write completes (`await`) before the next
/// record is processed. So even an interruption *after* the HTTP response
/// has been received but partway through writing results back -- a process
/// kill between record 1 and record 2 of a 3-record batch, say -- leaves
/// exactly the records already written in their new terminal state and the
/// rest still `queued`; nothing is lost, and nothing already-synced is ever
/// resent, because [replay] only ever selects `queued` rows to begin with.
class SyncQueue {
  SyncQueue(this._db);

  final LocalDb _db;

  /// Matches the server's own `parse_error` truncation convention (see
  /// `server/`) so a pathological error message can't grow the local
  /// `records.error` column without bound.
  static const _maxStoredErrorLength = 500;

  /// [include], when given, narrows the batch to only the queued records it
  /// accepts -- e.g. the app shell's "records owned by the currently
  /// signed-in technician" filter (see `LocalDb.getQueuedRecordsOwnedBy`),
  /// so a stale queued record left behind by a PREVIOUS technician is never
  /// swept up and sent to the server under a different technician's device
  /// token. Omitted (the default), every queued record is sent, unchanged
  /// from this method's original behaviour.
  Future<SyncReplayResult> replay(ApiClient api, {bool Function(LocalRecord record)? include}) async {
    final allQueued = await _db.getQueuedRecords();
    final queued = include == null ? allQueued : allQueued.where(include).toList();
    if (queued.isEmpty) return const SyncReplayResult.empty();

    final syncRecords = queued.map((r) => r.toSyncRecord()).toList();

    // If this throws (ApiException, or anything else), no record below has
    // been written yet -- every one of `queued` is untouched and stays
    // `queued`. Deliberately not caught here; see class doc.
    final results = await api.sync(syncRecords);

    final synced = <String>[];
    final errored = <String>[];
    for (final result in results) {
      final error = result.error;
      if (error != null) {
        final message = '${error.code}: ${error.message}';
        final capped = message.length > _maxStoredErrorLength ? message.substring(0, _maxStoredErrorLength) : message;
        await _db.markError(result.clientUuid, capped);
        errored.add(result.clientUuid);
      } else {
        await _db.markSynced(result.clientUuid, serverId: result.submissionId, state: result.state);
        synced.add(result.clientUuid);
      }
    }
    return SyncReplayResult(synced: synced, errored: errored);
  }
}
