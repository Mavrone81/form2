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
///  - disappears entirely (renders nothing) once both counts are zero.
class SyncBanner extends StatefulWidget {
  const SyncBanner({
    super.key,
    required this.db,
    required this.api,
    required this.syncQueue,
    required this.connectivity,
    required this.username,
  });

  final LocalDb db;
  final ApiClient api;
  final SyncQueue syncQueue;
  final ConnectivitySource connectivity;
  final String username;

  @override
  State<SyncBanner> createState() => SyncBannerState();
}

class SyncBannerState extends State<SyncBanner> {
  int _queued = 0;
  int _errored = 0;
  bool _syncing = false;
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
    setState(() => _syncing = true);
    try {
      final allowed = (await widget.db.getQueuedRecordsOwnedBy(widget.username)).map((r) => r.clientUuid).toSet();
      await widget.syncQueue.replay(widget.api, include: (r) => allowed.contains(r.clientUuid));
    } catch (_) {
      // A whole-batch failure (offline mid-flight, expired token, ...)
      // leaves every record still queued -- see SyncQueue.replay's own doc.
      // Nothing to surface here beyond the counts staying put below; the
      // next tap, or the next connectivity-regained event, tries again.
    }
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
                child: Text(
                  label,
                  style: const TextStyle(color: AppColors.tintInk, fontSize: 12.5, fontWeight: FontWeight.w600),
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
