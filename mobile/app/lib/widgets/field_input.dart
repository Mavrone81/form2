import 'package:flutter/material.dart';

import 'app_colors.dart';

/// One field's value, rendered the one way this app ever renders a field
/// value: a dropdown of `['—', ...options]` when the field has printed
/// options, free text otherwise, or plain read-only text once [locked] is
/// true. Every text/dropdown/task/parts/calibration control in this app's
/// technician screens goes through this widget, so "options -> dropdown,
/// otherwise free text" and "locked -> read-only text, never a disabled
/// input" only have to be right in one place.
///
/// The read-only path is deliberately a [Text], not a disabled [TextField]:
/// a disabled control usually renders in a washed-out grey that is exactly
/// the low-contrast pattern this app's design language forbids (see
/// [AppColors]) -- a queued or synced record's answers must stay as legible
/// as a draft's.
class FieldValueInput extends StatefulWidget {
  const FieldValueInput({
    super.key,
    required this.value,
    required this.options,
    required this.locked,
    required this.onChanged,
    this.keyboardType,
    this.semanticsLabel,
  });

  final String value;
  final List<String> options;
  final bool locked;
  final ValueChanged<String> onChanged;
  final TextInputType? keyboardType;
  final String? semanticsLabel;

  @override
  State<FieldValueInput> createState() => _FieldValueInputState();
}

class _FieldValueInputState extends State<FieldValueInput> {
  late final TextEditingController _controller = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant FieldValueInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only pull in an externally-changed value (e.g. this draft was reloaded
    // with a different value already saved) -- never stomp on what the
    // technician is mid-way through typing just because a rebuild happened.
    if (widget.value != oldWidget.value && widget.value != _controller.text) {
      _controller.text = widget.value;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.locked) {
      final text = widget.value.trim();
      return Text(
        text.isEmpty ? '—' : text,
        style: const TextStyle(color: AppColors.ink, fontSize: 13),
      );
    }

    if (widget.options.isNotEmpty) {
      // The blank option is what an unanswered field is, and is how one is
      // un-answered again after a mistake -- without it, the first choice
      // would be irreversible.
      final choices = <String>[''];
      for (final o in widget.options) {
        if (!choices.contains(o)) choices.add(o);
      }
      final current = choices.contains(widget.value) ? widget.value : '';
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        decoration: BoxDecoration(border: Border.all(color: AppColors.rule)),
        child: DropdownButtonHideUnderline(
          child: DropdownButton<String>(
            value: current,
            isExpanded: true,
            isDense: true,
            style: const TextStyle(color: AppColors.ink, fontSize: 13),
            items: [
              for (final choice in choices)
                DropdownMenuItem<String>(
                  value: choice,
                  child: Text(choice.isEmpty ? '—' : choice),
                ),
            ],
            onChanged: (v) => widget.onChanged(v ?? ''),
          ),
        ),
      );
    }

    return TextField(
      controller: _controller,
      keyboardType: widget.keyboardType,
      style: const TextStyle(color: AppColors.ink, fontSize: 13),
      decoration: const InputDecoration(
        isDense: true,
        contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        border: OutlineInputBorder(borderSide: BorderSide(color: AppColors.rule)),
        enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.rule)),
      ),
      onChanged: widget.onChanged,
    );
  }
}
