import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/preview/engine.dart';
import 'package:pmrecords/screens/preview.dart';
import 'package:pmrecords/screens/record_editor.dart';
import 'package:pmrecords/widgets/app_colors.dart';
import 'package:pmrecords/widgets/signature_pad.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

// A generic, invented bundle fixture -- no content derived from a real
// form. One task per frequency this form offers, so selecting a wider
// interval visibly changes which rows are in scope.
Map<String, dynamic> _bundleJson() => {
      'form': {'id': 1, 'title': 'Generic PM form', 'doc_number': 'DOC-001', 'revision': 'A'},
      'frequencies': ['3M', '6M', 'Y'],
      'fields': [
        {'field_key': 'machine_id', 'label': 'Machine ID', 'section': 'Record', 'kind': 'text', 'options': '', 'sort_order': 1},
        {'field_key': 'remarks', 'label': 'Remarks', 'section': 'Record', 'kind': 'text', 'options': '', 'sort_order': 2},
        {'field_key': 'task_11', 'label': 'Task 11 status', 'section': 'Tasks', 'kind': 'text', 'options': 'Pass\nFail', 'sort_order': 3},
        {'field_key': 'task_12', 'label': 'Task 12 status', 'section': 'Tasks', 'kind': 'text', 'options': 'Pass\nFail', 'sort_order': 4},
        {'field_key': 'task_13', 'label': 'Task 13 status', 'section': 'Tasks', 'kind': 'text', 'options': 'Pass\nFail', 'sort_order': 5},
        {'field_key': 'sig_technician', 'label': 'Technician signature', 'section': 'Signature', 'kind': 'signature', 'options': '', 'sort_order': 6},
      ],
      'tasks': [
        {'no': 1, 'freq': '3M', 'instruction': 'Check filter condition', 'row': 11},
        {'no': 2, 'freq': '6M', 'instruction': 'Inspect drive belt', 'row': 12},
        {'no': 3, 'freq': 'Y', 'instruction': 'Full service and calibration', 'row': 13},
      ],
    };

LocalDb _newDb() => LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);

Future<String> _seedDraft(LocalDb db, {Map<String, dynamic> values = const {}, String frequency = ''}) async {
  await db.upsertBundle(1, jsonEncode(_bundleJson()));
  const uuid = '11111111-1111-4111-8111-111111111111';
  await db.insertRecord(LocalRecord(
    clientUuid: uuid,
    formId: 1,
    frequency: frequency,
    machineId: '',
    values: values,
    signaturePng: '',
    signedAt: '',
    status: RecordStatus.draft,
  ));
  return uuid;
}

Future<String> _seedQueued(LocalDb db) async {
  await db.upsertBundle(1, jsonEncode(_bundleJson()));
  const uuid = '22222222-2222-4222-8222-222222222222';
  await db.insertRecord(LocalRecord(
    clientUuid: uuid,
    formId: 1,
    frequency: 'Y',
    machineId: 'GEN-1',
    values: const {'remarks': 'All good', 'task_11': 'Pass', 'task_12': 'Pass', 'task_13': 'Pass'},
    signaturePng: '',
    signedAt: '2026-08-14T10:00:00.000Z',
    status: RecordStatus.queued,
  ));
  return uuid;
}

/// A transport that answers with the harness's own error shape, so a tapped
/// Preview exercises the real [PreviewEngine] code path and lands on the
/// preview screen's error state -- without ever constructing a WebView.
class _ErrorTransport implements EngineTransport {
  @override
  Future<Map<String, dynamic>> render(Map<String, dynamic> input) async => {
        'type': 'error',
        'id': '0',
        'message': 'no engine in a unit test',
      };
}

Widget _harness(LocalDb db, String uuid) => MaterialApp(
      home: RecordEditorScreen(
        db: db,
        clientUuid: uuid,
        userFullName: 'Tech One',
        // Always injected in tests: without it, tapping Preview would build
        // the real WebView-backed engine and touch a platform channel.
        previewEngine: PreviewEngine(transport: _ErrorTransport()),
      ),
    );

Color _colorOf(WidgetTester tester, Finder textFinder) {
  final text = tester.widget<Text>(textFinder);
  return text.style!.color!;
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  testWidgets('picking a wider interval (Y) widens the in-scope task rows per the cumulative rule', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db);

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    // Select 3M first: only the 3M task is in scope.
    await tester.tap(find.text('3M'));
    await tester.pumpAndSettle();

    // The task row's own Container carries the key directly.
    Color directRowColor(int row) => tester.widget<Container>(find.byKey(ValueKey('task-row-$row'))).color!;

    expect(directRowColor(11), AppColors.paper); // 3M task: in scope
    expect(directRowColor(12), AppColors.tint); // 6M task: out of scope at 3M
    expect(directRowColor(13), AppColors.tint); // Y task: out of scope at 3M

    // Widen to Y: the cumulative rule now covers every task on this form.
    await tester.tap(find.text('Y'));
    await tester.pumpAndSettle();

    expect(directRowColor(11), AppColors.paper);
    expect(directRowColor(12), AppColors.paper);
    expect(directRowColor(13), AppColors.paper);
  });

  testWidgets('an out-of-scope task row stays present and readable, not faded', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db, frequency: '3M');

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    // The 6M and Y tasks are out of scope at 3M -- present, not hidden.
    final belt = find.text('Inspect drive belt');
    final service = find.text('Full service and calibration');
    expect(belt, findsOneWidget);
    expect(service, findsOneWidget);

    // Never faded: full alpha (this app dims with a different ink color on
    // a tinted background, never with reduced opacity -- see AppColors).
    final beltColor = _colorOf(tester, belt);
    final serviceColor = _colorOf(tester, service);
    expect(beltColor.a, greaterThanOrEqualTo(0.87));
    expect(serviceColor.a, greaterThanOrEqualTo(0.87));
    // And it really is the dimmed ink, not the ordinary one -- proves the
    // row is actually rendered out-of-scope, not merely "not yet faded".
    expect(beltColor, AppColors.tintInk);
    expect(serviceColor, AppColors.tintInk);

    // The in-scope row, by contrast, uses the ordinary ink.
    final filterColor = _colorOf(tester, find.text('Check filter condition'));
    expect(filterColor, AppColors.ink);
    expect(filterColor.a, 1.0);
  });

  testWidgets('a queued record renders read-only: zero editable inputs anywhere', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedQueued(db);

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    expect(find.byType(TextField), findsNothing);
    expect(find.byType(DropdownButton<String>), findsNothing);
    expect(find.byType(SignaturePad), findsNothing);
    expect(find.text('Sign & queue'), findsNothing);
    expect(find.text('3M'), findsNothing); // no picker buttons -- not this form's selected interval, and not tappable anyway
    expect(find.text('Y'), findsOneWidget); // the selected interval, shown as plain text
    // The already-entered answers still show, as text.
    expect(find.text('All good'), findsOneWidget);
  });

  testWidgets('editing a field on a draft writes the new value through to LocalDb', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db);

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    // TextFields render in section order: machine_id first, then remarks.
    await tester.enterText(find.byType(TextField).at(1), 'Cleaned and greased');
    await tester.pumpAndSettle();

    final stored = await db.getRecord(uuid);
    expect(stored, isNotNull);
    expect(stored!.values['remarks'], 'Cleaned and greased');
    expect(stored.status, RecordStatus.draft);
  });

  testWidgets('picking a task status option writes through to LocalDb', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db, frequency: 'Y');

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(DropdownButton<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pass').last);
    await tester.pumpAndSettle();

    final stored = await db.getRecord(uuid);
    expect(stored!.values['task_11'], 'Pass');
  });

  testWidgets('signing stores a PNG data URI the server accepts, not bare base64', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db, frequency: 'Y');

    // `Picture.toImage()`/`Image.toByteData()` (inside `exportPng()`) do
    // genuine engine-level async work that plain `pumpAndSettle()` never
    // waits for -- `runAsync` is the documented way to let that actually
    // complete inside a widget test. Critically, the WHOLE interaction
    // (`pumpWidget` through the final tap) has to happen inside the SAME
    // `runAsync` call: `RecordEditorScreenState` chains its writes onto a
    // `Future` seeded in `initState`, and chaining a real-zone `.then()`
    // onto a Future that was seeded in the test's normal (fake-async) zone
    // never resolves until the whole test body unwinds -- a zone-boundary
    // artifact of the test harness, not a production bug (a real app has no
    // fake-async zone to cross). Seeding that Future from inside the same
    // `runAsync` zone that later chains onto it avoids the crossing.
    await tester.runAsync(() async {
      await tester.pumpWidget(_harness(db, uuid));
      await tester.pumpAndSettle();

      // The signature section is below the fold on the test surface --
      // scroll it into view before interacting with it.
      await tester.scrollUntilVisible(find.byType(SignaturePad), 300, scrollable: find.byType(Scrollable).first);
      await tester.pumpAndSettle();

      final gesture = await tester.startGesture(tester.getCenter(find.byType(SignaturePad)));
      await gesture.moveBy(const Offset(60, 0));
      await gesture.up();
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(find.text('Sign & queue'), 300, scrollable: find.byType(Scrollable).first);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Sign & queue'));
      // The screen's own write handler is private (can't be awaited
      // directly from here), so poll the actual DB state to completion.
      for (var i = 0; i < 60; i++) {
        final r = await db.getRecord(uuid);
        if (r?.status == RecordStatus.queued) break;
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    });

    final stored = await db.getRecord(uuid);
    expect(stored!.status, RecordStatus.queued);
    // The server's assertValidSignature (server/workflow.js) requires this
    // exact prefix before it will even look at the base64 payload -- a bare
    // base64 string here would sync every signed record to a per-record
    // INVALID error that sticks forever.
    expect(stored.signaturePng, startsWith(pngDataUriPrefix));
    final bytes = decodePngDataUri(stored.signaturePng);
    expect(bytes.length, greaterThan(8));
    expect(bytes.sublist(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic number
  });

  testWidgets('signing with a blank pad keeps the record a draft and warns instead', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db, frequency: 'Y');

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Sign & queue'), 300, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign & queue'));
    await tester.pumpAndSettle();

    expect(find.text('Draw a signature before signing.'), findsOneWidget);
    final stored = await db.getRecord(uuid);
    expect(stored!.status, RecordStatus.draft);
    expect(stored.signaturePng, isEmpty);
  });

  testWidgets('two immediate sequential edits to different fields both land in the stored draft', (tester) async {
    final db = _newDb();
    addTearDown(db.close);
    final uuid = await _seedDraft(db);

    await tester.pumpWidget(_harness(db, uuid));
    await tester.pumpAndSettle();

    // Fire both onChanged callbacks back-to-back, synchronously, with no
    // `await` (and so no completed write) in between -- the exact race a
    // lost-update bug needs: edit B must not be built from a stale
    // snapshot that predates edit A.
    final textFields = tester.widgetList<TextField>(find.byType(TextField)).toList();
    // Section order: machine_id first, then remarks.
    textFields[0].onChanged!('MID-1');
    textFields[1].onChanged!('Cleaned and greased');
    await tester.pumpAndSettle();

    final stored = await db.getRecord(uuid);
    expect(stored!.machineId, 'MID-1');
    expect(stored.values['remarks'], 'Cleaned and greased');
  });

  // The spec's first promise about this app is "The Preview button renders
  // the actual final document from the current values" -- so there has to be
  // a Preview button, on the screen where the values are.
  group('Preview action', () {
    testWidgets('is offered for an editable draft', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final uuid = await _seedDraft(db);

      await tester.pumpWidget(_harness(db, uuid));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Preview'), findsOneWidget);
    });

    testWidgets('is offered for a read-only queued record too', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final uuid = await _seedQueued(db);

      await tester.pumpWidget(_harness(db, uuid));
      await tester.pumpAndSettle();

      // Locked for editing, but "what did I actually submit?" is exactly the
      // question a technician asks about a record in this state.
      expect(find.textContaining('Read-only'), findsOneWidget);
      expect(find.byTooltip('Preview'), findsOneWidget);
    });

    testWidgets('tapping it opens the preview screen for this record', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final uuid = await _seedDraft(db);

      await tester.pumpWidget(_harness(db, uuid));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Preview'));
      await tester.pumpAndSettle();

      expect(find.byType(PdfPreviewScreen), findsOneWidget);
      final screen = tester.widget<PdfPreviewScreen>(find.byType(PdfPreviewScreen));
      expect(screen.clientUuid, uuid);
      expect(screen.userFullName, 'Tech One');
      // The injected engine is what the screen actually renders with -- so
      // this test path never constructs a WebView.
      expect(find.textContaining('no engine in a unit test'), findsOneWidget);
    });

    testWidgets('previews the record as it stands RIGHT NOW, including an edit not yet written', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final uuid = await _seedDraft(db);

      await tester.pumpWidget(_harness(db, uuid));
      await tester.pumpAndSettle();

      // Type, then tap Preview immediately -- no settle in between, so the
      // write for this edit may still be in flight when the tap lands. The
      // preview reads the record back from LocalDb, so the editor must drain
      // its write chain before navigating.
      final textFields = tester.widgetList<TextField>(find.byType(TextField)).toList();
      textFields[1].onChanged!('Filter replaced');
      await tester.tap(find.byTooltip('Preview'));
      await tester.pumpAndSettle();

      expect(find.byType(PdfPreviewScreen), findsOneWidget);
      final stored = await db.getRecord(uuid);
      expect(stored!.values['remarks'], 'Filter replaced',
          reason: 'the edit must have landed in the database before the preview screen read it back');
    });
  });
}
