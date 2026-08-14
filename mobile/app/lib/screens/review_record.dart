import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../domain/bundle.dart';
import '../services/connectivity_source.dart';
import '../widgets/app_colors.dart';
import '../widgets/calibration_table.dart';
import '../widgets/field_input.dart';
import '../widgets/parts_table.dart';
import '../widgets/signature_pad.dart';

/// The exact wording the brief requires next to every disabled submitting
/// control on this screen. A shared constant so the caption can never drift
/// between the widget that shows it and a test that asserts on it.
const offlineSubmitCaption = 'Connection required to submit';

// Restated from record_editor.dart/parts_table.dart/calibration_table.dart's
// own field-key conventions -- this screen has no shared module with them to
// import the regex from, the same reason those two files restate it from the
// web app's field-panel.js.
final _partsFieldPattern = RegExp(r'^part_\d+_(no|desc|qty|remarks)$');
final _calFieldPattern = RegExp(r'^cal_\d+_(reading|result)$');

/// The team-leader/engineer record view: `GET /submissions/:id`'s snapshot
/// rendered read-only, grouped by section, using the same idioms
/// record_editor's locked mode uses -- PartsTable and CalibrationTable
/// already take a `locked` flag and render their own sections directly;
/// every other field goes through FieldValueInput(locked: true), never a
/// disabled input (see FieldValueInput's own doc comment on why). Below the
/// record sits this reviewer's own action: a mandatory-reason rejection
/// composer and a signature pad.
///
/// Unlike record_editor, there is no [FormBundle]/interval data here to
/// drive a TaskList -- the server's submission snapshot is a flat field list
/// (see `fieldsFromDefinition` in server/scanner.js), not the task table's
/// per-frequency metadata. A task's own instruction is already that field's
/// `label` on the snapshot, so it reads perfectly well as an ordinary field.
///
/// THE RULE THIS SCREEN EXISTS FOR: [_signIt] and [_rejectIt] are wired to
/// their buttons' `onPressed` only while [_online] -- offline, both buttons'
/// `onPressed` is `null` (a properly disabled Material control, not merely
/// "does nothing when tapped"), and [offlineSubmitCaption] is shown once,
/// above both. [_online] starts from [ConnectivitySource.isOnline] and tracks
/// [ConnectivitySource.onChange] for the rest of this screen's life, so a
/// connection lost mid-review disables both controls immediately, without
/// waiting for a fetch to fail first.
class ReviewRecordScreen extends StatefulWidget {
  const ReviewRecordScreen({
    super.key,
    required this.api,
    required this.connectivity,
    required this.submissionId,
  });

  final ApiClient api;
  final ConnectivitySource connectivity;
  final int submissionId;

  @override
  State<ReviewRecordScreen> createState() => ReviewRecordScreenState();
}

class ReviewRecordScreenState extends State<ReviewRecordScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _loadError;
  bool _online = true;
  bool _busy = false;
  StreamSubscription<bool>? _sub;

  final SignaturePadController _sigController = SignaturePadController();
  final TextEditingController _reasonController = TextEditingController();
  String? _reasonError;

  @override
  void initState() {
    super.initState();
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
    _sigController.dispose();
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final data = await widget.api.submission(widget.submissionId);
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loadError = e.message;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loadError = 'Could not load this record.';
        _loading = false;
      });
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _signIt() async {
    if (!_online || _busy) return;
    if (_sigController.isEmpty) {
      _showError('Draw a signature before signing.');
      return;
    }
    setState(() => _busy = true);
    try {
      final bytes = await _sigController.exportPng();
      await widget.api.sign(widget.submissionId, encodePngDataUri(bytes));
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      // The server's own message -- e.g. a 403 stage race ("someone else
      // already signed this record") or a 400 validation failure -- surfaces
      // verbatim, never a raw exception dump. The screen stays put: nothing
      // here has succeeded, so there is nothing to navigate away from.
      if (!mounted) return;
      setState(() => _busy = false);
      _showError(e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      _showError('Could not sign this record. Try again.');
    }
  }

  Future<void> _rejectIt() async {
    if (!_online || _busy) return;
    final reason = _reasonController.text.trim();
    if (reason.isEmpty) {
      // Mirrors rejectSubmission's own check (server/workflow.js)
      // client-side, so a reviewer learns this immediately instead of
      // round-tripping to the server -- which remains the one that actually
      // enforces it; this check is purely a faster no.
      setState(() => _reasonError = 'A reason is required to reject this record.');
      return;
    }
    setState(() {
      _reasonError = null;
      _busy = true;
    });
    try {
      await widget.api.reject(widget.submissionId, reason);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _showError(e.message);
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      _showError('Could not reject this record. Try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_loadError != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Record')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_loadError!, style: const TextStyle(color: AppColors.ink)),
        ),
      );
    }

    final data = _data!;
    final submission = Map<String, dynamic>.from(data['submission'] as Map);
    final fields = ((data['snapshot'] as List?) ?? [])
        .map((e) => BundleField.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
    final valueRows = ((data['values'] as List?) ?? []).map((e) => Map<String, dynamic>.from(e as Map));
    final values = <String, dynamic>{for (final row in valueRows) row['field_key'].toString(): row['value']};
    final signatures =
        ((data['signatures'] as List?) ?? []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final rejections =
        ((data['rejections'] as List?) ?? []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

    // Grouped in the order fields already carry (a stable sort over "no
    // explicit order" preserves it), skipping signature-kind fields entirely
    // -- their value lives in [signatures], not [values], and has its own
    // section below.
    final bySection = <String, List<BundleField>>{};
    for (final f in fields) {
      if (f.isSignature) continue;
      bySection.putIfAbsent(f.section, () => []).add(f);
    }

    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: Text('${submission['doc_number'] ?? ''} · rev ${submission['revision'] ?? ''}'),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _Section(
              title: 'Record',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _kv('Machine ID', (submission['machine_id'] ?? '').toString()),
                  _kv('Interval', (submission['frequency'] ?? '').toString()),
                  _kv('Status', (submission['state'] ?? '').toString()),
                ],
              ),
            ),
            for (final entry in bySection.entries) _buildSection(entry.key, entry.value, values),
            if (signatures.isNotEmpty) _buildSignaturesSection(signatures),
            if (rejections.isNotEmpty) _buildRejectionsSection(rejections),
            _buildComposer(),
          ],
        ),
      ),
    );
  }

  Widget _kv(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(width: 90, child: Text(label, style: const TextStyle(color: AppColors.mute, fontSize: 11.5))),
            Expanded(
              child: Text(
                value.isEmpty ? '—' : value,
                style: const TextStyle(color: AppColors.ink, fontSize: 13),
              ),
            ),
          ],
        ),
      );

  Widget _buildSection(String title, List<BundleField> fields, Map<String, dynamic> values) {
    final partFields = fields.where((f) => _partsFieldPattern.hasMatch(f.fieldKey)).toList();
    final calFields = fields.where((f) => _calFieldPattern.hasMatch(f.fieldKey)).toList();
    final plainFields = fields
        .where((f) => !_partsFieldPattern.hasMatch(f.fieldKey) && !_calFieldPattern.hasMatch(f.fieldKey))
        .toList();

    return _Section(
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (partFields.isNotEmpty)
            PartsTable(fields: partFields, values: values, locked: true, onChanged: (_, _) {}),
          if (calFields.isNotEmpty)
            CalibrationTable(fields: calFields, values: values, locked: true, onChanged: (_, _) {}),
          for (final f in plainFields) _plainField(f, values),
        ],
      ),
    );
  }

  Widget _plainField(BundleField f, Map<String, dynamic> values) {
    final value = (values[f.fieldKey] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(f.label, style: const TextStyle(color: AppColors.mute, fontSize: 11.5)),
          const SizedBox(height: 4),
          FieldValueInput(value: value, options: const [], locked: true, onChanged: (_) {}),
        ],
      ),
    );
  }

  Widget _buildSignaturesSection(List<Map<String, dynamic>> signatures) {
    return _Section(
      title: 'Signed so far',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final s in signatures)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${s['full_name'] ?? ''} · ${s['stage'] ?? ''}',
                    style: const TextStyle(color: AppColors.ink, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  Text((s['signed_at'] ?? '').toString(), style: const TextStyle(color: AppColors.mute, fontSize: 11.5)),
                  if ((s['image_png'] as String?)?.trim().isNotEmpty ?? false) ...[
                    const SizedBox(height: 4),
                    Image.memory(decodePngDataUri(s['image_png'] as String), height: 80, fit: BoxFit.contain),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildRejectionsSection(List<Map<String, dynamic>> rejections) {
    return _Section(
      title: 'Rejection history',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final r in rejections)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${r['full_name'] ?? ''} · ${r['stage'] ?? ''}',
                    style: const TextStyle(color: AppColors.ink, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  Text((r['reason'] ?? '').toString(), style: const TextStyle(color: AppColors.ink, fontSize: 12.5)),
                  Text((r['rejected_at'] ?? '').toString(), style: const TextStyle(color: AppColors.mute, fontSize: 11.5)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildComposer() {
    return _Section(
      title: 'Your review',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!_online) ...[
            const Text(
              offlineSubmitCaption,
              style: TextStyle(color: AppColors.stamp, fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
          ],
          const Text('Rejection reason', style: TextStyle(color: AppColors.mute, fontSize: 11.5)),
          const SizedBox(height: 4),
          TextField(
            controller: _reasonController,
            maxLines: 3,
            style: const TextStyle(color: AppColors.ink, fontSize: 13),
            decoration: const InputDecoration(
              isDense: true,
              hintText: 'Reason for sending this record back',
              border: OutlineInputBorder(borderSide: BorderSide(color: AppColors.rule)),
              enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.rule)),
            ),
          ),
          if (_reasonError != null) ...[
            const SizedBox(height: 4),
            Text(_reasonError!, style: const TextStyle(color: AppColors.stamp, fontSize: 12)),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: OutlinedButton(
              onPressed: (_online && !_busy) ? _rejectIt : null,
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.stamp,
                side: const BorderSide(color: AppColors.stamp),
              ),
              child: const Text('Reject'),
            ),
          ),
          const SizedBox(height: 20),
          const Text('Your signature', style: TextStyle(color: AppColors.mute, fontSize: 11.5)),
          const SizedBox(height: 4),
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
                onPressed: (_online && !_busy) ? _signIt : null,
                child: const Text('Sign'),
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
