import 'package:flutter/material.dart';

import '../domain/bundle.dart';
import '../domain/intervals.dart';
import 'app_colors.dart';
import 'field_input.dart';

/// The task table, one row per bundle task, in the order the bundle lists
/// them. A row whose own frequency the currently [selectedFrequency] does
/// NOT [covers] renders dimmed -- a tinted background and a darker-on-tint
/// ink, never hidden and never text-opacity-faded (see [AppColors]) -- so a
/// technician can still read exactly what a wider visit would have required.
///
/// Each row's status control comes from the bundle field named `task_<row>`
/// (row, not the printed number -- they can differ), through
/// [FieldValueInput]: a dropdown when that field carries options (the usual
/// case -- pass/fail-shaped answers), free text otherwise. A row with no
/// matching field at all (a task with no status column on this form) shows
/// no control.
class TaskList extends StatelessWidget {
  const TaskList({
    super.key,
    required this.tasks,
    required this.fields,
    required this.selectedFrequency,
    required this.values,
    required this.locked,
    required this.onChanged,
  });

  final List<IntervalTask> tasks;
  final List<BundleField> fields;

  /// '' when no interval has been chosen yet -- every row is then out of
  /// scope, since [covers] never matches an unrecognised/empty code.
  final String selectedFrequency;
  final Map<String, dynamic> values;
  final bool locked;
  final void Function(String fieldKey, String value) onChanged;

  BundleField? _statusFieldFor(int row) {
    for (final f in fields) {
      if (f.fieldKey == 'task_$row') return f;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final task in tasks) _TaskRow(task: task, list: this)],
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.task, required this.list});

  final IntervalTask task;
  final TaskList list;

  @override
  Widget build(BuildContext context) {
    final inScope = covers(list.selectedFrequency, task.freq);
    final field = list._statusFieldFor(task.row);
    final bg = inScope ? AppColors.paper : AppColors.tint;
    final ink = inScope ? AppColors.ink : AppColors.tintInk;

    return Container(
      key: ValueKey('task-row-${task.row}'),
      color: bg,
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 26,
            child: Text(
              '${task.no}',
              style: TextStyle(color: ink, fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8, top: 2),
              child: Text(
                task.instruction,
                style: TextStyle(color: ink, fontSize: 13),
              ),
            ),
          ),
          SizedBox(
            width: 116,
            child: field == null
                ? Text('—', style: TextStyle(color: ink))
                : FieldValueInput(
                    value: (list.values[field.fieldKey] ?? '').toString(),
                    options: field.optionsList,
                    locked: list.locked,
                    onChanged: (v) => list.onChanged(field.fieldKey, v),
                  ),
          ),
        ],
      ),
    );
  }
}
