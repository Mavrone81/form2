import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/preview/engine.dart';

// A generic, invented bundle fixture -- no content derived from a real form.
// Includes the sheet-reproduction keys (`grid`, `cellFor`, `titleCell`,
// `intervalCells`, `calibrationCells`) the app's own typed `FormBundle`
// deliberately drops (see `lib/domain/bundle.dart`) but that
// `renderRecordPdf` needs, exactly as the server's `GET /bundle` route
// produces them (`server/routes.js`'s `formSpec`).
Map<String, dynamic> _bundleForm() => {
  'form': {
    'id': 1,
    'title': 'Generic PM form',
    'doc_number': 'DOC-001',
    'revision': 'A',
    'content_hash': 'deadbeef',
    'file_name': 'generic.xlsx',
  },
  'fields': [
    {
      'field_key': 'machine_id',
      'label': 'Machine ID',
      'section': 'Record',
      'kind': 'text',
      'options': '',
      'sort_order': 1,
    },
    {
      'field_key': 'remarks',
      'label': 'Remarks',
      'section': 'Record',
      'kind': 'text',
      'options': '',
      'sort_order': 2,
    },
    {
      'field_key': 'sig_technician',
      'label': 'Technician signature',
      'section': 'Signature',
      'kind': 'signature',
      'options': '',
      'sort_order': 3,
    },
  ],
  'frequencies': ['3M', '6M', 'Y'],
  'tasks': <Map<String, dynamic>>[],
  'grid': {
    'rows': [
      {
        'index': 0,
        'cells': [
          {'col': 0, 'text': 'Title'},
        ],
      },
    ],
  },
  'cellFor': {
    'remarks': {'row': 3, 'col': 2},
  },
  'titleCell': {'row': 0, 'col': 0},
  'intervalCells': {
    '3M': {'row': 1, 'col': 1},
  },
  'calibrationCells': <String, dynamic>{},
};

LocalRecord _draftRecord({
  Map<String, dynamic> values = const {},
  String signaturePng = '',
  String signedAt = '',
}) => LocalRecord(
  clientUuid: '11111111-1111-4111-8111-111111111111',
  formId: 1,
  frequency: '3M',
  machineId: 'PUMP-01',
  values: values,
  signaturePng: signaturePng,
  signedAt: signedAt,
  status: RecordStatus.draft,
);

const _nowIso = '2026-08-14T12:00:00.000Z';

void main() {
  group('buildEngineInput', () {
    // The whole point: a missing or misnamed key here renders a wrong
    // document silently (per the task brief), so the top-level key set is
    // pinned exactly against renderRecordPdf's own destructured parameter
    // list (server/pdf-record.js) -- not "at least these", exactly these.
    test('produces exactly the key set server/pdf-record.js`s renderRecordPdf destructures', () {
      final input = buildEngineInput(
        _bundleForm(),
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input.keys.toSet(), {
        'form',
        'submission',
        'snapshot',
        'values',
        'signatures',
        'rejections',
        'grid',
        'cellFor',
        'titleCell',
        'intervalCells',
        'calibrationCells',
        'identity',
        'notice',
      });
    });

    test('form passes the bundle`s form row through unchanged', () {
      final bundleForm = _bundleForm();
      final input = buildEngineInput(
        bundleForm,
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['form'], bundleForm['form']);
    });

    test('submission is a draft stub carrying machine_id, frequency, created_at, state and id', () {
      final record = _draftRecord();
      final input = buildEngineInput(
        _bundleForm(),
        record,
        'Alex Tech',
        _nowIso,
      );
      expect(input['submission'], {
        'id': record.clientUuid,
        'machine_id': 'PUMP-01',
        'frequency': '3M',
        'created_at': _nowIso,
        'state': 'draft',
      });
    });

    test('snapshot is the bundle`s own fields list', () {
      final bundleForm = _bundleForm();
      final input = buildEngineInput(
        bundleForm,
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['snapshot'], bundleForm['fields']);
    });

    test('values is a [{field_key, value}] list built from the record`s values map', () {
      final record = _draftRecord(
        values: {'remarks': 'All good', 'task_11': 'Pass'},
      );
      final input = buildEngineInput(
        _bundleForm(),
        record,
        'Alex Tech',
        _nowIso,
      );
      expect(input['values'], [
        {'field_key': 'remarks', 'value': 'All good'},
        {'field_key': 'task_11', 'value': 'Pass'},
      ]);
    });

    test('values is an empty list for a record with nothing entered yet', () {
      final input = buildEngineInput(
        _bundleForm(),
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['values'], isEmpty);
    });

    test(
      'signatures carries the technician`s data-URI image and name when signed',
      () {
        final record = _draftRecord(
          signaturePng: 'data:image/png;base64,AAAA',
          signedAt: '2026-08-14T11:00:00.000Z',
        );
        final input = buildEngineInput(
          _bundleForm(),
          record,
          'Alex Tech',
          _nowIso,
        );
        expect(input['signatures'], [
          {
            'stage': 'technician',
            'full_name': 'Alex Tech',
            'image_png': 'data:image/png;base64,AAAA',
            'signed_at': '2026-08-14T11:00:00.000Z',
          },
        ]);
      },
    );

    test('signatures is [] when the record has not been signed yet', () {
      final input = buildEngineInput(
        _bundleForm(),
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['signatures'], isEmpty);
    });

    test('rejections is always [] -- a device-local record has never been submitted', () {
      final input = buildEngineInput(
        _bundleForm(),
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['rejections'], isEmpty);
    });

    test('grid/cellFor/titleCell/intervalCells/calibrationCells pass through from the bundle untouched', () {
      final bundleForm = _bundleForm();
      final input = buildEngineInput(
        bundleForm,
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['grid'], bundleForm['grid']);
      expect(input['cellFor'], bundleForm['cellFor']);
      expect(input['titleCell'], bundleForm['titleCell']);
      expect(input['intervalCells'], bundleForm['intervalCells']);
      expect(input['calibrationCells'], bundleForm['calibrationCells']);
    });

    test(
      'identity is {title, doc_number, revision} from the bundle`s form row',
      () {
        final input = buildEngineInput(
          _bundleForm(),
          _draftRecord(),
          'Alex Tech',
          _nowIso,
        );
        expect(input['identity'], {
          'title': 'Generic PM form',
          'doc_number': 'DOC-001',
          'revision': 'A',
        });
      },
    );

    test('notice is always "" -- an offline preview cannot detect a since-revised source form', () {
      final input = buildEngineInput(
        _bundleForm(),
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['notice'], '');
    });

    test('degrades gracefully when the bundle`s form/fields are missing or malformed', () {
      final input = buildEngineInput(
        <String, dynamic>{},
        _draftRecord(),
        'Alex Tech',
        _nowIso,
      );
      expect(input['form'], <String, dynamic>{});
      expect(input['snapshot'], isEmpty);
      expect(input['identity'], {
        'title': '',
        'doc_number': '',
        'revision': '',
      });
      expect(input['grid'], isNull);
    });
  });

  group('PreviewEngine.render', () {
    test(
      'throws a typed PreviewTimeoutException when the transport never replies',
      () async {
        final engine = PreviewEngine(
          transport: _NeverRepliesTransport(),
          renderTimeout: const Duration(milliseconds: 30),
        );
        await expectLater(
          engine.render(
            bundleForm: _bundleForm(),
            record: _draftRecord(),
            userFullName: 'Alex Tech',
          ),
          throwsA(isA<PreviewTimeoutException>()),
        );
      },
    );

    test('throws a typed PreviewRenderException carrying the engine`s own message on an error reply', () async {
      final engine = PreviewEngine(
        transport: _ErrorTransport('the sheet could not be read'),
      );
      await expectLater(
        engine.render(
          bundleForm: _bundleForm(),
          record: _draftRecord(),
          userFullName: 'Alex Tech',
        ),
        throwsA(
          isA<PreviewRenderException>().having(
            (e) => e.message,
            'message',
            'the sheet could not be read',
          ),
        ),
      );
    });

    test('decodes a successful base64 reply into the raw PDF bytes', () async {
      final bytes = utf8.encode('%PDF-1.7 fake record bytes');
      final engine = PreviewEngine(
        transport: _SuccessTransport(base64Encode(bytes)),
      );
      final result = await engine.render(
        bundleForm: _bundleForm(),
        record: _draftRecord(),
        userFullName: 'Alex Tech',
      );
      expect(result, bytes);
    });

    // M4: the two asset-load failures WebViewEngineTransport raises are
    // StateErrors whose messages are already written for the technician
    // holding the phone. toString() would print them behind Dart's "Bad
    // state: " prefix, which means nothing to that reader.
    test('a StateError from the transport surfaces its own message, without the "Bad state:" prefix', () async {
      const written = 'PDF engine asset missing from this build — reinstall the app / report this build.';
      final engine = PreviewEngine(transport: _ThrowingTransport(StateError(written)));
      await expectLater(
        engine.render(
          bundleForm: _bundleForm(),
          record: _draftRecord(),
          userFullName: 'Alex Tech',
        ),
        throwsA(isA<PreviewRenderException>().having((e) => e.message, 'message', written)),
      );
    });

    test('any other error keeps its toString() -- only StateError is unwrapped', () async {
      final engine = PreviewEngine(transport: _ThrowingTransport(const FormatException('bad json')));
      await expectLater(
        engine.render(
          bundleForm: _bundleForm(),
          record: _draftRecord(),
          userFullName: 'Alex Tech',
        ),
        throwsA(
          isA<PreviewRenderException>().having(
            (e) => e.message,
            'message',
            const FormatException('bad json').toString(),
          ),
        ),
      );
    });

    test('throws PreviewRenderException for a reply that is neither rendered nor error', () async {
      final engine = PreviewEngine(
        transport: _RawReplyTransport({'type': 'huh'}),
      );
      await expectLater(
        engine.render(
          bundleForm: _bundleForm(),
          record: _draftRecord(),
          userFullName: 'Alex Tech',
        ),
        throwsA(isA<PreviewRenderException>()),
      );
    });
  });

  // WebViewEngineTransport itself stays device-tested only (see its doc
  // comment) -- but the DECISION it makes from a readiness probe result is
  // plain Dart, and worth pinning here: webview_flutter's
  // `runJavaScriptReturningResult` does not return a uniform shape across
  // platform implementations for a JS boolean expression, so this is the
  // one place that ambiguity is actually resolved.
  group('readinessProbeIndicatesEngine', () {
    test('a real Dart bool true means the engine is present', () {
      expect(readinessProbeIndicatesEngine(true), isTrue);
    });

    test('a real Dart bool false means the engine is absent', () {
      expect(readinessProbeIndicatesEngine(false), isFalse);
    });

    test('an unquoted "true" string (some platforms) means present', () {
      expect(readinessProbeIndicatesEngine('true'), isTrue);
    });

    test('a JSON-quoted \'"true"\' string (other platforms) means present', () {
      expect(readinessProbeIndicatesEngine('"true"'), isTrue);
    });

    test('"false" means absent', () {
      expect(readinessProbeIndicatesEngine('false'), isFalse);
    });

    test('null (the probe itself failing) means absent', () {
      expect(readinessProbeIndicatesEngine(null), isFalse);
    });

    test('any other, unrecognised value means absent -- fails closed', () {
      expect(readinessProbeIndicatesEngine('undefined'), isFalse);
      expect(readinessProbeIndicatesEngine(0), isFalse);
    });
  });
}

/// A transport whose Future never completes -- the exact shape of a hidden
/// WebView that loaded but never posted `ready` (e.g. a missing
/// `dist/pdf-engine.js` asset; see `WebViewEngineTransport`'s doc comment).
class _NeverRepliesTransport implements EngineTransport {
  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) =>
      Completer<Map<String, dynamic>>().future;
}

class _ErrorTransport implements EngineTransport {
  _ErrorTransport(this.message);
  final String message;

  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async => {
    'type': 'error',
    'id': '0',
    'message': message,
  };
}

class _SuccessTransport implements EngineTransport {
  _SuccessTransport(this.base64Pdf);
  final String base64Pdf;

  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async => {
    'type': 'rendered',
    'id': '0',
    'pdf': base64Pdf,
    'bytes': base64Pdf.length,
  };
}

/// A transport that fails the way the real one does when the harness page
/// (or the engine script inside it) is missing from the build: by throwing,
/// not by replying.
class _ThrowingTransport implements EngineTransport {
  _ThrowingTransport(this.error);
  final Object error;

  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async =>
      throw error;
}

class _RawReplyTransport implements EngineTransport {
  _RawReplyTransport(this.reply);
  final Map<String, dynamic> reply;

  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async =>
      reply;
}
