import 'package:flutter/material.dart';

import '../domain/bundle.dart';
import 'app_colors.dart';
import 'field_input.dart';

/// One entry of the Calibration Record table, or `null`. Mirrors
/// `calKeyOf()` in `web/js/field-panel.js` -- restated here for the same
/// reason `parts_table.dart` restates the parts convention.
class _CalKey {
  const _CalKey(this.row, this.column);
  final int row;
  final String column;
}

final _calKeyPattern = RegExp(r'^cal_(\d+)_(reading|result)$');

_CalKey? _calKeyOf(String fieldKey) {
  final m = _calKeyPattern.firstMatch(fieldKey);
  if (m == null) return null;
  return _CalKey(int.parse(m.group(1)!), m.group(2)!);
}

/// The Calibration Record table: one row per measurement, each with a
/// reading (free text) and a result. The measurement's own name -- which,
/// per the brief, already carries the printed specification in its label
/// (e.g. "Bond force (95-105 g)") -- comes straight from the field's
/// `label`, so the row heading and the document can never name the
/// measurement differently.
///
/// A row is NOT hidden once [locked]: an unanswered measurement is itself
/// information on a calibration record (the check was not done), unlike the
/// parts table where a blank row means nothing was fitted.
class CalibrationTable extends StatelessWidget {
  const CalibrationTable({
    super.key,
    required this.fields,
    required this.values,
    required this.locked,
    required this.onChanged,
  });

  /// Only this section's `cal_<row>_<reading|result>` fields; anything else
  /// is ignored, so a caller can pass a whole section's field list
  /// unfiltered.
  final List<BundleField> fields;
  final Map<String, dynamic> values;
  final bool locked;
  final void Function(String fieldKey, String value) onChanged;

  @override
  Widget build(BuildContext context) {
    final rows = <int, Map<String, BundleField>>{};
    for (final f in fields) {
      final key = _calKeyOf(f.fieldKey);
      if (key == null) continue;
      rows.putIfAbsent(key.row, () => {})[key.column] = f;
    }
    if (rows.isEmpty) return const SizedBox.shrink();

    final sortedRows = rows.keys.toList()..sort();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final rowNo in sortedRows)
          Padding(
            key: ValueKey('cal-row-$rowNo'),
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: _CalRow(row: rows[rowNo]!, values: values, locked: locked, onChanged: onChanged),
          ),
      ],
    );
  }
}

class _CalRow extends StatelessWidget {
  const _CalRow({required this.row, required this.values, required this.locked, required this.onChanged});

  final Map<String, BundleField> row;
  final Map<String, dynamic> values;
  final bool locked;
  final void Function(String fieldKey, String value) onChanged;

  @override
  Widget build(BuildContext context) {
    final reading = row['reading'];
    final result = row['result'];
    final name = reading?.label ?? result?.label ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(name, style: const TextStyle(color: AppColors.ink, fontSize: 12.5)),
        const SizedBox(height: 4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (reading != null)
              Expanded(
                flex: 3,
                child: FieldValueInput(
                  value: (values[reading.fieldKey] ?? '').toString(),
                  options: const [],
                  locked: locked,
                  onChanged: (v) => onChanged(reading.fieldKey, v),
                ),
              ),
            if (reading != null && result != null) const SizedBox(width: 8),
            if (result != null)
              Expanded(
                flex: 2,
                child: FieldValueInput(
                  value: (values[result.fieldKey] ?? '').toString(),
                  options: result.optionsList,
                  locked: locked,
                  onChanged: (v) => onChanged(result.fieldKey, v),
                ),
              ),
          ],
        ),
      ],
    );
  }
}
