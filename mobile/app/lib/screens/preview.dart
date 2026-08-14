import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../api/client.dart';
import '../db/local_db.dart';
import '../db/models.dart';
import '../preview/engine.dart';
import '../services/connectivity_source.dart';
import '../widgets/app_colors.dart';

/// Full-screen PDF preview of one technician's own local record.
///
/// The on-device engine is the renderer, and for an UNSYNCED record it is
/// the ONLY possible renderer -- that record exists nowhere but this phone,
/// so there is no server copy to fall back to and no amount of connectivity
/// would produce one. When it fails, this screen says so plainly; the
/// record's own data is untouched and still queued to sync.
///
/// Once a record HAS synced, the server holds it too, and its archival PDF
/// (`GET /api/submissions/:id/pdf`, which a technician may now read for
/// their own record in any state) is a genuine second source. That is what
/// the "View server copy" action in the error state offers -- shown only
/// when it could actually work: a synced record, with a server id, on a
/// device that is online right now.
///
/// Three states, nothing else: loading, error (the engine's own message,
/// verbatim, with a retry and possibly the server-copy action), or the
/// rendered PDF via `printing`'s [PdfPreview] (which gets pinch-zoom for
/// free on a tablet).
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
    this.api,
    this.connectivity,
    PreviewEngine? engine,
  }) : engine = engine ?? PreviewEngine();

  final LocalDb db;
  final String clientUuid;

  /// Optional, and only ever used for the server-copy fallback described
  /// above. Omitted (as in a pure offline-preview test), the action is
  /// simply never offered and this screen makes no network call at all.
  final ApiClient? api;

  /// Optional, and read for the same one decision: there is no point
  /// offering to fetch the server's copy on a device that cannot reach it.
  final ConnectivitySource? connectivity;

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

  /// The record being previewed, kept so the error state can tell whether a
  /// server copy of it could even exist (see [_canFetchServerCopy]).
  LocalRecord? _record;

  late bool _online;
  StreamSubscription<bool>? _sub;

  @override
  void initState() {
    super.initState();
    _online = widget.connectivity?.isOnline ?? false;
    // Subscribed rather than read once: a technician whose connection comes
    // back while they are looking at the error screen should see the
    // server-copy action appear, not have to leave and come back.
    _sub = widget.connectivity?.onChange.listen((online) {
      if (!mounted) return;
      setState(() => _online = online);
    });
    _load();
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  /// Whether "View server copy" can be offered right now. Every condition is
  /// load-bearing: without an [ApiClient] there is nothing to call; an
  /// unsynced record has no server copy in existence; a synced record with
  /// no `serverId` has nothing to address the request to; and offline the
  /// call could only fail.
  bool get _canFetchServerCopy =>
      widget.api != null &&
      _online &&
      _record?.status == RecordStatus.synced &&
      _record?.serverId != null;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final record = await widget.db.getRecord(widget.clientUuid);
      if (mounted) setState(() => _record = record);
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

  /// Fetches the SERVER's archival PDF for this record -- the same bytes the
  /// browser shows a reviewer, and the same document this device would have
  /// drawn, produced by the renderer the on-device engine is a build of.
  /// Only reachable via the error state's action, i.e. only after the local
  /// render has already failed.
  Future<void> _loadServerCopy() async {
    final api = widget.api;
    final serverId = _record?.serverId;
    if (api == null || serverId == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final bytes = await api.pdf(serverId);
      if (!mounted) return;
      setState(() {
        _bytes = bytes;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      // The server's own message, verbatim -- same treatment the engine's
      // errors get, and the retry/server-copy actions are still on offer.
      setState(() {
        _error = 'Could not fetch the server copy: ${e.message}';
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not fetch the server copy: $e';
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
              // Only for a record the server also holds, on a device that
              // can reach it -- see [_canFetchServerCopy]. An unsynced
              // record has no server copy to offer, and pretending
              // otherwise would be the false promise the design spec's
              // "falls back to the server-rendered PDF" line used to make.
              if (_canFetchServerCopy) ...[
                const SizedBox(height: 8),
                TextButton(
                  onPressed: _loadServerCopy,
                  child: const Text('View server copy'),
                ),
              ],
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
