import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../db/local_db.dart';
import '../db/models.dart';
import '../domain/bundle.dart';
import '../widgets/app_colors.dart';
import '../widgets/calibration_table.dart';
import '../widgets/field_input.dart';
import '../widgets/interval_picker.dart';
import '../widgets/parts_table.dart';
import '../widgets/signature_pad.dart';
import '../widgets/task_list.dart';

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
///    plain text, exactly matching a completed paper form under glass.
class RecordEditorScreen extends StatefulWidget {
  const RecordEditorScreen({super.key, required this.db, required this.clientUuid});

  final LocalDb db;
  final String clientUuid;

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
        _error = 'This form has not been downloaded to this device. Sync to continue.';
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

  Future<void> _persist(LocalRecord updated) async {
    await widget.db.updateRecord(updated);
    if (!mounted) return;
    setState(() => _record = updated);
  }

  void _onFrequencyChange(String freq) {
    if (_locked) return;
    unawaited(_persist(_copy(frequency: freq)));
  }

  void _onFieldChange(String key, String value) {
    if (_locked) return;
    if (key == 'machine_id') {
      unawaited(_persist(_copy(machineId: value)));
      return;
    }
    final values = Map<String, dynamic>.from(_record!.values);
    values[key] = value;
    unawaited(_persist(_copy(values: values)));
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
      signaturePng: base64Encode(bytes),
      signedAt: DateTime.now().toUtc().toIso8601String(),
      status: RecordStatus.queued,
    );
    await _persist(updated);
    if (!mounted) return;
    Navigator.of(context).maybePop();
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
              Image.memory(base64Decode(record.signaturePng), height: 100, fit: BoxFit.contain)
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
