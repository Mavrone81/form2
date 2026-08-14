import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../services/connectivity_source.dart';
import '../widgets/app_colors.dart';
import 'review_record.dart';

/// The team-leader/engineer landing screen: their own live review queue,
/// scoped server-side to the caller's role/stage (`queueFor` in
/// server/workflow.js already returns only records awaiting THIS user's own
/// review). There is no local cache the way the technician's forms list has
/// one -- reviewing offline is never useful, [ReviewRecordScreen] disables
/// every submitting control the moment the device is offline -- so this
/// screen's only offline concession is to not lose what was already on
/// screen: a failed [refresh] leaves [_rows] exactly as it was and shows
/// [_StaleBanner] instead, rather than clearing the list or dumping the
/// failure. A device that has never once fetched successfully shows a plain
/// offline empty state.
class ReviewQueueScreen extends StatefulWidget {
  const ReviewQueueScreen({super.key, required this.api, required this.connectivity});

  final ApiClient api;
  final ConnectivitySource connectivity;

  @override
  State<ReviewQueueScreen> createState() => ReviewQueueScreenState();
}

class ReviewQueueScreenState extends State<ReviewQueueScreen> {
  List<dynamic>? _rows;
  bool _loading = true;
  bool _online = true;

  /// True once a [refresh] call has failed with [_rows] already populated
  /// from an earlier, successful one -- the signal for the "as of last
  /// connection" banner. Cleared the moment a refresh succeeds again.
  bool _stale = false;

  StreamSubscription<bool>? _sub;

  @override
  void initState() {
    super.initState();
    _online = widget.connectivity.isOnline;
    _sub = widget.connectivity.onChange.listen((online) {
      if (!mounted) return;
      setState(() => _online = online);
    });
    unawaited(refresh());
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  Future<void> refresh() async {
    setState(() => _loading = true);
    try {
      final rows = await widget.api.queue();
      if (!mounted) return;
      setState(() {
        _rows = rows;
        _stale = false;
        _loading = false;
      });
    } catch (_) {
      // A failed fetch -- offline, or the server refusing -- leaves [_rows]
      // untouched: whatever was fetched last stays on screen, marked stale
      // by the banner below, instead of being cleared to make room for an
      // error dump.
      if (!mounted) return;
      setState(() {
        _stale = _rows != null;
        _loading = false;
      });
    }
  }

  Future<void> _open(int id) async {
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ReviewRecordScreen(api: widget.api, connectivity: widget.connectivity, submissionId: id),
      ),
    );
    // A sign or reject on the record screen pops back here -- refresh
    // unconditionally rather than only on a truthy pop result, so a
    // technician-side change picked up by a bare "back" tap is reflected
    // too; refresh() itself is a no-op-ish cheap GET either way.
    await refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: const Text('Review queue'),
        // A quiet reminder that this list (and any record opened from it)
        // may be stale, and that Sign/Reject inside a record will be
        // disabled -- not an error, just the same fact the composer's own
        // caption states more forcefully once a reviewer is actually
        // looking at a record.
        actions: [
          if (!_online)
            const Padding(
              padding: EdgeInsets.only(right: 16),
              child: Center(child: Text('Offline', style: TextStyle(color: AppColors.paper, fontSize: 12.5))),
            ),
        ],
      ),
      body: SafeArea(child: RefreshIndicator(onRefresh: refresh, child: _buildBody())),
    );
  }

  Widget _buildBody() {
    final rows = _rows;

    if (_loading && rows == null) {
      return const Center(child: CircularProgressIndicator());
    }

    if (rows == null) {
      // Never fetched successfully at all: nothing cached to fall back to,
      // so this is a plain offline empty state, not the raw fetch failure.
      return ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              children: [
                const Text(
                  "You're offline, and this queue has never loaded on this device.",
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.mute, fontSize: 13),
                ),
                const SizedBox(height: 12),
                TextButton(onPressed: refresh, child: const Text('Retry')),
              ],
            ),
          ),
        ],
      );
    }

    if (rows.isEmpty) {
      return ListView(
        children: [
          if (_stale) const _StaleBanner(),
          const Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Nothing is waiting on your review right now.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.mute, fontSize: 13),
            ),
          ),
        ],
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: rows.length + (_stale ? 1 : 0),
      separatorBuilder: (context, index) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        if (_stale) {
          if (i == 0) return const _StaleBanner();
          return _Row(row: Map<String, dynamic>.from(rows[i - 1] as Map), onTap: _open);
        }
        return _Row(row: Map<String, dynamic>.from(rows[i] as Map), onTap: _open);
      },
    );
  }
}

class _StaleBanner extends StatelessWidget {
  const _StaleBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: AppColors.tint, border: Border.all(color: AppColors.rule)),
      child: const Text(
        'Offline — showing this list as of last connection.',
        style: TextStyle(color: AppColors.stamp, fontSize: 12.5, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.row, required this.onTap});

  final Map<String, dynamic> row;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final id = row['id'] is int ? row['id'] as int : int.parse(row['id'].toString());
    final docNumber = (row['doc_number'] ?? '').toString();
    final revision = (row['revision'] ?? '').toString();
    final machineId = (row['machine_id'] ?? '').toString();
    final frequency = (row['frequency'] ?? '').toString();
    final state = (row['state'] ?? '').toString();

    return Material(
      color: AppColors.paper,
      child: InkWell(
        onTap: () => onTap(id),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(border: Border.all(color: AppColors.rule)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                docNumber.isEmpty ? 'Record #$id' : '$docNumber · rev $revision',
                style: const TextStyle(color: AppColors.ink, fontSize: 14, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              Text(
                [if (machineId.isNotEmpty) machineId, if (frequency.isNotEmpty) frequency, state].join(' · '),
                style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
