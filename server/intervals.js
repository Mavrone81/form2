// Interval scope is cumulative. Several forms state in their remarks that a
// yearly service requires the 3M and 6M work to be done at the same time, so
// selecting an interval brings every shorter interval into scope with it.
export const ORDER = ['1M', '3M', '6M', 'Y'];

// Every interval code as the documents themselves print it in the frequency
// band above the task table: the code in parentheses, e.g. "Three Monthly
// (3M)". The parenthesised code is the ONLY stable part — the prose around it
// differs between documents ("Three Monthly (3M)" on most, "Three Month (3M)"
// on two of the twelve) — so everything that has to recognise a printed
// option matches here and never on the wording.
//
// Returns each code found in `text` with its character range, in the order it
// appears, so a caller can point at one option inside a cell that prints
// several. Ranges are offsets into the string passed in; callers that will
// later slice rendered cell text must pass the SAME (trimmed) text the grid
// renders, or the offsets will not line up.
export function findIntervalCodes(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\((1M|3M|6M|Y)\)/gi)) {
    out.push({ code: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

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
