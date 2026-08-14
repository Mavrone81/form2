import 'package:flutter/material.dart';

import '../domain/bundle.dart';
import 'app_colors.dart';
import 'field_input.dart';

/// One box of the Parts Required table, or `null`. Mirrors `partsKeyOf()` in
/// `web/js/field-panel.js` -- the web app and this app share no module, so
/// the `part_<row>_<column>` convention is restated here, the same way the
/// web copy restates it from the server's.
class _PartsKey {
  const _PartsKey(this.row, this.column);
  final int row;
  final String column;
}

final _partsKeyPattern = RegExp(r'^part_(\d+)_(no|desc|qty|remarks)$');

_PartsKey? _partsKeyOf(String fieldKey) {
  final m = _partsKeyPattern.firstMatch(fieldKey);
  if (m == null) return null;
  return _PartsKey(int.parse(m.group(1)!), m.group(2)!);
}

const _partsOrder = ['no', 'desc', 'qty', 'remarks'];
const _partsFallback = {'no': 'Part no', 'desc': 'Description', 'qty': 'Qty', 'remarks': 'Remarks'};

/// The Parts Required table: four columns (no / description / qty /
/// remarks) per row, laid out as a compact grid rather than the ordinary
/// stacked-field list -- the same "the document prints a table, so this
/// renders a table" choice the web panel makes for the same section (see
/// `partsGrid()` in `web/js/field-panel.js`).
///
/// `qty` gets the numeric keyboard via [TextInputType.number] rather than
/// being parsed as a number -- a technician typing "2 sets" must not watch
/// the value silently discarded.
class PartsTable extends StatelessWidget {
  const PartsTable({
    super.key,
    required this.fields,
    required this.values,
    required this.locked,
    required this.onChanged,
  });

  /// Only this section's `part_<row>_<column>` fields; anything else is
  /// ignored, so a caller can pass a whole section's field list unfiltered.
  final List<BundleField> fields;
  final Map<String, dynamic> values;
  final bool locked;
  final void Function(String fieldKey, String value) onChanged;

  @override
  Widget build(BuildContext context) {
    final rows = <int, Map<String, BundleField>>{};
    for (final f in fields) {
      final key = _partsKeyOf(f.fieldKey);
      if (key == null) continue;
      rows.putIfAbsent(key.row, () => {})[key.column] = f;
    }
    if (rows.isEmpty) return const SizedBox.shrink();

    String heading(String column) {
      for (final row in rows.values) {
        final label = row[column]?.label;
        if (label != null && label.isNotEmpty) return label;
      }
      return _partsFallback[column]!;
    }

    final sortedRows = rows.keys.toList()..sort();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            for (final c in _partsOrder)
              Expanded(
                child: Text(
                  heading(c),
                  style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        for (final rowNo in sortedRows) _PartsRow(row: rows[rowNo]!, values: values, locked: locked, onChanged: onChanged),
      ],
    );
  }
}

class _PartsRow extends StatelessWidget {
  const _PartsRow({required this.row, required this.values, required this.locked, required this.onChanged});

  final Map<String, BundleField> row;
  final Map<String, dynamic> values;
  final bool locked;
  final void Function(String fieldKey, String value) onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final c in _partsOrder)
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: row[c] == null
                    ? const SizedBox.shrink()
                    : FieldValueInput(
                        value: (values[row[c]!.fieldKey] ?? '').toString(),
                        options: const [],
                        locked: locked,
                        keyboardType: c == 'qty' ? TextInputType.number : null,
                        onChanged: (v) => onChanged(row[c]!.fieldKey, v),
                      ),
              ),
            ),
        ],
      ),
    );
  }
}
