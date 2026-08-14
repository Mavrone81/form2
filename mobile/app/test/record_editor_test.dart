import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
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

Widget _harness(LocalDb db, String uuid) => MaterialApp(home: RecordEditorScreen(db: db, clientUuid: uuid));

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
}
