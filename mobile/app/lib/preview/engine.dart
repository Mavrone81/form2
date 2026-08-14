import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:webview_flutter/webview_flutter.dart';

import '../db/models.dart';

/// Base type for everything [PreviewEngine.render] can throw. Callers (the
/// preview screen) only ever need to show [message] and offer a retry --
/// distinguishing timeout from an engine-reported error is for logging /
/// tests, not for the technician-facing copy.
abstract class PreviewEngineException implements Exception {
  PreviewEngineException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// The round trip (asset load -> `ready` -> `render` -> reply) did not
/// finish inside [PreviewEngine.renderTimeout]. Covers every silent-hang
/// failure mode the harness itself cannot signal for, chiefly a missing
/// `dist/pdf-engine.js` asset: `harness.js` only sets a status string on the
/// page in that case, it never posts anything back (see harness.js's own
/// `loaded` check), so this timeout is the one thing standing between that
/// failure and a preview screen stuck loading forever.
class PreviewTimeoutException extends PreviewEngineException {
  PreviewTimeoutException(super.message);
}

/// The engine answered inside the time budget, but with `{type: 'error'}` --
/// `window.renderRecordPdf` itself rejected, or the harness's own 30s
/// internal render timeout fired first. [message] is the engine's own text,
/// verbatim, so a technician (or a bug report) sees exactly what it said.
class PreviewRenderException extends PreviewEngineException {
  PreviewRenderException(super.message);
}

/// Builds the exact object `server/pdf-record.js`'s `renderRecordPdf`
/// destructures -- see the function's own parameter list there:
/// `{ form, submission, snapshot, values, signatures, rejections, grid,
/// identity, notice, cellFor, titleCell, intervalCells, calibrationCells }`.
/// This is a **pure** function -- no I/O, no WebView -- specifically so the
/// fidelity test (`test/engine_input_test.dart`) can pin its shape without
/// touching a platform channel.
///
/// [bundleForm] is one form's bundle entry exactly as cached by
/// `LocalDb.upsertBundle`/`getBundle` and decoded with `jsonDecode` -- i.e.
/// the raw `{form, fields, frequencies, tasks, cellFor, titleCell,
/// intervalCells, calibrationCells, grid}` map the server's `GET /bundle`
/// route produces per form (see `server/routes.js`), NOT the app's typed
/// `FormBundle` (`lib/domain/bundle.dart`), which deliberately drops the
/// sheet-reproduction keys this preview needs.
///
/// [record] is the technician's own local, not-yet-synced record.
/// [userFullName] is the signed-in technician's display name -- `LocalRecord`
/// itself has nowhere to store one (see Task 8's report), so it travels in
/// from whoever is signed in on this device.
/// [nowIso] stands in for the server's `submission.created_at`: a draft
/// record has no creation timestamp of its own on this device (only
/// `signed_at`, stamped at sign time), so the preview renders "as of now".
///
/// The returned map always has exactly the same top-level key set the server
/// route assembles -- notably `rejections` is always `[]` (a record still on
/// this device has never been submitted, so it cannot have been rejected)
/// and `notice` is always `''` (the "source form changed since this record
/// was signed" notice needs a live re-read of the form file to detect,
/// which only the server can do -- an offline preview has nothing to compare
/// the cached bundle against, so it never claims staleness it cannot check).
Map<String, dynamic> buildEngineInput(
  Map<String, dynamic> bundleForm,
  LocalRecord record,
  String userFullName,
  String nowIso,
) {
  final form = bundleForm['form'] is Map
      ? Map<String, dynamic>.from(bundleForm['form'] as Map)
      : <String, dynamic>{};

  final snapshot = ((bundleForm['fields'] as List?) ?? [])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();

  final values = record.values.entries
      .map((e) => {'field_key': e.key, 'value': e.value})
      .toList();

  final signed = record.signaturePng.trim().isNotEmpty;
  final signatures = signed
      ? [
          {
            'stage': 'technician',
            'full_name': userFullName,
            'image_png': record.signaturePng,
            'signed_at': record.signedAt,
          },
        ]
      : <Map<String, dynamic>>[];

  final identity = {
    'title': (form['title'] ?? '').toString(),
    'doc_number': (form['doc_number'] ?? '').toString(),
    'revision': (form['revision'] ?? '').toString(),
  };

  final submission = {
    'id': record.clientUuid,
    'machine_id': record.machineId,
    'frequency': record.frequency,
    'created_at': nowIso,
    'state': 'draft',
  };

  return {
    'form': form,
    'submission': submission,
    'snapshot': snapshot,
    'values': values,
    'signatures': signatures,
    'rejections': const <Map<String, dynamic>>[],
    'grid': bundleForm['grid'],
    'cellFor': bundleForm['cellFor'],
    'titleCell': bundleForm['titleCell'],
    'intervalCells': bundleForm['intervalCells'],
    'calibrationCells': bundleForm['calibrationCells'],
    'identity': identity,
    'notice': '',
  };
}

/// The transport [PreviewEngine] hands a built input to and awaits a reply
/// from -- one call, one reply, no protocol details (message ids, `ready`
/// waits, JS-channel bridging) leaking into [PreviewEngine] itself. Real
/// implementation is [WebViewEngineTransport]; tests inject a fake that
/// either replies immediately, replies with `{type: 'error', ...}`, or never
/// completes at all (the timeout path) -- see `test/engine_input_test.dart`.
///
/// The reply is the harness's own decoded JSON message: `{type: 'rendered',
/// id, pdf, bytes}` or `{type: 'error', id, message}` (see
/// `mobile/pdf-engine/harness.html`'s protocol doc).
abstract class EngineTransport {
  Future<Map<String, dynamic>> render(Map<String, dynamic> input);
}

/// Bridges to the hidden WebView loading `assets/pdf-engine/harness.html`
/// (a Flutter asset -- see `pubspec.yaml`'s `flutter.assets` and this file's
/// own module doc for the asset layout `harness.html`'s own relative
/// `<script src="dist/pdf-engine.js">` requires).
///
/// **Deliberately not unit-tested.** `WebViewController` is a Flutter
/// platform channel -- there is no Dart-VM-only fake for it, and driving a
/// real one needs a real Android/iOS engine, which `flutter test` does not
/// provide. [EngineTransport] exists specifically so every OTHER behaviour
/// (input shape, timeout, error-reply handling) is tested against a plain
/// Dart fake instead, in `test/engine_input_test.dart`; this class itself is
/// exercised by the device pass (Task 12's manual step), not by `flutter
/// test`.
class WebViewEngineTransport implements EngineTransport {
  WebViewEngineTransport({this.assetPath = 'assets/pdf-engine/harness.html'});

  /// The Flutter-asset path to the harness page, relative to the asset
  /// bundle root -- matches whatever `pubspec.yaml` declares under
  /// `flutter.assets`.
  final String assetPath;

  WebViewController? _controller;
  Completer<void>? _ready;
  Object? _loadError;
  int _nextId = 0;
  final Map<String, Completer<Map<String, dynamic>>> _pending = {};

  Future<void> _ensureLoaded() async {
    if (_controller != null) return;
    final ready = Completer<void>();
    _ready = ready;
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('PdfEngine', onMessageReceived: _onMessage)
      ..setNavigationDelegate(
        NavigationDelegate(
          // A page-load failure (e.g. `harness.html` itself missing from the
          // asset bundle, which happens if the build/CI copy step that
          // stages `mobile/pdf-engine`'s harness + `dist/pdf-engine.js` into
          // `assets/pdf-engine/` was skipped) is recorded here rather than
          // left to surface only as a `ready`-wait timeout 35 seconds later.
          onWebResourceError: (error) {
            _loadError ??= error;
            if (!ready.isCompleted) {
              ready.completeError(
                StateError(
                  'Could not load the PDF preview engine (${error.description}). '
                  'The app bundle may be missing assets/pdf-engine — rebuild the app.',
                ),
              );
            }
          },
        ),
      );
    _controller = controller;
    await controller.loadFlutterAsset(assetPath);
  }

  void _onMessage(JavaScriptMessage message) {
    final decoded = jsonDecode(message.message);
    if (decoded is! Map) return;
    final data = Map<String, dynamic>.from(decoded);
    if (data['type'] == 'ready') {
      final ready = _ready;
      if (ready != null && !ready.isCompleted) ready.complete();
      return;
    }
    final id = data['id']?.toString();
    final completer = id == null ? null : _pending.remove(id);
    completer?.complete(data);
  }

  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async {
    await _ensureLoaded();
    await _ready!.future;
    final id = (_nextId++).toString();
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    // JSON is a syntactic subset of a JS object literal, so the encoded
    // payload can be spliced straight into `postMessage(...)`'s argument
    // position -- harness.js accepts a live object exactly like it accepts
    // a JSON string (`event.data` is only re-parsed when it IS a string; see
    // harness.js), and this avoids a second, pointless encode/decode of a
    // whole record -- including signature ink -- through a string argument.
    final payload = jsonEncode({'type': 'render', 'id': id, 'record': input});
    await _controller!.runJavaScript(
      'window.postMessage($payload, window.location.origin || "*");',
    );
    return completer.future;
  }
}

/// Renders a technician's own local record to PDF bytes entirely on-device,
/// for the offline preview screen (`lib/screens/preview.dart`). The heavy
/// lifting -- building the exact input the server's own renderer expects,
/// and turning its base64 reply back into bytes -- lives here so
/// `preview.dart` only ever has three states to show: loading, error (with
/// retry), or a rendered PDF.
class PreviewEngine {
  PreviewEngine({
    EngineTransport? transport,
    this.renderTimeout = const Duration(seconds: 35),
  }) : _transport = transport ?? WebViewEngineTransport();

  final EngineTransport _transport;

  /// Guards the WHOLE round trip -- asset load, `ready`, render, reply --
  /// not just the harness's own internal 30s render timeout, which never
  /// fires at all if the page never finishes loading in the first place
  /// (see [WebViewEngineTransport]'s doc comment).
  final Duration renderTimeout;

  Future<Uint8List> render({
    required Map<String, dynamic> bundleForm,
    required LocalRecord record,
    required String userFullName,
    DateTime? now,
  }) async {
    final input = buildEngineInput(
      bundleForm,
      record,
      userFullName,
      (now ?? DateTime.now()).toUtc().toIso8601String(),
    );

    final Map<String, dynamic> reply;
    try {
      reply = await _transport.render(input).timeout(renderTimeout);
    } on TimeoutException {
      throw PreviewTimeoutException(
        'The preview did not finish rendering within ${renderTimeout.inSeconds} seconds.',
      );
    } on PreviewEngineException {
      rethrow;
    } catch (e) {
      // A transport-level failure that isn't itself a typed
      // PreviewEngineException -- e.g. WebViewEngineTransport's asset-load
      // error. Wrapped rather than left to escape as a raw platform
      // exception, so the preview screen's single catch clause covers every
      // failure mode with the same "message + retry" treatment.
      throw PreviewRenderException(e.toString());
    }

    if (reply['type'] == 'error') {
      throw PreviewRenderException(
        (reply['message'] ?? 'The preview engine reported an error.')
            .toString(),
      );
    }
    final pdf = reply['pdf'];
    if (reply['type'] != 'rendered' || pdf is! String) {
      throw PreviewRenderException(
        'The preview engine returned an unexpected reply.',
      );
    }
    return base64Decode(pdf);
  }
}
