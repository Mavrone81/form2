import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../db/local_db.dart';
import '../db/models.dart';
import '../services/bundle_refresh.dart';
import '../services/connectivity_source.dart';
import '../sync/queue.dart';
import '../widgets/app_colors.dart';
import '../widgets/sync_banner.dart';
import 'forms_list.dart';
import 'record_editor.dart';

/// The technician's landing screen: their own records (drafts through
/// synced/error) plus the way in to start a new one via [FormsListScreen].
/// Records left on this device by a DIFFERENT username (a shared-device
/// sign-in) are never listed or opened here -- only counted, in a small
/// notice -- see `LocalDb`'s `record_owners` doc for why.
class TechnicianHomeScreen extends StatefulWidget {
  const TechnicianHomeScreen({
    super.key,
    required this.api,
    required this.db,
    required this.connectivity,
    required this.syncQueue,
    required this.username,
    required this.userFullName,
    this.onSignOut,
    this.bundleNotice,
  });

  final ApiClient api;
  final LocalDb db;
  final ConnectivitySource connectivity;
  final SyncQueue syncQueue;
  final String username;
  final String userFullName;
  final VoidCallback? onSignOut;

  /// A one-shot notice from the login flow's own bundle refresh (e.g. "could
  /// not refresh forms: `server message here`") -- shown once, then cleared
  /// by the technician dismissing it; never re-fetched from here.
  final String? bundleNotice;

  @override
  State<TechnicianHomeScreen> createState() => TechnicianHomeScreenState();
}

class TechnicianHomeScreenState extends State<TechnicianHomeScreen> {
  final _bannerKey = GlobalKey<SyncBannerState>();

  List<LocalRecord> _mine = const [];
  Map<int, String> _formTitles = const {};
  int _foreignCount = 0;
  DateTime? _bundleFetchedAt;
  bool _loading = true;
  bool _refreshingBundle = false;
  late bool _online;
  StreamSubscription<bool>? _sub;
  String? _bundleNotice;

  @override
  void initState() {
    super.initState();
    _bundleNotice = widget.bundleNotice;
    _online = widget.connectivity.isOnline;
    _sub = widget.connectivity.onChange.listen((online) {
      if (!mounted) return;
      setState(() => _online = online);
    });
    unawaited(_load());
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  Future<void> _load() async {
    final all = await widget.db.getAllRecords();
    final mine = <LocalRecord>[];
    for (final r in all) {
      final owner = await widget.db.getRecordOwner(r.clientUuid);
      if (owner == null || owner == widget.username) mine.add(r);
    }
    final foreign = await widget.db.countRecordsOwnedByOthers(widget.username);

    final bundleRows = await widget.db.getAllBundles();
    final titles = <int, String>{};
    DateTime? latest;
    for (final row in bundleRows) {
      final formId = row['form_id'] as int;
      try {
        final decoded = jsonDecode(row['json'] as String) as Map;
        final formMeta = decoded['form'];
        if (formMeta is Map && formMeta['title'] != null) {
          titles[formId] = formMeta['title'].toString();
        }
      } catch (_) {
        // Unreadable cached JSON just means no title to show -- not fatal.
      }
      final fetchedAt = DateTime.tryParse((row['fetched_at'] ?? '').toString());
      if (fetchedAt != null && (latest == null || fetchedAt.isAfter(latest))) latest = fetchedAt;
    }

    if (!mounted) return;
    setState(() {
      _mine = mine;
      _formTitles = titles;
      _foreignCount = foreign;
      _bundleFetchedAt = latest;
      _loading = false;
    });
  }

  Future<void> _openForms() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => FormsListScreen(db: widget.db, username: widget.username)),
    );
    await _load();
    _bannerKey.currentState?.refreshCounts();
  }

  Future<void> _openRecord(LocalRecord record) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => RecordEditorScreen(db: widget.db, clientUuid: record.clientUuid)),
    );
    await _load();
    _bannerKey.currentState?.refreshCounts();
  }

  Future<void> _refreshBundle() async {
    if (!_online || _refreshingBundle) return;
    setState(() => _refreshingBundle = true);
    try {
      final result = await refreshBundle(widget.api, widget.db);
      _bundleNotice = result.skippedCount > 0 ? '${result.skippedCount} form(s) could not be refreshed.' : null;
    } catch (e) {
      _bundleNotice = 'Could not refresh forms: ${e is ApiException ? e.message : e.toString()}';
    }
    await _load();
    if (!mounted) return;
    setState(() => _refreshingBundle = false);
  }

  void _showError(LocalRecord record) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sync failed'),
        content: Text(record.error ?? 'Unknown error.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
          FilledButton(
            onPressed: () async {
              Navigator.of(context).pop();
              await widget.db.requeue(record.clientUuid);
              await _load();
              _bannerKey.currentState?.refreshCounts();
            },
            child: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  String _formatDate(DateTime dt) => '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: const Text('PM Records'),
        actions: [
          IconButton(
            icon: _refreshingBundle
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.paper),
                  )
                : const Icon(Icons.refresh),
            tooltip: 'Refresh forms',
            onPressed: _online && !_refreshingBundle ? _refreshBundle : null,
          ),
          if (widget.onSignOut != null)
            IconButton(icon: const Icon(Icons.logout), tooltip: 'Sign out', onPressed: widget.onSignOut),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openForms,
        icon: const Icon(Icons.add),
        label: const Text('New record'),
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
      ),
      body: SafeArea(
        child: Column(
          children: [
            SyncBanner(
              key: _bannerKey,
              db: widget.db,
              api: widget.api,
              syncQueue: widget.syncQueue,
              connectivity: widget.connectivity,
              username: widget.username,
            ),
            if (_bundleNotice != null)
              _Notice(text: _bundleNotice!, onDismiss: () => setState(() => _bundleNotice = null)),
            if (_foreignCount > 0)
              _Notice(
                text: '$_foreignCount record(s) on this device belong to another technician and are read-only '
                    'until they sign in.',
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _bundleFetchedAt == null ? 'Forms not yet downloaded' : 'Forms updated ${_formatDate(_bundleFetchedAt!)}',
                      style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(child: _buildList()),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_mine.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No records on this device yet. Tap "New record" to start one.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.mute, fontSize: 13),
          ),
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: _mine.length,
      separatorBuilder: (context, index) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final r = _mine[i];
        final formId = r.formId is int ? r.formId as int : int.tryParse(r.formId.toString());
        final title = _formTitles[formId] ?? 'Form #$formId';
        return Material(
          color: AppColors.paper,
          child: InkWell(
            onTap: () => _openRecord(r),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(border: Border.all(color: AppColors.rule)),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: const TextStyle(color: AppColors.ink, fontSize: 14, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 4),
                        Text(
                          [
                            if (r.machineId.isNotEmpty) r.machineId,
                            if (r.frequency.isNotEmpty) r.frequency,
                          ].join(' · '),
                          style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
                        ),
                      ],
                    ),
                  ),
                  _StatusChip(record: r, onTapError: () => _showError(r)),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, this.onDismiss});

  final String text;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: const BoxDecoration(color: AppColors.tint, border: Border(bottom: BorderSide(color: AppColors.rule))),
      child: Row(
        children: [
          Expanded(child: Text(text, style: const TextStyle(color: AppColors.stamp, fontSize: 12.5, fontWeight: FontWeight.w600))),
          if (onDismiss != null)
            IconButton(icon: const Icon(Icons.close, size: 16), color: AppColors.stamp, onPressed: onDismiss),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.record, required this.onTapError});

  final LocalRecord record;
  final VoidCallback onTapError;

  @override
  Widget build(BuildContext context) {
    final Color bg;
    final Color ink;
    final String label;
    switch (record.status) {
      case RecordStatus.draft:
        bg = AppColors.tint;
        ink = AppColors.tintInk;
        label = 'DRAFT';
      case RecordStatus.queued:
        bg = AppColors.soft;
        ink = AppColors.mute;
        label = 'QUEUED';
      case RecordStatus.synced:
        bg = AppColors.ok;
        ink = AppColors.paper;
        label = 'SYNCED';
      case RecordStatus.error:
        bg = AppColors.stamp;
        ink = AppColors.paper;
        label = 'ERROR';
    }
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg),
      child: Text(label, style: TextStyle(color: ink, fontSize: 10.5, fontWeight: FontWeight.w700)),
    );
    if (record.status != RecordStatus.error) return chip;
    return InkWell(onTap: onTapError, child: chip);
  }
}
