/// Interval scope is cumulative. Several forms state in their remarks that a
/// yearly service requires the 3-monthly and 6-monthly work to be done at
/// the same time, so selecting an interval brings every shorter interval
/// into scope with it.
///
/// This is a verbatim port of `server/intervals.js` -- same order, same
/// `covers` rule, same "unknown code never covers anything" behaviour -- so
/// the device can never disagree with the server about which tasks a signed
/// record was required to cover.
const List<String> kIntervalOrder = ['1M', '3M', '6M', 'Y'];

/// True if a visit at [selected] frequency covers a task whose own frequency
/// is [taskFreq] -- itself, and everything shorter. An unrecognised code on
/// either side (including the empty string a not-yet-chosen interval passes
/// in) never covers anything, matching `ORDER.indexOf` returning `-1` in the
/// JS original.
bool covers(String selected, String taskFreq) {
  final s = kIntervalOrder.indexOf(selected);
  final t = kIntervalOrder.indexOf(taskFreq);
  if (s == -1 || t == -1) return false;
  return t <= s;
}

/// One task row of a bundle's `tasks` array: `{no, freq, instruction, row}`.
/// `row` is the sheet row the server placed it on -- also the number the
/// task's own field key is built from (`task_<row>`), which `no` is not
/// guaranteed to match (a form can renumber or skip printed numbers without
/// its underlying row layout changing).
class IntervalTask {
  const IntervalTask({
    required this.no,
    required this.freq,
    required this.instruction,
    required this.row,
  });

  final int no;
  final String freq;
  final String instruction;
  final int row;
}

/// Every task in [tasks] a visit at [selected] frequency covers, in the
/// order [tasks] was given.
List<IntervalTask> tasksInScope(List<IntervalTask> tasks, String selected) =>
    tasks.where((t) => covers(selected, t.freq)).toList();

/// The in-scope count for [selected], broken down by each task's own
/// frequency -- e.g. a yearly visit on a form with 14x3M/3x6M/1xY tasks
/// reports `{total: 18, byFreq: {'3M': 14, '6M': 3, 'Y': 1}}`.
class IntervalScopeSummary {
  const IntervalScopeSummary({required this.total, required this.byFreq});

  final int total;
  final Map<String, int> byFreq;

  @override
  bool operator ==(Object other) =>
      other is IntervalScopeSummary &&
      other.total == total &&
      _mapEquals(other.byFreq, byFreq);

  @override
  int get hashCode => Object.hash(total, Object.hashAllUnordered(byFreq.entries.map((e) => Object.hash(e.key, e.value))));

  @override
  String toString() => 'IntervalScopeSummary(total: $total, byFreq: $byFreq)';
}

bool _mapEquals(Map<String, int> a, Map<String, int> b) {
  if (a.length != b.length) return false;
  for (final entry in a.entries) {
    if (b[entry.key] != entry.value) return false;
  }
  return true;
}

IntervalScopeSummary scopeSummary(List<IntervalTask> tasks, String selected) {
  final inScope = tasksInScope(tasks, selected);
  final byFreq = <String, int>{};
  for (final t in inScope) {
    byFreq[t.freq] = (byFreq[t.freq] ?? 0) + 1;
  }
  return IntervalScopeSummary(total: inScope.length, byFreq: byFreq);
}
