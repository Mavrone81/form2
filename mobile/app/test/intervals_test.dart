import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/domain/intervals.dart';

// Port of server/intervals.test.js -- same shapes, same cases, so the two
// implementations can never quietly drift apart. Generic invented labels
// only; nothing here is derived from a real form.
IntervalTask _t(int no, String freq) => IntervalTask(no: no, freq: freq, instruction: 'task $no', row: no + 10);

// Shape of sample form F01: 14 x 3M, 3 x 6M, 1 x Y.
List<IntervalTask> _f01() => [
      for (var i = 1; i <= 14; i++) _t(i, '3M'),
      _t(15, '6M'),
      _t(16, '6M'),
      _t(17, '6M'),
      _t(18, 'Y'),
    ];

void main() {
  test('order runs shortest to longest', () {
    expect(kIntervalOrder, ['1M', '3M', '6M', 'Y']);
  });

  test('an interval covers itself and every shorter one', () {
    expect(covers('Y', '3M'), isTrue);
    expect(covers('Y', 'Y'), isTrue);
    expect(covers('6M', '3M'), isTrue);
    expect(covers('3M', '6M'), isFalse);
    expect(covers('1M', '3M'), isFalse);
  });

  test('a yearly service pulls in the 3M and 6M work', () {
    // The regression this whole module exists to prevent: a plain filter
    // would return 1 task and drop 17 required checks off a signed record.
    expect(tasksInScope(_f01(), 'Y'), hasLength(18));
    expect(tasksInScope(_f01(), '6M'), hasLength(17));
    expect(tasksInScope(_f01(), '3M'), hasLength(14));
    expect(tasksInScope(_f01(), '1M'), hasLength(0));
  });

  test('scope summary breaks the total down by frequency', () {
    expect(
      scopeSummary(_f01(), '6M'),
      const IntervalScopeSummary(total: 17, byFreq: {'3M': 14, '6M': 3}),
    );
  });

  test('unknown frequency values are excluded rather than throwing', () {
    expect(tasksInScope([_t(1, 'WEEKLY')], 'Y'), hasLength(0));
  });

  test('an unselected interval (empty string) covers nothing', () {
    // The device's own case: before a technician has picked an interval,
    // covers("", anything) must be false, never a crash on ORDER.indexOf.
    expect(covers('', '1M'), isFalse);
    expect(tasksInScope(_f01(), ''), isEmpty);
  });
}
