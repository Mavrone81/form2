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
import 'package:pmrecords/screens/pin_setup.dart';
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
  Object? queueError;

  LoginResult? loginResult;
  Object? loginError;
  int loginCalls = 0;

  int logoutCalls = 0;
  Object? logoutError;

  Object? bundleError;
  Map<String, dynamic> bundleResult = const {'forms': <dynamic>[], 'skipped': <dynamic>[]};

  /// Every `sync` call's client_uuids, in call order -- what test (a) below
  /// (the cross-owner replay filter) asserts against.
  final List<List<String>> syncBatches = [];
  Map<String, SyncResult> syncResultsFor = const {};

  @override
  Future<List<dynamic>> queue() async {
    final err = queueError;
    if (err != null) throw err;
    return queueRows;
  }

  @override
  Future<LoginResult> login(String username, String password, {bool wantDeviceToken = false}) async {
    loginCalls++;
    final err = loginError;
    if (err != null) throw err;
    final result = loginResult!;
    // Mirrors the real client, which adopts a minted token immediately (see
    // ApiClient.login). Without this the "a non-technician's token is
    // dropped" assertions below would pass on a client that never held one
    // in the first place.
    if (result.deviceToken != null) setDeviceToken(result.deviceToken);
    return result;
  }

  @override
  Future<void> logout() async {
    logoutCalls++;
    final err = logoutError;
    if (err != null) throw err;
  }

  @override
  Future<Map<String, dynamic>> bundle() async {
    final err = bundleError;
    if (err != null) throw err;
    return bundleResult;
  }

  @override
  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    syncBatches.add(records.map((r) => r.clientUuid).toList());
    return records
        .map((r) => syncResultsFor[r.clientUuid] ?? SyncResult(clientUuid: r.clientUuid, submissionId: 1, state: 'pending_lead'))
        .toList();
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

/// A queue whose whole-batch replay always fails -- the shape SyncQueue
/// itself produces when the server refuses the batch outright (see its own
/// doc: every record stays queued).
class _FailingSyncQueue extends SyncQueue {
  _FailingSyncQueue(super.db, this.error);

  final Object error;

  @override
  Future<SyncReplayResult> replay(ApiClient api, {bool Function(LocalRecord record)? include}) async {
    throw error;
  }
}

Map<String, dynamic> _user({required String role, String username = 'tech1', String fullName = 'Tech One'}) =>
    {'id': 1, 'username': username, 'full_name': fullName, 'role': role, 'active': 1};

LocalRecord _record(String uuid, RecordStatus status, {String machineId = 'GEN-1', String? error}) => LocalRecord(
      clientUuid: uuid,
      formId: 7,
      frequency: 'Y',
      machineId: machineId,
      values: const {'field_a': 'Pass'},
      signaturePng: status == RecordStatus.draft ? '' : 'data:image/png;base64,abc',
      signedAt: status == RecordStatus.draft ? '' : '2026-08-14T10:00:00.000Z',
      status: status,
      error: error,
    );

/// Unlocks a [PinGateScreen] already on screen with [pinValue] and settles.
Future<void> _unlockPin(WidgetTester tester, String pinValue) async {
  await tester.enterText(find.byType(TextField), pinValue);
  await tester.tap(find.widgetWithText(FilledButton, 'Unlock'));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  group('AppShell role routing', () {
    testWidgets('technician unlocks via their own PIN then lands on records + forms entry', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician'));
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'tech1'); // matches the session's own username
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      // A technician with a session AND their own owned PIN always unlocks
      // via the PIN gate first -- see the Critical 1/2 fixes, which stopped
      // `_bootstrap` from ever routing a technician straight to home.
      expect(find.byType(PinGateScreen), findsOneWidget);
      await _unlockPin(tester, '1234');

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

  group('AppShell cold start: stranded-device fixes (Critical 1 + 2)', () {
    testWidgets('C2: a technician session with no PIN at all is routed to PIN setup, not home', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician'));
      final pin = PinLock(storage); // interrupted-first-time-setup: no PIN was ever set
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(PinSetupScreen), findsOneWidget);
      expect(find.byType(TechnicianHomeScreen), findsNothing);
    });

    testWidgets('C1: a technician session whose PIN belongs to a different (stale) owner is routed to PIN setup',
        (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician', username: 'tech1'));
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'other_tech'); // left behind by a previous technician
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(PinSetupScreen), findsOneWidget);
      expect(find.byType(PinGateScreen), findsNothing);
    });

    testWidgets('offline cold start with a stored session (unattributed PIN) shows the PIN gate', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'technician'));
      final pin = PinLock(storage);
      await pin.setPin('1234'); // no owner recorded -- treated as this technician's own
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

  group('PinGateScreen "sign in with password instead" (Critical 1 escape hatch)', () {
    testWidgets('is enabled online and invokes the callback', (tester) async {
      final storage = InMemorySecureStorage();
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'other_tech');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      var usedPassword = false;

      await tester.pumpWidget(MaterialApp(
        home: PinGateScreen(
          pin: pin,
          connectivity: connectivity,
          onUnlocked: () {},
          onUsePassword: () => usedPassword = true,
        ),
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(TextButton, 'Sign in with password instead'));
      await tester.pumpAndSettle();

      expect(usedPassword, isTrue);
    });

    testWidgets('is disabled offline and explains why', (tester) async {
      final storage = InMemorySecureStorage();
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'other_tech');
      final connectivity = _FakeConnectivity(false);
      addTearDown(connectivity.dispose);
      var usedPassword = false;

      await tester.pumpWidget(MaterialApp(
        home: PinGateScreen(
          pin: pin,
          connectivity: connectivity,
          onUnlocked: () {},
          onUsePassword: () => usedPassword = true,
        ),
      ));
      await tester.pumpAndSettle();

      final button = tester.widget<TextButton>(find.widgetWithText(TextButton, 'Sign in with password instead'));
      expect(button.onPressed, isNull);
      expect(find.textContaining('Needs a connection'), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, 'Sign in with password instead'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(usedPassword, isFalse);
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

  group('SyncBanner cross-owner replay filter (I3a)', () {
    testWidgets('a manual sync only replays the current user\'s own queued records', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      const mine = '11111111-1111-4111-8111-111111111111';
      const theirs = '22222222-2222-4222-8222-222222222222';
      await db.insertRecord(_record(mine, RecordStatus.queued));
      await db.setRecordOwner(mine, 'tech1');
      await db.insertRecord(_record(theirs, RecordStatus.queued));
      await db.setRecordOwner(theirs, 'tech2');

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      final syncQueue = SyncQueue(db); // the REAL queue -- exercising the real include filter

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(db: db, api: api, syncQueue: syncQueue, connectivity: connectivity, username: 'tech1'),
        ),
      ));
      await tester.pumpAndSettle();

      final state = tester.state<SyncBannerState>(find.byType(SyncBanner));
      await state.syncNow();
      await tester.pumpAndSettle();

      expect(api.syncBatches, [
        [mine],
      ]);
      final theirRecord = await db.getRecord(theirs);
      expect(theirRecord!.status, RecordStatus.queued); // untouched, never sent
      final myRecord = await db.getRecord(mine);
      expect(myRecord!.status, RecordStatus.synced);
    });
  });

  group('TechnicianHomeScreen foreign records (I3b)', () {
    testWidgets('a foreign ERROR record is absent from the list and not retryable, only counted', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      const foreignUuid = '44444444-4444-4444-8444-444444444444';
      await db.insertRecord(_record(foreignUuid, RecordStatus.error, machineId: 'OTHER-MACHINE', error: 'INVALID: bad'));
      await db.setRecordOwner(foreignUuid, 'other_tech');

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: TechnicianHomeScreen(
          api: api,
          db: db,
          connectivity: connectivity,
          syncQueue: SyncQueue(db),
          username: 'tech1',
          userFullName: 'Tech One',
        ),
      ));
      await tester.pumpAndSettle();

      // Not listed at all -- no ERROR chip, no machine id, nothing tappable.
      expect(find.text('ERROR'), findsNothing);
      expect(find.textContaining('OTHER-MACHINE'), findsNothing);
      // But still surfaced as a count so the technician knows it's there.
      expect(find.textContaining('belong to another technician'), findsOneWidget);
      expect(find.textContaining('hidden until they sign in'), findsOneWidget);
    });
  });

  group('AppShell sign-out (I3c/I3f)', () {
    testWidgets('clears the device token locally, calls the server once, and leaves PIN + records intact', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      const uuid = '55555555-5555-4555-8555-555555555555';
      await db.insertRecord(_record(uuid, RecordStatus.draft));
      await db.setRecordOwner(uuid, 'tech1');

      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(
        user: _user(role: 'technician'),
        deviceToken: 'tok-123',
        deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 1)).toIso8601String(),
      );
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'tech1');
      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();
      await _unlockPin(tester, '1234');
      expect(find.byType(TechnicianHomeScreen), findsOneWidget);

      await tester.tap(find.byTooltip('Sign out'));
      await tester.pumpAndSettle();

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(api.logoutCalls, 1);
      expect(await session.loadDeviceToken(), isNull);
      expect(api.deviceToken, isNull);
      // Survive sign-out: the PIN and every local record.
      expect(await pin.hasPin(), isTrue);
      expect(await db.getRecord(uuid), isNotNull);
    });

    testWidgets('a failing server logout still clears the session/device token locally and lands on login',
        (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(
        user: _user(role: 'technician'),
        deviceToken: 'tok-456',
        deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 1)).toIso8601String(),
      );
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'tech1');
      // logoutError previously sat unused in this fake -- exercised here so
      // a failed/timed-out server round trip (offline mid-tap, a 500, the
      // new request timeout, ...) is actually proven not to block a local
      // sign-out, not merely asserted by comment.
      final api = _FakeApi()..logoutError = ApiException(500, 'Internal error');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();
      await _unlockPin(tester, '1234');
      expect(find.byType(TechnicianHomeScreen), findsOneWidget);

      await tester.tap(find.byTooltip('Sign out'));
      await tester.pumpAndSettle();

      // The failed server call is not swallowed silently -- it was
      // attempted -- but it never blocks the local sign-out that follows.
      expect(api.logoutCalls, 1);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(await session.loadDeviceToken(), isNull);
      expect(api.deviceToken, isNull);
      expect(await pin.hasPin(), isTrue); // still survives
    });
  });

  group('AppShell login flow with a failing bundle refresh (I3d)', () {
    testWidgets('a throwing bundle() still lands on the technician home, with a visible notice', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      final pin = PinLock(storage); // fresh device: no PIN yet
      final api = _FakeApi()
        ..loginResult = LoginResult(
          user: _user(role: 'technician'),
          deviceToken: 'tok-abc',
          deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 1)).toIso8601String(),
        )
        ..bundleError = ApiException(500, 'Internal error');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(LoginScreen), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'Username'), 'tech1');
      await tester.enterText(find.widgetWithText(TextField, 'Password'), 'secret');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      // No PIN existed yet -- first-time setup runs before the bundle
      // refresh (and the home screen) is ever reached.
      expect(find.byType(PinSetupScreen), findsOneWidget);
      await tester.enterText(find.widgetWithText(TextField, 'New PIN'), '1234');
      await tester.enterText(find.widgetWithText(TextField, 'Confirm PIN'), '1234');
      await tester.tap(find.widgetWithText(FilledButton, 'Save PIN'));
      await tester.pumpAndSettle();

      expect(find.byType(TechnicianHomeScreen), findsOneWidget);
      expect(find.textContaining('Could not refresh forms'), findsOneWidget);
      expect(find.textContaining('Internal error'), findsOneWidget);
    });
  });

  // I3: a whole-batch failure leaves every record queued, so the count alone
  // says nothing about what happened. The reason belongs on screen.
  group('SyncBanner whole-batch failure (I3)', () {
    testWidgets('a server error shows its message inline, keeps the count, and never routes to auth', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_record('11111111-1111-4111-8111-111111111111', RecordStatus.queued));

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      var expiredCalls = 0;

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(
            db: db,
            api: api,
            syncQueue: _FailingSyncQueue(db, ApiException(500, 'Internal error')),
            connectivity: connectivity,
            username: 'tech1',
            onAuthExpired: () => expiredCalls++,
          ),
        ),
      ));
      await tester.pumpAndSettle();

      await tester.state<SyncBannerState>(find.byType(SyncBanner)).syncNow();
      await tester.pumpAndSettle();

      expect(find.textContaining('Sync failed: Internal error'), findsOneWidget);
      expect(find.textContaining('1 records waiting to sync'), findsOneWidget);
      expect(expiredCalls, 0);
      // The record itself is untouched -- still queued, ready for the next try.
      expect((await db.getRecord('11111111-1111-4111-8111-111111111111'))!.status, RecordStatus.queued);
    });

    testWidgets('a 401 routes through onAuthExpired and says so inline', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_record('11111111-1111-4111-8111-111111111111', RecordStatus.queued));

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      var expiredCalls = 0;

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(
            db: db,
            api: api,
            syncQueue: _FailingSyncQueue(db, ApiException(401, 'Invalid or expired device token.')),
            connectivity: connectivity,
            username: 'tech1',
            onAuthExpired: () => expiredCalls++,
          ),
        ),
      ));
      await tester.pumpAndSettle();

      await tester.state<SyncBannerState>(find.byType(SyncBanner)).syncNow();
      await tester.pumpAndSettle();

      expect(expiredCalls, 1);
      expect(find.textContaining('Session expired'), findsOneWidget);
      expect(find.textContaining('1 records waiting to sync'), findsOneWidget);
    });

    testWidgets('a timeout shows the timeout copy, not a bare failure', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      await db.insertRecord(_record('11111111-1111-4111-8111-111111111111', RecordStatus.queued));

      final api = _FakeApi();
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyncBanner(
            db: db,
            api: api,
            // Exactly what ApiClient turns a TimeoutException into.
            syncQueue: _FailingSyncQueue(db, ApiException(0, 'The request timed out. Check your connection and try again.')),
            connectivity: connectivity,
            username: 'tech1',
          ),
        ),
      ));
      await tester.pumpAndSettle();

      await tester.state<SyncBannerState>(find.byType(SyncBanner)).syncNow();
      await tester.pumpAndSettle();

      expect(find.textContaining('Sync failed: The request timed out'), findsOneWidget);
    });
  });

  group('AppShell session expiry (I2)', () {
    testWidgets('a 401 from the review queue lands the reviewer back on login, with the reason', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'team_leader', username: 'lead1', fullName: 'Lead One'));
      final pin = PinLock(storage);
      final api = _FakeApi()..queueError = ApiException(401, 'Sign in to continue.');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(ReviewQueueScreen), findsNothing);
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.textContaining('Session expired'), findsOneWidget);
    });

    testWidgets('an expired session is not a sign-out: the PIN and local records survive', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      const uuid = '66666666-6666-4666-8666-666666666666';
      await db.insertRecord(_record(uuid, RecordStatus.draft));
      await db.setRecordOwner(uuid, 'tech1');

      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      await session.save(user: _user(role: 'team_leader', username: 'lead1', fullName: 'Lead One'));
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'tech1');
      final api = _FakeApi()..queueError = ApiException(401, 'Sign in to continue.');
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(await pin.hasPin(), isTrue);
      expect(await db.getRecord(uuid), isNotNull);
    });
  });

  // I6a: the login call always asks for a device token (the role is unknown
  // until the response), but only a technician can use one -- the two
  // token-authed routes are the bundle and the offline sync queue.
  group('AppShell device-token scope by role (I6a)', () {
    testWidgets('a technician login stores the minted token', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      final pin = PinLock(storage);
      final api = _FakeApi()
        ..loginResult = LoginResult(
          user: _user(role: 'technician'),
          deviceToken: 'tok-tech',
          deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 30)).toIso8601String(),
        );
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      await tester.enterText(find.widgetWithText(TextField, 'Username'), 'tech1');
      await tester.enterText(find.widgetWithText(TextField, 'Password'), 'secret');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      // First-time PIN setup runs before home; the token is already stored
      // by then (it is persisted at login, not at PIN setup).
      expect(find.byType(PinSetupScreen), findsOneWidget);
      expect(await session.loadDeviceToken(), 'tok-tech');
      expect(api.deviceToken, 'tok-tech');
    });

    testWidgets('a team-leader login persists no token and drops it from the client immediately', (tester) async {
      final db = _newDb();
      addTearDown(db.close);
      final storage = InMemorySecureStorage();
      final session = SessionStore(storage);
      // A shared device: a technician was signed in here before, and their
      // token is still in storage. SessionStore.save deliberately leaves an
      // existing token alone when passed null, so this is exactly the case
      // that needs clearing outright rather than merely "not saving".
      await session.save(
        user: _user(role: 'technician'),
        deviceToken: 'previous-tech-token',
        deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 30)).toIso8601String(),
      );
      final pin = PinLock(storage);
      await pin.setPin('1234', owner: 'tech1');
      final api = _FakeApi()
        ..loginResult = LoginResult(
          user: _user(role: 'team_leader', username: 'lead1', fullName: 'Lead One'),
          deviceToken: 'tok-lead',
          deviceTokenExpiresAt: DateTime.now().add(const Duration(days: 30)).toIso8601String(),
        );
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: SyncQueue(db)),
      ));
      await tester.pumpAndSettle();

      // The technician's PIN gate is on screen; the lead takes the password
      // escape hatch, exactly as they would on a borrowed handset.
      expect(find.byType(PinGateScreen), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Sign in with password instead'));
      await tester.pumpAndSettle();

      await tester.enterText(find.widgetWithText(TextField, 'Username'), 'lead1');
      await tester.enterText(find.widgetWithText(TextField, 'Password'), 'secret');
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      expect(find.byType(ReviewQueueScreen), findsOneWidget);
      expect(await session.loadDeviceToken(), isNull,
          reason: 'a non-technician must never leave a bearer token in secure storage -- not even an inherited one');
      expect(await session.loadDeviceTokenExpiresAt(), isNull);
      expect(api.deviceToken, isNull, reason: 'the minted token must be dropped from the client too, unused');
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
      final connectivity = _FakeConnectivity(true);
      addTearDown(connectivity.dispose);
      await tester.pumpWidget(MaterialApp(
        home: PinGateScreen(
          pin: pin,
          connectivity: connectivity,
          onUnlocked: () => unlocked = true,
          onUsePassword: () {},
        ),
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
