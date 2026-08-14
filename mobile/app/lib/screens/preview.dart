import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../db/local_db.dart';
import '../preview/engine.dart';
import '../widgets/app_colors.dart';

/// Full-screen, on-device PDF preview of one technician's own local record --
/// works with no connectivity by construction, since [PreviewEngine] never
/// makes a network call: the record, the form's cached bundle, and the
/// bundled renderer are all already on the device.
///
/// Three states, nothing else: loading, error (the engine's own message,
/// verbatim, with a retry), or the rendered PDF via `printing`'s
/// [PdfPreview] (which gets pinch-zoom for free on a tablet).
class PdfPreviewScreen extends StatefulWidget {
  /// [engine] defaults to a real [PreviewEngine] (a hidden WebView) when
  /// omitted. Constructing that default here does not itself touch the
  /// WebView platform channel -- `PreviewEngine`'s own default
  /// `WebViewEngineTransport` only creates a `WebViewController` lazily, on
  /// the first actual `render()` call -- so this stays safe to construct in
  /// a widget test that injects its own fake [engine] instead.
  PdfPreviewScreen({
    super.key,
    required this.db,
    required this.clientUuid,
    required this.userFullName,
    PreviewEngine? engine,
  }) : engine = engine ?? PreviewEngine();

  final LocalDb db;
  final String clientUuid;

  /// The signed-in technician's display name -- stamped into the preview's
  /// signature block when this record has been signed. See
  /// `buildEngineInput`'s doc comment for why this cannot come from the
  /// record itself.
  final String userFullName;

  /// Injectable for tests; defaults to a real [PreviewEngine] above.
  final PreviewEngine engine;

  @override
  State<PdfPreviewScreen> createState() => _PdfPreviewScreenState();
}

class _PdfPreviewScreenState extends State<PdfPreviewScreen> {
  bool _loading = true;
  String? _error;
  Uint8List? _bytes;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final record = await widget.db.getRecord(widget.clientUuid);
      if (record == null) {
        setState(() {
          _error = 'This record no longer exists on this device.';
          _loading = false;
        });
        return;
      }
      final formId = record.formId is int
          ? record.formId as int
          : int.parse(record.formId.toString());
      final bundleRow = await widget.db.getBundle(formId);
      if (bundleRow == null) {
        setState(() {
          _error = 'This form has not been downloaded to this device. Sync to continue.';
          _loading = false;
        });
        return;
      }
      final bundleForm = Map<String, dynamic>.from(
        jsonDecode(bundleRow['json'] as String) as Map,
      );
      final bytes = await widget.engine.render(
        bundleForm: bundleForm,
        record: record,
        userFullName: widget.userFullName,
      );
      if (!mounted) return;
      setState(() {
        _bytes = bytes;
        _loading = false;
      });
    } on PreviewEngineException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: const Text('Preview'),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    final error = _error;
    if (error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Could not build the preview',
                style: TextStyle(
                  color: AppColors.ink,
                  fontWeight: FontWeight.w600,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                error,
                style: const TextStyle(color: AppColors.mute),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.ink,
                  foregroundColor: AppColors.paper,
                ),
                onPressed: _load,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    final bytes = _bytes!;
    return PdfPreview(
      build: (_) async => bytes,
      canChangeOrientation: false,
      canChangePageFormat: false,
      canDebug: false,
      allowPrinting: true,
      allowSharing: true,
    );
  }
}
