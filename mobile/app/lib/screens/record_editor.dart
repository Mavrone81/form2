import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../db/local_db.dart';
import '../db/models.dart';
import '../domain/bundle.dart';
import '../preview/engine.dart';
import '../services/connectivity_source.dart';
import '../widgets/app_colors.dart';
import '../widgets/calibration_table.dart';
import '../widgets/field_input.dart';
import '../widgets/interval_picker.dart';
import '../widgets/parts_table.dart';
import '../widgets/signature_pad.dart';
import '../widgets/task_list.dart';
import 'preview.dart';

final _taskFieldPattern = RegExp(r'^task_\d+$');
final _partsFieldPattern = RegExp(r'^part_\d+_(no|desc|qty|remarks)$');
final _calFieldPattern = RegExp(r'^cal_\d+_(reading|result)$');

/// The technician fill-in screen for one record. Mirrors the web panel's
/// semantics exactly (see `web/js/field-panel.js`):
///  - only this form's own frequencies are offered;
///  - a task outside the currently-selected interval's cumulative scope is
///    shown dimmed, never hidden;
///  - a field with printed options renders a dropdown, free text otherwise;
///  - every value change is written to [LocalDb] immediately -- there is no
///    explicit save button, this is offline-first;
///  - "Sign & queue" stores the drawn signature as PNG bytes, stamps
///    `signed_at`, and moves the record `draft` -> `queued`;
///  - once the record is no longer `draft` (`queued`/`synced`/`error`), the
///    whole screen renders read-only: no editable input anywhere, values as
///    plain text, exactly matching a completed paper form under glass;
///  - a Preview action in the app bar renders the record as the actual
///    final document ([PdfPreviewScreen]) -- offered in EVERY state, because
///    "what will this look like on paper" is a question a technician has
///    while filling it in, not only once it is signed.
class RecordEditorScreen extends StatefulWidget {
  const RecordEditorScreen({
    super.key,
    required this.db,
    required this.clientUuid,
    required this.userFullName,
    this.api,
    this.connectivity,
    this.onAuthExpired,
    this.previewEngine,
  });

  final LocalDb db;
  final String clientUuid;

  /// The signed-in technician's display name, threaded from the app shell
  /// exactly as it is to every other screen that needs user context. Used
  /// only by the preview: a `LocalRecord` has nowhere to store one, so the
  /// name printed in the signature block has to travel in from whoever is
  /// signed in (see `buildEngineInput`'s own doc).
  final String userFullName;

  /// All three optional, and all three only ever reach [PdfPreviewScreen]:
  /// the first two for its one network feature (offering the server's
  /// archival copy of a record that has already SYNCED, when the local
  /// render fails and the device is online), the third so a 401 from that
  /// fetch routes to the login screen like every other 401 in the app.
  /// Omitted, the preview is purely on-device and makes no network call at
  /// all.
  final ApiClient? api;
  final ConnectivitySource? connectivity;
  final VoidCallback? onAuthExpired;

  /// Injectable renderer for the preview screen this one opens. `null` (the
  /// default, and what the whole app passes) lets [PdfPreviewScreen] build
  /// the real WebView-backed engine itself; a test passes a fake transport
  /// so tapping Preview never touches a platform channel.
  final PreviewEngine? previewEngine;

  @override
  State<RecordEditorScreen> createState() => RecordEditorScreenState();
}

class RecordEditorScreenState extends State<RecordEditorScreen> {
  LocalRecord? _record;
  FormBundle? _bundle;
  bool _loading = true;
  String? _error;
  final SignaturePadController _sigController = SignaturePadController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _sigController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final record = await widget.db.getRecord(widget.clientUuid);
    if (record == null) {
      setState(() {
        _error = 'This record no longer exists on this device.';
        _loading = false;
      });
      return;
    }
    final formId = record.formId is int ? record.formId as int : int.parse(record.formId.toString());
    final bundleRow = await widget.db.getBundle(formId);
    if (bundleRow == null) {
      setState(() {
        // Not "sync to continue": a form reaches this state chiefly by being
        // withdrawn or unmapped server-side, which the next bundle refresh
        // PRUNES rather than restores (see LocalDb.replaceBundle) -- syncing
        // will not bring it back, and saying it will sends a technician
        // refreshing for ever. The reassurance that is actually true is that
        // their record is not lost.
        _error = 'This form is no longer available on this device, so this record '
            'cannot be opened. The record itself is safe and still syncs normally.';
        _loading = false;
      });
      return;
    }
    final bundle = FormBundle.fromJson(jsonDecode(bundleRow['json'] as String) as Map<String, dynamic>);
    setState(() {
      _record = record;
      _bundle = bundle;
      _loading = false;
    });
  }

  bool get _locked => _record != null && _record!.status != RecordStatus.draft;

  LocalRecord _copy({
    String? frequency,
    String? machineId,
    Map<String, dynamic>? values,
    String? signaturePng,
    String? signedAt,
    RecordStatus? status,
  }) {
    final r = _record!;
    return LocalRecord(
      clientUuid: r.clientUuid,
      formId: r.formId,
      frequency: frequency ?? r.frequency,
      machineId: machineId ?? r.machineId,
      values: values ?? r.values,
      signaturePng: signaturePng ?? r.signaturePng,
      signedAt: signedAt ?? r.signedAt,
      status: status ?? r.status,
      serverId: r.serverId,
      serverState: r.serverState,
      error: r.error,
    );
  }

  /// Serializes every write this screen makes to [LocalDb] into one chain.
  /// Two rapid edits used to race: each built its snapshot from `_record`
  /// as it stood when the edit STARTED, and if edit A's write was still in
  /// flight when edit B's write finished first, B's `updateRecord` (a full
  /// row replace) would land, then A's stale write would land on top of it
  /// and silently drop B's change. Chaining every write onto [_writeQueue]
  /// fixes the completion-order half of that; [_applyAndEnqueue] mutating
  /// `_record` synchronously (see below) fixes the other half, by making
  /// each new snapshot always build on the previous edit's value even if
  /// that edit's own write hasn't reached the database yet.
  Future<void> _writeQueue = Future<void>.value();

  /// Applies [updated] to in-memory state immediately -- synchronously,
  /// before any `await` -- and enqueues the matching write. Returns the
  /// Future for THIS write specifically, so a caller that needs to know
  /// when its own change has landed (e.g. [_signAndQueue], which must not
  /// navigate away before the queued status is actually persisted) can
  /// await it, while a failure in one write never breaks the chain for a
  /// later, unrelated one (that's what the `catchError` on [_writeQueue]
  /// itself is for -- it only ever swallows the error for the QUEUE's
  /// purposes; the returned Future for this specific call still carries it).
  Future<void> _applyAndEnqueue(LocalRecord updated) {
    setState(() => _record = updated);
    final thisWrite = _writeQueue.then((_) => widget.db.updateRecord(updated));
    _writeQueue = thisWrite.catchError((_) {});
    return thisWrite;
  }

  void _onFrequencyChange(String freq) {
    if (_locked) return;
    unawaited(_applyAndEnqueue(_copy(frequency: freq)));
  }

  void _onFieldChange(String key, String value) {
    if (_locked) return;
    if (key == 'machine_id') {
      unawaited(_applyAndEnqueue(_copy(machineId: value)));
      return;
    }
    final values = Map<String, dynamic>.from(_record!.values);
    values[key] = value;
    unawaited(_applyAndEnqueue(_copy(values: values)));
  }

  Future<void> _signAndQueue() async {
    if (_sigController.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Draw a signature before signing.')),
      );
      return;
    }
    final bytes = await _sigController.exportPng();
    final updated = _copy(
      // The server's assertValidSignature requires the stored value to
      // start with this exact data-URI prefix before it will even check
      // the base64 payload's PNG magic number (server/workflow.js) -- the
      // same shape a browser's canvas.toDataURL() produces, which is what
      // the web app stores. A bare base64 string here would sync every
      // signed record straight to a per-record INVALID error.
      signaturePng: encodePngDataUri(bytes),
      signedAt: DateTime.now().toUtc().toIso8601String(),
      status: RecordStatus.queued,
    );
    await _applyAndEnqueue(updated);
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  /// Opens the on-device preview of THIS record as the final document.
  ///
  /// Awaits [_writeQueue] first. Every edit is written to [LocalDb] as it is
  /// made, but a write can still be in flight when the button is tapped --
  /// and [PdfPreviewScreen] reads the record back FROM the database rather
  /// than from this screen's memory. Draining the chain is what guarantees
  /// the document a technician is shown is the record as it stands now, not
  /// as it stood one keystroke ago. (The chain never rejects -- see
  /// [_applyAndEnqueue]'s `catchError` -- so this cannot throw here.)
  Future<void> _openPreview() async {
    await _writeQueue;
    if (!mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => PdfPreviewScreen(
          db: widget.db,
          clientUuid: widget.clientUuid,
          userFullName: widget.userFullName,
          api: widget.api,
          connectivity: widget.connectivity,
          onAuthExpired: widget.onAuthExpired,
          engine: widget.previewEngine,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Record')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, style: const TextStyle(color: AppColors.ink)),
        ),
      );
    }

    final bundle = _bundle!;
    final record = _record!;
    final values = record.values;

    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: Text(bundle.form.title),
        // Deliberately NOT gated on `_locked`: a draft is previewed to check
        // the work before signing, and a queued/synced record is previewed
        // to read back what was actually submitted. Both are the same
        // question -- "what does this look like as the document?" -- and the
        // renderer answers it identically either way.
        actions: [
          IconButton(
            icon: const Icon(Icons.picture_as_pdf_outlined),
            tooltip: 'Preview',
            onPressed: _openPreview,
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              '${bundle.form.docNumber} · rev ${bundle.form.revision}',
              style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
            ),
            if (_locked) _LockedBanner(status: record.status),
            const SizedBox(height: 16),
            _Section(
              title: 'Maintenance interval',
              child: IntervalPicker(
                frequencies: bundle.frequencies,
                selected: record.frequency,
                locked: _locked,
                onSelected: _onFrequencyChange,
              ),
            ),
            if (bundle.tasks.isNotEmpty)
              _Section(
                title: 'Tasks',
                child: TaskList(
                  tasks: bundle.tasks,
                  fields: bundle.fields,
                  selectedFrequency: record.frequency,
                  values: values,
                  locked: _locked,
                  onChanged: _onFieldChange,
                ),
              ),
            for (final entry in bundle.bySection.entries) _buildSection(entry.key, entry.value, values),
            _buildSignatureSection(record),
          ],
        ),
      ),
    );
  }

  Widget _buildSection(String title, List<BundleField> fields, Map<String, dynamic> values) {
    final partFields = fields.where((f) => _partsFieldPattern.hasMatch(f.fieldKey)).toList();
    final calFields = fields.where((f) => _calFieldPattern.hasMatch(f.fieldKey)).toList();
    final plainFields = fields
        .where((f) =>
            !_partsFieldPattern.hasMatch(f.fieldKey) &&
            !_calFieldPattern.hasMatch(f.fieldKey) &&
            !_taskFieldPattern.hasMatch(f.fieldKey) &&
            !f.isSignature)
        .toList();

    if (partFields.isEmpty && calFields.isEmpty && plainFields.isEmpty) {
      return const SizedBox.shrink();
    }

    return _Section(
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (partFields.isNotEmpty)
            PartsTable(fields: partFields, values: values, locked: _locked, onChanged: _onFieldChange),
          if (calFields.isNotEmpty)
            CalibrationTable(fields: calFields, values: values, locked: _locked, onChanged: _onFieldChange),
          for (final f in plainFields) _plainField(f, values),
        ],
      ),
    );
  }

  Widget _plainField(BundleField f, Map<String, dynamic> values) {
    final value = f.fieldKey == 'machine_id' ? _record!.machineId : (values[f.fieldKey] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(f.label, style: const TextStyle(color: AppColors.mute, fontSize: 11.5)),
          const SizedBox(height: 4),
          FieldValueInput(
            value: value,
            options: f.optionsList,
            locked: _locked,
            onChanged: (v) => _onFieldChange(f.fieldKey, v),
          ),
        ],
      ),
    );
  }

  Widget _buildSignatureSection(LocalRecord record) {
    BundleField? signatureField;
    for (final f in _bundle!.fields) {
      if (f.isSignature) {
        signatureField = f;
        break;
      }
    }
    if (signatureField == null) return const SizedBox.shrink();

    if (_locked) {
      final hasImage = record.signaturePng.trim().isNotEmpty;
      return _Section(
        title: signatureField.label,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (hasImage)
              Image.memory(decodePngDataUri(record.signaturePng), height: 100, fit: BoxFit.contain)
            else
              const Text('Not yet signed', style: TextStyle(color: AppColors.mute, fontSize: 12.5)),
            if (record.signedAt.trim().isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(record.signedAt, style: const TextStyle(color: AppColors.mute, fontSize: 11.5)),
            ],
          ],
        ),
      );
    }

    return _Section(
      title: signatureField.label,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SignaturePad(controller: _sigController, locked: false),
          const SizedBox(height: 8),
          Row(
            children: [
              TextButton(
                onPressed: () => _sigController.clear(),
                child: const Text('Clear', style: TextStyle(color: AppColors.stamp)),
              ),
              const Spacer(),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: AppColors.ink, foregroundColor: AppColors.paper),
                onPressed: _signAndQueue,
                child: const Text('Sign & queue'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: AppColors.paper, border: Border.all(color: AppColors.rule)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            title.toUpperCase(),
            style: const TextStyle(
              color: AppColors.mute,
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _LockedBanner extends StatelessWidget {
  const _LockedBanner({required this.status});

  final RecordStatus status;

  String get _reason {
    switch (status) {
      case RecordStatus.queued:
        return 'Signed and queued for sync. Read-only until it syncs.';
      case RecordStatus.synced:
        return 'Synced. This record can no longer be edited on this device.';
      case RecordStatus.error:
        return 'Sync failed. This record is read-only; retry sync to send it again.';
      case RecordStatus.draft:
        return '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(_reason, style: const TextStyle(color: AppColors.stamp, fontSize: 12)),
    );
  }
}
