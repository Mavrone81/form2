import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../db/local_db.dart';
import '../db/models.dart';
import '../services/connectivity_source.dart';
import '../sync/queue.dart';
import 'app_colors.dart';

/// A persistent "N records waiting to sync" strip, shown above the
/// technician's records list whenever this device is holding anything not
/// yet safely on the server:
///  - counts only [username]'s OWN queued/error records (see
///    `LocalDb.getRecordsByStatusOwnedBy`) -- a record left behind by a
///    previously signed-in technician on a shared device is never counted,
///    offered for sync, or replayed here, so it can never be attributed to
///    the WRONG technician's device token;
///  - a tap replays the queue immediately (only when online -- there is
///    nothing useful a tap can do offline, so it is simply disabled then);
///  - a connectivity transition from offline to online auto-replays exactly
///    once per transition (never on every subsequent `onChange` emission
///    while already online, and never merely because [isOnline] happened to
///    already be true when this widget was first built);
///  - a whole-batch failure keeps the counts and says WHY inline (see
///    [_failure]), cleared by the next replay that gets through;
///  - disappears entirely (renders nothing) once both counts are zero.
class SyncBanner extends StatefulWidget {
  const SyncBanner({
    super.key,
    required this.db,
    required this.api,
    required this.syncQueue,
    required this.connectivity,
    required this.username,
    this.onAuthExpired,
  });

  final LocalDb db;
  final ApiClient api;
  final SyncQueue syncQueue;
  final ConnectivitySource connectivity;
  final String username;

  /// Invoked when a replay is refused with 401 -- the same seam
  /// [ReviewQueueScreen] uses, so a dead credential leads to the login
  /// screen from wherever it is first noticed. `null` (a standalone test)
  /// still shows the failure inline; nothing is silently swallowed either
  /// way.
  final VoidCallback? onAuthExpired;

  @override
  State<SyncBanner> createState() => SyncBannerState();
}

class SyncBannerState extends State<SyncBanner> {
  int _queued = 0;
  int _errored = 0;
  bool _syncing = false;

  /// Why the last whole-batch replay failed, if it did -- shown as a second
  /// line under the count. A batch failure leaves every record queued (see
  /// [SyncQueue.replay]), so before this the banner just sat there reading
  /// "3 records waiting to sync" after every failed tap, with the reason
  /// (the server's own message, a timeout, an expired session) discarded and
  /// no way for the technician to tell a transient blip from something that
  /// needs them to act. Cleared by the next replay that gets through.
  String? _failure;
  late bool _online;
  StreamSubscription<bool>? _sub;

  @override
  void initState() {
    super.initState();
    _online = widget.connectivity.isOnline;
    unawaited(refreshCounts());
    _sub = widget.connectivity.onChange.listen((online) {
      final justCameOnline = !_online && online;
      if (mounted) setState(() => _online = online);
      if (justCameOnline) unawaited(_replay());
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  /// Re-reads the queued/error counts from [LocalDb]. Public so a screen
  /// that just queued a new record (or requeued a failed one) can ask this
  /// banner to catch up without waiting on a connectivity event.
  Future<void> refreshCounts() async {
    final queued = await widget.db.getRecordsByStatusOwnedBy(RecordStatus.queued, widget.username);
    final errored = await widget.db.getRecordsByStatusOwnedBy(RecordStatus.error, widget.username);
    if (!mounted) return;
    setState(() {
      _queued = queued.length;
      _errored = errored.length;
    });
  }

  /// Manual "tap to sync now" entry point, also used for auto-replay.
  Future<void> syncNow() => _replay();

  Future<void> _replay() async {
    if (_syncing) return;
    if (!mounted) return;
    setState(() => _syncing = true);
    var authExpired = false;
    try {
      final allowed = (await widget.db.getQueuedRecordsOwnedBy(widget.username)).map((r) => r.clientUuid).toSet();
      await widget.syncQueue.replay(widget.api, include: (r) => allowed.contains(r.clientUuid));
      _failure = null;
    } on ApiException catch (e) {
      // A whole-batch failure (offline mid-flight, an expired credential, a
      // server error) leaves every record still queued -- see
      // SyncQueue.replay's own doc. The counts below are therefore correct
      // as they stand; what was missing was the reason, which is the only
      // part the technician can act on.
      //
      // ApiClient turns a timeout into ApiException(0, "The request timed
      // out...") and any non-2xx into its own status plus the server's
      // verbatim message, so one branch covers both with copy already
      // written for a person to read.
      if (e.statusCode == 401) {
        authExpired = true;
        _failure = 'Sync failed: $sessionExpiredMessage';
      } else {
        _failure = 'Sync failed: ${e.message}';
      }
    } catch (e) {
      // Anything that is not an ApiException at all (a local database
      // failure, a bug). Still surfaced rather than swallowed -- a
      // technician staring at a stuck count deserves to know something went
      // wrong even when the app cannot phrase it well.
      _failure = 'Sync failed: $e';
    }
    // Called after the state above is settled, and outside the catch, so the
    // shell's own transition (which rebuilds this widget's whole subtree)
    // cannot land mid-handler.
    if (authExpired) widget.onAuthExpired?.call();
    await refreshCounts();
    if (mounted) setState(() => _syncing = false);
  }

  @override
  Widget build(BuildContext context) {
    final total = _queued + _errored;
    if (total == 0) return const SizedBox.shrink();

    final label = _errored > 0 ? '$total records waiting to sync ($_errored failed)' : '$total records waiting to sync';

    return Material(
      color: AppColors.tint,
      child: InkWell(
        onTap: _online && !_syncing ? syncNow : null,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: AppColors.rule))),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(color: AppColors.tintInk, fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                    // The reason the last replay failed, under the count it
                    // did not change. In the stamp colour, because unlike
                    // the count itself this is something that went wrong.
                    if (_failure != null) ...[
                      const SizedBox(height: 3),
                      Text(
                        _failure!,
                        style: const TextStyle(color: AppColors.stamp, fontSize: 11.5, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ],
                ),
              ),
              if (_syncing)
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.tintInk),
                )
              else
                Text(
                  _online ? 'Sync now' : 'Offline',
                  style: const TextStyle(color: AppColors.tintInk, fontSize: 12, fontWeight: FontWeight.w700),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
