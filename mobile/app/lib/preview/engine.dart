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
/// `identity` has the same blind spot for the same reason: it reflects
/// whatever this device's cached bundle holds, not a live read of the form,
/// so a revision made server-side after this device's last `GET /bundle`
/// previews under the OLD title/doc number/revision until the device
/// re-syncs -- see the comment where `identity` is built, below.
Map<String, dynamic> buildEngineInput(
  Map<String, dynamic> bundleForm,
  LocalRecord record,
  String userFullName,
  String nowIso,
) {
  final form = bundleForm['form'] is Map
      ? Map<String, dynamic>.from(bundleForm['form'] as Map)
      : <String, dynamic>{};

  // The bundle's `fields` (server: `select * from form_fields`, 9 columns
  // including `id`/`form_id`/`source`) is a compatible SUPERSET of what a
  // real submission's `form_snapshot` stores (server: `select field_key,
  // label, section, kind, options, sort_order from form_fields`, 6 columns
  // -- see `createSubmission` in `server/workflow.js`). Passed straight
  // through rather than narrowed to those 6: `renderRecordPdf` only ever
  // reads `field_key`, `kind`, `label` and `section` off a snapshot entry
  // (`unmappedFields`/`planValues` in `server/pdf-record.js`), and the extra
  // columns here are simply ignored, the same way an unrecognised object key
  // always is in JS.
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

  // Same staleness caveat as `notice` below applies here too, for the same
  // root cause: this reads whatever `title`/`doc_number`/`revision` happen
  // to be on the CACHED bundle, not a live read of the form. If an admin
  // revises the document on the server after this device's last `GET
  // /bundle`, the offline preview keeps showing the old identity until the
  // device re-syncs its bundle -- there is nothing here to detect that,
  // the same way there is nothing here to detect the source file changing
  // underneath a signed record (the case `notice` exists for on the server).
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

/// Interprets the return value of the readiness probe
/// `WebViewEngineTransport` runs on `onPageFinished`
/// (`typeof window.renderRecordPdf === 'function'`) -- `true` means the
/// engine script loaded and defined the function; anything else means it
/// didn't. Extracted as its own pure function because
/// `runJavaScriptReturningResult`'s return shape is not uniform across
/// webview_flutter's platform implementations: some hand back a real Dart
/// `bool`, others a JSON-encoded string (`'true'`, or quoted as `'"true"'`).
/// That parsing ambiguity is exactly the kind of decision worth pinning with
/// a plain Dart-VM test (`test/engine_input_test.dart`) independent of the
/// WebView itself, which is the one part of this file that stays
/// device-tested only (see [WebViewEngineTransport]'s own doc comment).
bool readinessProbeIndicatesEngine(Object? probeResult) {
  if (probeResult is bool) return probeResult;
  final text = probeResult?.toString().trim().toLowerCase();
  return text == 'true' || text == '"true"';
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
          // The harness page (`mobile/pdf-engine/harness.html`) loads
          // `dist/pdf-engine.js` and `harness.js` as plain, synchronous
          // `<script src>` tags -- neither `async` nor `defer` -- so by the
          // time the page's `load` event fires (this callback), both have
          // already finished executing: `window.renderRecordPdf` is
          // DEFINITIVELY present or absent, and harness.js has already
          // either posted `ready` or, on a missing engine script, posted
          // nothing at all (see harness.js's own `loaded` check -- that
          // silent-failure case is exactly why this probe exists). Probing
          // directly here, instead of only ever waiting on a `ready`
          // message that a missing asset means will never arrive, turns
          // that failure from a 35s timeout on EVERY attempt (the cached
          // `_ready` completer is re-awaited on every retry) into an
          // immediate, clearly-worded error on the first one -- and every
          // retry after, since a completed Future rejects instantly for any
          // later `await`.
          onPageFinished: (_) async {
            if (ready.isCompleted) return;
            bool present;
            try {
              // `_controller` rather than the local `controller` being built
              // by this very cascade: this callback only ever fires once the
              // page has loaded, well after `_controller = controller;`
              // below has run, but referencing the local here would be a
              // forward reference within its own declaration statement,
              // which Dart rejects at compile time.
              final result = await _controller!.runJavaScriptReturningResult(
                "typeof window.renderRecordPdf === 'function'",
              );
              present = readinessProbeIndicatesEngine(result);
            } catch (e) {
              // Could not even run the probe -- treat exactly like "engine
              // absent" rather than falling through to silently wait on a
              // `ready` that may now never come either.
              present = false;
            }
            if (!present && !ready.isCompleted) {
              ready.completeError(
                StateError(
                  'PDF engine asset missing from this build — reinstall the app / report this build.',
                ),
              );
            }
            // When present, `ready` is left for `_onMessage`'s own
            // `{type: 'ready'}` handling to complete -- harness.js has
            // already sent it (or is about to, via the JS channel) by this
            // point, so there is nothing more to do here.
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
    // targetOrigin is deliberately "*", not `window.location.origin`.
    //
    // A mismatched targetOrigin does not fail loudly: the browser silently
    // drops the message, harness.js never sees a render request, and the one
    // observable symptom is this transport's Future never completing -- i.e.
    // every preview turning into a 35-second timeout with no clue as to why.
    // The harness is loaded from a Flutter asset over file:// (or an
    // implementation-defined internal scheme), and what `location.origin`
    // evaluates to there varies by WebView build -- "null", the empty
    // string, or something the same page's own postMessage will not match --
    // so pinning it is a coin flip that costs the whole feature when it
    // loses.
    //
    // Nothing is given up by widening it. The security boundary is
    // harness.js's own INBOUND sender check, not this argument: the harness
    // ignores anything that is not the expected message shape, and it
    // addresses its reply to `event.source` (this page), never broadcasting
    // it. The page is a hidden, app-owned asset with no other frames and no
    // remote content, so there is no third party in the room to overhear a
    // "*" post in the first place.
    //
    // The real end-to-end check for this path stays the device pass -- this
    // transport is not reachable from `flutter test` (see the class doc).
    await _controller!.runJavaScript(
      'window.postMessage($payload, "*");',
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
      //
      // A StateError contributes its `message` rather than its toString():
      // the two asset-load failures this transport raises are StateErrors
      // whose messages are already written FOR the technician ("PDF engine
      // asset missing from this build — reinstall the app / report this
      // build."), and toString() would print them behind a "Bad state: "
      // prefix that means nothing to anyone holding the phone. Every other
      // error keeps toString(), which is all there is to say about it.
      throw PreviewRenderException(e is StateError ? e.message : e.toString());
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
