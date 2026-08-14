import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/domain/bundle.dart';
import 'package:pmrecords/widgets/parts_table.dart';

// Generic invented parts fixtures only -- nothing derived from a real form.
List<BundleField> _fields({int rows = 2}) => [
      for (var r = 1; r <= rows; r++) ...[
        BundleField(fieldKey: 'part_${r}_no', label: 'Part no', section: 'Parts', kind: 'text', options: '', sortOrder: r * 10),
        BundleField(fieldKey: 'part_${r}_desc', label: 'Description', section: 'Parts', kind: 'text', options: '', sortOrder: r * 10 + 1),
        BundleField(fieldKey: 'part_${r}_qty', label: 'Qty', section: 'Parts', kind: 'text', options: '', sortOrder: r * 10 + 2),
        BundleField(fieldKey: 'part_${r}_remarks', label: 'Remarks', section: 'Parts', kind: 'text', options: '', sortOrder: r * 10 + 3),
      ],
    ];

Widget _harness(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('unlocked: every row renders, including fully blank ones', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(),
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    expect(find.byKey(const ValueKey('parts-row-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('parts-row-2')), findsOneWidget);
    expect(find.byType(TextField), findsNWidgets(8)); // 2 rows x 4 columns
  });

  testWidgets('locked with one filled row shows only that row, and no inputs', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(),
      values: const {'part_1_no': 'P-100', 'part_1_desc': 'Bolt', 'part_1_qty': '2', 'part_1_remarks': 'spare'},
      locked: true,
      onChanged: (_, _) {},
    )));

    expect(find.byKey(const ValueKey('parts-row-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('parts-row-2')), findsNothing);
    expect(find.text('P-100'), findsOneWidget);
    expect(find.text('No parts recorded.'), findsNothing);
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(DropdownButton<String>), findsNothing);
  });

  testWidgets('locked with a row that has just one filled column still shows the whole row', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(),
      values: const {'part_2_qty': '3'},
      locked: true,
      onChanged: (_, _) {},
    )));

    expect(find.byKey(const ValueKey('parts-row-1')), findsNothing);
    expect(find.byKey(const ValueKey('parts-row-2')), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('locked with nothing filled in shows "No parts recorded." and no rows', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(),
      values: const {},
      locked: true,
      onChanged: (_, _) {},
    )));

    expect(find.text('No parts recorded.'), findsOneWidget);
    expect(find.byKey(const ValueKey('parts-row-1')), findsNothing);
    expect(find.byKey(const ValueKey('parts-row-2')), findsNothing);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('whitespace-only values count as blank, not filled', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(rows: 1),
      values: const {'part_1_no': '   '},
      locked: true,
      onChanged: (_, _) {},
    )));

    expect(find.text('No parts recorded.'), findsOneWidget);
  });

  testWidgets('typing in an unlocked qty cell writes through to onChanged', (tester) async {
    final writes = <(String, String)>[];

    await tester.pumpWidget(_harness(PartsTable(
      fields: _fields(rows: 1),
      values: const {},
      locked: false,
      onChanged: (key, value) => writes.add((key, value)),
    )));

    // Columns render in order: no, desc, qty, remarks -- qty is the 3rd field.
    await tester.enterText(find.byType(TextField).at(2), '5');

    expect(writes, [('part_1_qty', '5')]);
  });

  testWidgets('no part_ fields at all renders nothing', (tester) async {
    await tester.pumpWidget(_harness(PartsTable(
      fields: const [
        BundleField(fieldKey: 'remarks', label: 'Remarks', section: 'Record', kind: 'text', options: '', sortOrder: 1),
      ],
      values: const {},
      locked: false,
      onChanged: (_, _) {},
    )));

    expect(find.byType(TextField), findsNothing);
    expect(find.text('No parts recorded.'), findsNothing);
  });
}
