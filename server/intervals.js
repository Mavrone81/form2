// Interval scope is cumulative. Several forms state in their remarks that a
// yearly service requires the 3M and 6M work to be done at the same time, so
// selecting an interval brings every shorter interval into scope with it.
export const ORDER = ['1M', '3M', '6M', 'Y'];

export function covers(selected, taskFreq) {
  const s = ORDER.indexOf(selected);
  const t = ORDER.indexOf(taskFreq);
  if (s === -1 || t === -1) return false;
  return t <= s;
}

export function tasksInScope(tasks, selected) {
  return tasks.filter((t) => covers(selected, t.freq));
}

export function scopeSummary(tasks, selected) {
  const inScope = tasksInScope(tasks, selected);
  const byFreq = {};
  for (const t of inScope) byFreq[t.freq] = (byFreq[t.freq] ?? 0) + 1;
  return { total: inScope.length, byFreq };
}
