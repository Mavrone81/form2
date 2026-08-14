import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/auth/pin.dart';
import 'package:pmrecords/auth/secure_storage.dart';
import 'package:pmrecords/auth/session.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/main.dart';
import 'package:pmrecords/screens/admin_notice.dart';
import 'package:pmrecords/screens/login.dart';
import 'package:pmrecords/screens/pin_gate.dart';
import 'package:pmrecords/screens/review_queue.dart';
import 'package:pmrecords/screens/technician_home.dart';
import 'package:pmrecords/services/connectivity_source.dart';
import 'package:pmrecords/sync/queue.dart';
import 'package:pmrecords/widgets/sync_banner.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

LocalDb _newDb() => LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);

/// Every network call this suite's screens can make, faked with plain call
/// counters/canned results -- no real HTTP -- mirroring the fakes already
/// used in review_test.dart / queue_test.dart.
class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'http://localhost');

  List<dynamic> queueRows = const [];

  LoginResult? loginResult;
  Object? loginError;
  int loginCalls = 0;

  int logoutCalls = 0;

  @override
  Future<List<dynamic>> queue() async => queueRows;

  @override
  Future<LoginResult> login(String username, String password, {bool wantDeviceToken = false}) async {
    loginCalls++;
    final err = loginError;
    if (err != null) throw err;
    return loginResult!;
  }

  @override
  Future<void> logout() async {
    logoutCalls++;
  }
}

/// The injectable [ConnectivitySource], driven by hand from a test.
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

/// Counts `replay` calls without ever touching the network or [LocalDb]'s
/// write paths -- exactly the "counting fake queue" the brief asks for, for
/// the auto-replay-on-reconnect test.
class _CountingSyncQueue extends SyncQueue {
  _CountingSyncQueue(super.db);

  int replayCalls = 0;

  @override
  Future<SyncReplayResult> replay(ApiClient api, {bool Function(LocalRecord record)? include}) async {
    replayCalls++;
    return const SyncReplayResult.empty();
  }
}

Map<String, dynamic> _user({required String role, String username = 'tech1', String fullName = 'Tech One'}) =>
    {'id': 1, 'username': username, 'full_name': fullName, 'role': role, 'active': 1};

LocalRecord _record(String uuid, RecordStatus status, {String? error}) => LocalRecord(
      clientUuid: uuid,
      formId: 7,
      frequency: 'Y',
      machineId: 'GEN-1',
      values: const {'field_a': 'Pass'},
      signaturePng: status == RecordStatus.draft ? '' : 'data:image/png;base64,abc',
      signedAt: status == RecordStatus.draft ? '' : '2026-08-14T10:00:00.000Z',
      status: status,
      error: error,
    );

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  group('AppShell role routing', () {
    testWidgets('technician lands on their records + forms entry', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician'));
      final pin = PinLock(storage); // no PIN set yet -- bootstrap must not gate on it
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(TechnicianHomeScreen), findsOneWidget);
      // "forms list" entry point -- the FAB that opens FormsListScreen.
      expect(find.text('New record'), findsOneWidget);
    });

    testWidgets('team leader lands on the review queue', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'team_leader', username: 'lead1', fullName: 'Lead One'));
      final pin = PinLock(storage);
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(ReviewQueueScreen), findsOneWidget);
    });

    testWidgets('engineer also lands on the review queue', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'engineer', username: 'eng1', fullName: 'Eng One'));
      final pin = PinLock(storage);
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(ReviewQueueScreen), findsOneWidget);
    });

    testWidgets('admin lands on the "admin works on the web" notice', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'admin', username: 'admin1', fullName: 'Admin One'));
      final pin = PinLock(storage);
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(AdminNoticeScreen), findsOneWidget);
      expect(find.textContaining('web'), findsWidgets);
    });
  });

  group('SyncBanner count', () {
    testWidgets('reflects queued + error rows and disappears at zero', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_record('11111111-1111-4111-8111-111111111111', RecordStatus.queued));
      await db.insertRecord(_record('22222222-2222-4222-8222-222222222222', RecordStatus.queued));
      await db.insertRecord(_record('33333333-3333-4333-8333-333333333333', RecordStatus.error, error: 'INVALID: bad value'));

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      final syncQueue = _CountingSyncQueue(db);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(db: db, api: api, syncQueue: syncQueue, connectivity: connectivity, username: 'tech1'),
        ),
      ));
      await tester.pumpAndSettle();

      expect(find.textContaining('3 records waiting to sync'), findsOneWidget);
      expect(find.textContaining('1 failed'), findsOneWidget);

      // Mark everything terminal -- the banner must vanish entirely.
      await db.markSynced('11111111-1111-4111-8111-111111111111', serverId: 1, state: 'pending_lead');
      await db.markSynced('22222222-2222-4222-8222-222222222222', serverId: 2, state: 'pending_lead');
      await db.requeue('33333333-3333-4333-8333-333333333333'); // error -> queued
      await db.markSynced('33333333-3333-4333-8333-333333333333', serverId: 3, state: 'pending_lead');

      final state = tester.state<SyncBannerState>(find.byType(SyncBanner));
      await state.refreshCounts();
      await tester.pumpAndSettle();

      expect(find.textContaining('waiting to sync'), findsNothing);
    });
  });

  group('SyncBanner auto-replay', () {
    testWidgets('fires exactly once per offline -> online transition', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_record('11111111-1111-4111-8111-111111111111', RecordStatus.queued));

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      final syncQueue = _CountingSyncQueue(db);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(db: db, api: api, syncQueue: syncQueue, connectivity: connectivity, username: 'tech1'),
        ),
      ));
      await tester.pumpAndSettle();
      expect(syncQueue.replayCalls, 0); // starting online is not itself a transition

      connectivity.setOnline(false);
      await tester.pumpAndSettle();
      expect(syncQueue.replayCalls, 0); // going offline never replays

      connectivity.setOnline(true);
      await tester.pumpAndSettle();
      expect(syncQueue.replayCalls, 1); // first offline -> online transition

      connectivity.setOnline(true); // redundant "already online" emission
      await tester.pumpAndSettle();
      expect(syncQueue.replayCalls, 1); // no duplicate replay

      connectivity.setOnline(false);
      await tester.pumpAndSettle();
      connectivity.setOnline(true);
      await tester.pumpAndSettle();
      expect(syncQueue.replayCalls, 2); // a SECOND offline -> online transition
    });
  });

  group('AppShell cold start', () {
    testWidgets('offline with a stored session shows the PIN gate', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician'));
      final pin = PinLock(storage);
      await pin.setPin('1234');
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(false); // offline cold start
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(PinGateScreen), findsOneWidget);
    });
  });

  group('PinGateScreen lockout', () {
    testWidgets('a locked-out gate shows countdown copy, not a bare error', (tester) async {
      final storage = InMemorySecureStorage();
      final pin = PinLock(storage);
      await pin.setPin('1234');
      // Exhaust the 5-attempt budget before the widget is even built, so the
      // very first tap inside the widget lands on the lockout branch.
      for (var i = 0; i < 5; i++) {
        await pin.verify('9999');
      }

      var unlocked = false;
      await tester.pumpWidget(MaterialApp(
        home: PinGateScreen(pin: pin, onUnlocked: () => unlocked = true),
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), '9999');
      await tester.tap(find.widgetWithText(FilledButton, 'Unlock'));
      await tester.pumpAndSettle();

      expect(unlocked, isFalse);
      expect(find.textContaining('Try again in'), findsOneWidget);
      expect(find.textContaining('s.'), findsOneWidget);
      // Not the plain wrong-PIN copy, and not a raw exception/enum dump.
      expect(find.textContaining('Incorrect PIN'), findsNothing);
      expect(find.textContaining('PinVerifyStatus'), findsNothing);
    });
  });

  group('LoginScreen failure', () {
    testWidgets('surfaces the server\'s own message', (tester) async {
      final api = _FakeApi()..loginError = ApiException(401, 'Username or password is incorrect.');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: LoginScreen(api: api, connectivity: connectivity, onLoginSuccess: (_) async {}),
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.widgetWithText(TextField, 'Username'), 'tech1');
      await tester.enterText(find.widgetWithText(TextField, 'Password'), 'wrong');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(api.loginCalls, 1);
      expect(find.text('Username or password is incorrect.'), findsOneWidget);
    });
  });
}
