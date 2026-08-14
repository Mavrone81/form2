import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/preview/engine.dart';
import 'package:pmrecords/screens/preview.dart';
import 'package:pmrecords/services/connectivity_source.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

LocalDb _newDb() => LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);

/// A transport that always answers with the harness's own error shape, so
/// [PreviewEngine] fails through its real code path and the screen lands in
/// the error state these tests are about.
class _ErrorTransport implements EngineTransport {
  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async => {
        'type': 'error',
        'id': '0',
        'message': 'the sheet could not be drawn',
      };
}

class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'http://localhost');

  int pdfCalls = 0;
  int? lastPdfId;
  Object? pdfError;
  Uint8List pdfBytes = Uint8List.fromList(const [37, 80, 68, 70]); // "%PDF"

  @override
  Future<Uint8List> pdf(int id) async {
    pdfCalls++;
    lastPdfId = id;
    final err = pdfError;
    if (err != null) throw err;
    return pdfBytes;
  }
}

class _FakeConnectivity implements ConnectivitySource {
  _FakeConnectivity(this._isOnline);

  bool _isOnline;
  final StreamController<bool> _controller = StreamController<bool>.broadcast();

  @override
  bool get isOnline => _isOnline;

  @override
  Stream<bool> get onChange => _controller.stream;

  void setOnline(bool value) {
    _isOnline = value;
    _controller.add(value);
  }

  void dispose() => unawaited(_controller.close());
}

const _uuid = '11111111-1111-4111-8111-111111111111';

// A generic, invented bundle entry -- no content derived from a real form.
Map<String, dynamic> _bundleForm() => {
      'form': {'id': 1, 'title': 'Generic PM form', 'doc_number': 'DOC-001', 'revision': 'A'},
      'fields': <dynamic>[],
      'frequencies': ['Y'],
      'tasks': <dynamic>[],
      'grid': {'rows': <dynamic>[]},
      'cellFor': <String, dynamic>{},
      'titleCell': null,
      'intervalCells': <String, dynamic>{},
      'calibrationCells': <String, dynamic>{},
    };

LocalRecord _record(RecordStatus status, {int? serverId}) => LocalRecord(
      clientUuid: _uuid,
      formId: 1,
      frequency: 'Y',
      machineId: 'GEN-1',
      values: const {'field_a': 'Pass'},
      signaturePng: status == RecordStatus.draft ? '' : 'data:image/png;base64,abc',
      signedAt: status == RecordStatus.draft ? '' : '2026-08-14T10:00:00.000Z',
      status: status,
      serverId: serverId,
    );

/// Seeds a db with the cached form and one record in [status]. A `synced`
/// record is produced by going through the real queued -> synced transition
/// rather than inserted as-is, so the fixture matches how such a record can
/// actually come to exist (and carries its server id the same way).
Future<LocalDb> _seed(RecordStatus status, {int? serverId}) async {
  final db = _newDb();
  await db.upsertBundle(1, jsonEncode(_bundleForm()));
  if (status == RecordStatus.synced) {
    await db.insertRecord(_record(RecordStatus.queued));
    await db.markSynced(_uuid, serverId: serverId, state: 'pending_lead');
  } else {
    await db.insertRecord(_record(status, serverId: serverId));
  }
  return db;
}

Future<void> _pumpPreview(
  WidgetTester tester,
  LocalDb db, {
  ApiClient? api,
  ConnectivitySource? connectivity,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: PdfPreviewScreen(
      db: db,
      clientUuid: _uuid,
      userFullName: 'Tech One',
      api: api,
      connectivity: connectivity,
      engine: PreviewEngine(transport: _ErrorTransport()),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(sqfliteFfiInit);

  group('PdfPreviewScreen error state', () {
    testWidgets('shows the engine`s own message and a retry', (tester) async {
      final db = await _seed(RecordStatus.draft);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.text('Could not build the preview'), findsOneWidget);
      expect(find.textContaining('the sheet could not be drawn'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
    });
  });

  // I7 / spec amendment: the on-device engine is the ONLY renderer for an
  // unsynced record -- it exists nowhere else, so there is no server copy to
  // offer and pretending otherwise would be a false promise. Once a record
  // has synced, the server's archival PDF is a genuine second source.
  group('PdfPreviewScreen "View server copy" visibility', () {
    testWidgets('offered for a synced record while online', (tester) async {
      final db = await _seed(RecordStatus.synced, serverId: 42);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsOneWidget);
    });

    testWidgets('NOT offered for an unsynced record, however good the connection', (tester) async {
      final db = await _seed(RecordStatus.draft);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);
    });

    testWidgets('NOT offered for a queued record either -- the server has not accepted it yet', (tester) async {
      final db = await _seed(RecordStatus.queued);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);
    });

    testWidgets('NOT offered for a synced record while offline', (tester) async {
      final db = await _seed(RecordStatus.synced, serverId: 42);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(false);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);
    });

    testWidgets('NOT offered for a synced record with no server id to ask about', (tester) async {
      final db = await _seed(RecordStatus.synced); // markSynced with serverId: null
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);
    });

    testWidgets('NOT offered when no ApiClient was wired in at all', (tester) async {
      final db = await _seed(RecordStatus.synced, serverId: 42);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, connectivity: connectivity);

      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);
    });

    testWidgets('appears when the connection comes back while the error is on screen', (tester) async {
      final db = await _seed(RecordStatus.synced, serverId: 42);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(false);
      addTearDown(connectivity.dispose);

      await _pumpPreview(tester, db, api: _FakeApi(), connectivity: connectivity);
      expect(find.widgetWithText(TextButton, 'View server copy'), findsNothing);

      connectivity.setOnline(true);
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextButton, 'View server copy'), findsOneWidget);
    });
  });

  group('PdfPreviewScreen server copy fetch', () {
    testWidgets('asks the server for THIS record`s id, and reports its refusal verbatim', (tester) async {
      final db = await _seed(RecordStatus.synced, serverId: 42);
      addTearDown(db.close);
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      // A failing fetch keeps the screen in its error state, which is what
      // lets this assert on the wiring without building the `printing`
      // package's PdfPreview (a platform-channel widget).
      final api = _FakeApi()..pdfError = ApiException(403, 'Available once you have signed this record.');

      await _pumpPreview(tester, db, api: api, connectivity: connectivity);
      await tester.tap(find.widgetWithText(TextButton, 'View server copy'));
      await tester.pumpAndSettle();

      expect(api.pdfCalls, 1);
      expect(api.lastPdfId, 42);
      expect(find.textContaining('Available once you have signed this record.'), findsOneWidget);
      // Still recoverable: both ways out are still on offer.
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'View server copy'), findsOneWidget);
    });
  });
}
