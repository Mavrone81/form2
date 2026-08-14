import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/screens/review_queue.dart';
import 'package:pmrecords/screens/review_record.dart';
import 'package:pmrecords/services/connectivity_source.dart';
import 'package:pmrecords/widgets/signature_pad.dart';

/// Every network call this app's review screens can make, faked with plain
/// call counters and canned results/errors -- no real HTTP, no dart:io
/// server. ApiClient's methods are ordinary (non-final) instance methods
/// specifically so a fake like this can override them.
class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'http://localhost');

  List<dynamic> queueRows = const [];
  Object? queueError;
  int queueCalls = 0;

  Map<String, dynamic> submissionData = const {};

  int signCalls = 0;
  String? lastSignaturePng;
  Object? signError;

  int rejectCalls = 0;
  String? lastRejectReason;
  Object? rejectError;

  @override
  Future<List<dynamic>> queue() async {
    queueCalls++;
    final err = queueError;
    if (err != null) throw err;
    return queueRows;
  }

  @override
  Future<Map<String, dynamic>> submission(int id) async => submissionData;

  @override
  Future<Map<String, dynamic>> sign(int id, String signaturePng) async {
    signCalls++;
    lastSignaturePng = signaturePng;
    final err = signError;
    if (err != null) throw err;
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> reject(int id, String reason) async {
    rejectCalls++;
    lastRejectReason = reason;
    final err = rejectError;
    if (err != null) throw err;
    return {'ok': true};
  }
}

/// The injectable [ConnectivitySource] the brief asks for, driven by hand
/// from a test -- no platform channel involved anywhere in this file.
class _FakeConnectivity implements ConnectivitySource {
  _FakeConnectivity(this._isOnline);

  bool _isOnline;
  final StreamController<bool> _controller = StreamController<bool>.broadcast();

  @override
  bool get isOnline => _isOnline;

  @override
  Stream<bool> get onChange => _controller.stream;

  void setOnline(bool value) {
    _isOnline = value;
    _controller.add(value);
  }

  void dispose() => unawaited(_controller.close());
}

// A generic, invented submission fixture -- no content derived from a real
// form.
Map<String, dynamic> _submissionData({String state = 'pending_lead'}) => {
      'submission': {
        'id': 1,
        'doc_number': 'DOC-001',
        'revision': 'A',
        'machine_id': 'GEN-1',
        'frequency': 'Y',
        'state': state,
      },
      'snapshot': [
        {'field_key': 'machine_id', 'label': 'Machine ID', 'section': 'Record', 'kind': 'text', 'options': ''},
        {'field_key': 'remarks', 'label': 'Remarks', 'section': 'Record', 'kind': 'text', 'options': ''},
        {
          'field_key': 'task_11',
          'label': 'Check filter condition',
          'section': 'Tasks',
          'kind': 'text',
          'options': 'Pass\nFail',
        },
        {
          'field_key': 'sig_technician',
          'label': 'Technician signature',
          'section': 'Sign-off',
          'kind': 'signature',
          'options': '',
        },
      ],
      'values': [
        {'field_key': 'remarks', 'value': 'All good'},
        {'field_key': 'task_11', 'value': 'Pass'},
      ],
      'signatures': [
        {'stage': 'technician', 'full_name': 'Tech One', 'signed_at': '2026-08-10T09:00:00.000Z'},
      ],
      'rejections': const [],
    };

Widget _recordHarness(_FakeApi api, _FakeConnectivity connectivity, {int submissionId = 1}) =>
    MaterialApp(home: ReviewRecordScreen(api: api, connectivity: connectivity, submissionId: submissionId));

Future<void> _drawSignature(WidgetTester tester) async {
  await tester.scrollUntilVisible(find.byType(SignaturePad), 300, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
  final gesture = await tester.startGesture(tester.getCenter(find.byType(SignaturePad)));
  await gesture.moveBy(const Offset(60, 0));
  await gesture.up();
  await tester.pumpAndSettle();
}

/// The composer (caption, reason field, both buttons, signature pad) sits
/// below several read-only sections -- often past the fixed test surface's
/// cache extent, so the `ListView`'s sliver never builds that item's
/// subtree at all until something inside it is scrolled into view (see
/// `record_editor_test.dart`'s identical need before its own "Sign & queue"
/// button). Scrolling to the (always-present, always-unique) reason field
/// is enough to bring the whole composer into the built tree.
Future<void> _revealComposer(WidgetTester tester) async {
  await tester.scrollUntilVisible(find.byType(TextField), 300, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
}

void main() {
  group('ReviewRecordScreen connectivity gating', () {
    testWidgets('offline disables Sign and Reject and shows the exact caption', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(false);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(_recordHarness(api, connectivity));
      await tester.pumpAndSettle();
      await _revealComposer(tester);

      expect(find.text(offlineSubmitCaption), findsOneWidget);

      final signButton = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign'));
      expect(signButton.onPressed, isNull);

      final rejectButton = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Reject'));
      expect(rejectButton.onPressed, isNull);
    });

    testWidgets('online enables Sign and Reject and hides the caption', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(_recordHarness(api, connectivity));
      await tester.pumpAndSettle();
      await _revealComposer(tester);

      expect(find.text(offlineSubmitCaption), findsNothing);

      final signButton = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign'));
      expect(signButton.onPressed, isNotNull);

      final rejectButton = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Reject'));
      expect(rejectButton.onPressed, isNotNull);
    });

    testWidgets('losing connectivity live disables both controls immediately', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(_recordHarness(api, connectivity));
      await tester.pumpAndSettle();
      await _revealComposer(tester);
      expect(find.text(offlineSubmitCaption), findsNothing);

      connectivity.setOnline(false);
      await tester.pumpAndSettle();

      expect(find.text(offlineSubmitCaption), findsOneWidget);
      final signButton = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign'));
      expect(signButton.onPressed, isNull);
      final rejectButton = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Reject'));
      expect(rejectButton.onPressed, isNull);
    });
  });

  group('ReviewRecordScreen reject', () {
    testWidgets('an empty reason is blocked client-side; the API is never called', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(_recordHarness(api, connectivity));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.widgetWithText(OutlinedButton, 'Reject'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Reject'));
      await tester.pumpAndSettle();

      expect(api.rejectCalls, 0);
      expect(find.text('A reason is required to reject this record.'), findsOneWidget);
    });

    testWidgets('a non-empty reason calls api.reject and pops back to the caller', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: ElevatedButton(
              onPressed: () => Navigator.of(context).push<bool>(
                MaterialPageRoute(builder: (_) => ReviewRecordScreen(api: api, connectivity: connectivity, submissionId: 1)),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await _revealComposer(tester);

      await tester.enterText(find.byType(TextField), 'Torque values not recorded.');
      await tester.scrollUntilVisible(
        find.widgetWithText(OutlinedButton, 'Reject'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Reject'));
      await tester.pumpAndSettle();

      expect(api.rejectCalls, 1);
      expect(api.lastRejectReason, 'Torque values not recorded.');
      expect(find.text('open'), findsOneWidget); // popped back
    });
  });

  group('ReviewRecordScreen sign', () {
    testWidgets('signing calls api.sign with a data-URI-prefixed PNG, then pops back', (tester) async {
      final api = _FakeApi()..submissionData = _submissionData();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.runAsync(() async {
        await tester.pumpWidget(MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: ElevatedButton(
                onPressed: () => Navigator.of(context).push<bool>(
                  MaterialPageRoute(
                    builder: (_) => ReviewRecordScreen(api: api, connectivity: connectivity, submissionId: 1),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();

        await _drawSignature(tester);

        await tester.scrollUntilVisible(
          find.widgetWithText(FilledButton, 'Sign'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Sign'));

        for (var i = 0; i < 60; i++) {
          if (api.signCalls > 0) break;
          await Future<void>.delayed(const Duration(milliseconds: 50));
          await tester.pump();
        }
      });
      await tester.pumpAndSettle();

      expect(api.signCalls, 1);
      expect(api.lastSignaturePng, isNotNull);
      expect(api.lastSignaturePng, startsWith(pngDataUriPrefix));
      expect(find.text('open'), findsOneWidget); // popped back
    });

    testWidgets('an ApiException from sign surfaces its message in a SnackBar and stays put', (tester) async {
      final api = _FakeApi()
        ..submissionData = _submissionData()
        ..signError = ApiException(403, 'Someone else already signed this record.');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.runAsync(() async {
        await tester.pumpWidget(_recordHarness(api, connectivity));
        await tester.pumpAndSettle();

        await _drawSignature(tester);

        await tester.scrollUntilVisible(
          find.widgetWithText(FilledButton, 'Sign'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Sign'));

        for (var i = 0; i < 60; i++) {
          if (api.signCalls > 0) break;
          await Future<void>.delayed(const Duration(milliseconds: 50));
          await tester.pump();
        }
      });
      await tester.pumpAndSettle();

      expect(find.text('Someone else already signed this record.'), findsOneWidget);
      // Still on the record screen: the Sign button is present and,
      // crucially, re-enabled (the failed attempt must not leave it stuck).
      final signButton = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Sign'));
      expect(signButton.onPressed, isNotNull);
    });
  });

  group('ReviewQueueScreen', () {
    testWidgets('shows the live queue fetched from the API', (tester) async {
      final api = _FakeApi()
        ..queueRows = [
          {'id': 1, 'doc_number': 'DOC-001', 'revision': 'A', 'machine_id': 'GEN-1', 'frequency': 'Y', 'state': 'pending_lead'},
          {'id': 2, 'doc_number': 'DOC-002', 'revision': 'B', 'machine_id': 'GEN-2', 'frequency': '3M', 'state': 'pending_lead'},
        ];
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(home: ReviewQueueScreen(api: api, connectivity: connectivity)));
      await tester.pumpAndSettle();

      expect(api.queueCalls, 1);
      expect(find.textContaining('DOC-001'), findsOneWidget);
      expect(find.textContaining('DOC-002'), findsOneWidget);
    });

    testWidgets('a fetch failure with no cache shows an offline empty state, not an error dump', (tester) async {
      final api = _FakeApi()..queueError = ApiException(0, 'Failed host lookup');
      final connectivity = _FakeConnectivity(false);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(home: ReviewQueueScreen(api: api, connectivity: connectivity)));
      await tester.pumpAndSettle();

      expect(find.textContaining('Failed host lookup'), findsNothing);
      expect(find.textContaining("You're offline"), findsOneWidget);
    });

    testWidgets('a later fetch failure keeps showing the cached rows, marked as of last connection', (tester) async {
      final api = _FakeApi()
        ..queueRows = [
          {'id': 1, 'doc_number': 'DOC-001', 'revision': 'A', 'machine_id': 'GEN-1', 'frequency': 'Y', 'state': 'pending_lead'},
        ];
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(home: ReviewQueueScreen(api: api, connectivity: connectivity)));
      await tester.pumpAndSettle();
      expect(find.textContaining('DOC-001'), findsOneWidget);
      expect(find.textContaining('as of last connection'), findsNothing);

      connectivity.setOnline(false);
      api.queueError = ApiException(0, 'Network is unreachable');
      final state = tester.state<ReviewQueueScreenState>(find.byType(ReviewQueueScreen));
      await state.refresh();
      await tester.pumpAndSettle();

      // The cached row is still shown -- not cleared by the failed refresh.
      expect(find.textContaining('DOC-001'), findsOneWidget);
      expect(find.textContaining('Network is unreachable'), findsNothing);
      expect(find.textContaining('as of last connection'), findsOneWidget);
    });
  });
}
