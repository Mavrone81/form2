import 'package:flutter/material.dart';

import 'app_colors.dart';

/// The maintenance-interval segmented control -- mirrors the web panel's
/// `.segs` band exactly: one button per frequency the FORM ITSELF offers
/// (never the full `1M/3M/6M/Y` set), the selected one filled solid.
///
/// Once [locked] (a queued/synced/error record), the chosen interval renders
/// as plain text and no button appears -- there is nothing left to pick.
class IntervalPicker extends StatelessWidget {
  const IntervalPicker({
    super.key,
    required this.frequencies,
    required this.selected,
    required this.locked,
    required this.onSelected,
  });

  /// Only this form's own frequencies, in the order the bundle lists them.
  final List<String> frequencies;

  /// '' when nothing has been chosen yet.
  final String selected;
  final bool locked;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    if (frequencies.isEmpty) return const SizedBox.shrink();

    if (locked) {
      return Text(
        selected.isEmpty ? '—' : selected,
        style: const TextStyle(color: AppColors.ink, fontSize: 13, fontWeight: FontWeight.w600),
      );
    }

    return Row(
      children: [
        for (final f in frequencies)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 6),
              child: _SegButton(
                label: f,
                selected: f == selected,
                onTap: () => onSelected(f),
              ),
            ),
          ),
      ],
    );
  }
}

class _SegButton extends StatelessWidget {
  const _SegButton({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.ink : AppColors.paper,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(border: Border.all(color: AppColors.rule)),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? AppColors.paper : AppColors.ink,
              fontWeight: FontWeight.w600,
              fontSize: 12,
            ),
          ),
        ),
      ),
    );
  }
}
