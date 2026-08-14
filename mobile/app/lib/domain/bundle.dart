import 'intervals.dart';

/// The subset of a bundle's `form` object the technician screens need for
/// display -- title and the document identity printed on the paper form.
class FormMeta {
  const FormMeta({
    required this.id,
    required this.title,
    required this.docNumber,
    required this.revision,
  });

  final int id;
  final String title;
  final String docNumber;
  final String revision;

  factory FormMeta.fromJson(Map<String, dynamic> json) => FormMeta(
        id: _asInt(json['id']),
        title: (json['title'] ?? '').toString(),
        docNumber: (json['doc_number'] ?? '').toString(),
        revision: (json['revision'] ?? '').toString(),
      );
}

/// One row of a bundle's `fields` array:
/// `{field_key, label, section, kind: 'text'|'signature', options, sort_order}`.
///
/// `options` is stored exactly as the server sends it -- `''` for free text,
/// or the printed choices one per line (`'Pass\nFail'`) -- and [optionsList]
/// is the one place that convention gets parsed, so a field's own choices
/// and a dropdown's choices can never drift apart.
class BundleField {
  const BundleField({
    required this.fieldKey,
    required this.label,
    required this.section,
    required this.kind,
    required this.options,
    required this.sortOrder,
  });

  final String fieldKey;
  final String label;
  final String section;
  final String kind;
  final String options;
  final int sortOrder;

  bool get isSignature => kind == 'signature';

  List<String> get optionsList => options
      .split('\n')
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toList();

  bool get hasOptions => optionsList.isNotEmpty;

  factory BundleField.fromJson(Map<String, dynamic> json) => BundleField(
        fieldKey: (json['field_key'] ?? '').toString(),
        label: (json['label'] ?? '').toString(),
        section: (json['section'] ?? '').toString(),
        kind: (json['kind'] ?? 'text').toString(),
        options: (json['options'] ?? '').toString(),
        sortOrder: _asInt(json['sort_order']),
      );
}

/// The decoded shape of one form's bundle -- everything the technician fill
/// -in screens read from the cached `GET /api/bundle` snapshot. Fields the
/// mobile app never renders (`cellFor`, `titleCell`, `intervalCells`,
/// `calibrationCells`, `grid` -- all of them the printed-sheet reproduction
/// the web app draws) are deliberately not modelled here.
class FormBundle {
  const FormBundle({
    required this.form,
    required this.fields,
    required this.frequencies,
    required this.tasks,
  });

  final FormMeta form;
  final List<BundleField> fields;
  final List<String> frequencies;
  final List<IntervalTask> tasks;

  factory FormBundle.fromJson(Map<String, dynamic> json) {
    final fields = ((json['fields'] as List?) ?? [])
        .map((e) => BundleField.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList()
      ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder));

    final tasks = ((json['tasks'] as List?) ?? []).map((e) {
      final t = Map<String, dynamic>.from(e as Map);
      return IntervalTask(
        no: _asInt(t['no']),
        freq: (t['freq'] ?? '').toString(),
        instruction: (t['instruction'] ?? '').toString(),
        row: _asInt(t['row']),
      );
    }).toList();

    final frequencies = ((json['frequencies'] as List?) ?? []).map((e) => e.toString()).toList();

    // Guarded the same way the list fields above are: a missing/malformed
    // `form` object must not throw a cast exception, it should just come
    // through as every field defaulting empty (see FormMeta.fromJson).
    final formJson = json['form'];
    final form = FormMeta.fromJson(formJson is Map ? Map<String, dynamic>.from(formJson) : const <String, dynamic>{});

    return FormBundle(
      form: form,
      fields: fields,
      frequencies: frequencies,
      tasks: tasks,
    );
  }

  /// The field for [fieldKey], or `null` if this form has none -- the normal
  /// case for e.g. a `task_<row>` whose row carries no status column.
  BundleField? fieldFor(String fieldKey) {
    for (final f in fields) {
      if (f.fieldKey == fieldKey) return f;
    }
    return null;
  }

  /// [fields], grouped by their `section` and kept in the sort order the
  /// bundle already carries -- so "fields grouped by section in sort order"
  /// only has to be right once, here.
  Map<String, List<BundleField>> get bySection {
    final grouped = <String, List<BundleField>>{};
    for (final f in fields) {
      grouped.putIfAbsent(f.section, () => []).add(f);
    }
    return grouped;
  }
}

int _asInt(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}
