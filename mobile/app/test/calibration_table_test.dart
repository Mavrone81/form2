import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/domain/bundle.dart';
import 'package:pmrecords/widgets/calibration_table.dart';

// Generic invented measurement/spec text only -- nothing derived from a
// real form.
const _readingField = BundleField(
  fieldKey: 'cal_1_reading',
  label: 'Test point A (95-105 g)',
  section: 'Calibration record',
  kind: 'text',
  options: '',
  sortOrder: 1,
);

const _resultField = BundleField(
  fieldKey: 'cal_1_result',
  label: 'Test point A (95-105 g)',
  section: 'Calibration record',
  kind: 'text',
  options: 'Pass\nFail',
  sortOrder: 2,
);

Widget _harness(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('a field with options renders as a dropdown with the blank option first', (tester) async {
    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField],
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    final dropdownFinder = find.byType(DropdownButton<String>);
    expect(dropdownFinder, findsOneWidget);

    final dropdown = tester.widget<DropdownButton<String>>(dropdownFinder);
    expect(dropdown.items!.map((i) => i.value).toList(), ['', 'Pass', 'Fail']);
    expect(dropdown.value, ''); // blank/unanswered by default
  });

  testWidgets('the reading column renders as free-text TextField, never a dropdown', (tester) async {
    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField],
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    expect(find.byType(TextField), findsOneWidget);
    // Exactly one dropdown (the result column) -- the reading column must
    // not also become one.
    expect(find.byType(DropdownButton<String>), findsOneWidget);
  });

  testWidgets('picking a result option writes cal_<row>_result through onChanged', (tester) async {
    final writes = <(String, String)>[];

    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField],
      values: const {},
      locked: false,
      onChanged: (key, value) => writes.add((key, value)),
    )));

    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pass').last);
    await tester.pumpAndSettle();

    expect(writes, [('cal_1_result', 'Pass')]);
  });

  testWidgets('the row heading shows the measurement label, spec included', (tester) async {
    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField],
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    expect(find.text('Test point A (95-105 g)'), findsOneWidget);
  });

  testWidgets('a locked table renders answers as read-only text, not inputs', (tester) async {
    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField],
      values: const {'cal_1_reading': '101 g', 'cal_1_result': 'Pass'},
      locked: true,
      onChanged: (_, _) {},
    )));

    expect(find.byType(TextField), findsNothing);
    expect(find.byType(DropdownButton<String>), findsNothing);
    expect(find.text('101 g'), findsOneWidget);
    expect(find.text('Pass'), findsOneWidget);
  });

  testWidgets('fields with no cal_ key (unrelated section fields) are ignored', (tester) async {
    const other = BundleField(
      fieldKey: 'remarks',
      label: 'Remarks',
      section: 'Record',
      kind: 'text',
      options: '',
      sortOrder: 3,
    );

    await tester.pumpWidget(_harness(CalibrationTable(
      fields: const [_readingField, _resultField, other],
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    expect(find.text('Remarks'), findsNothing);
  });
}
