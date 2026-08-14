import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'api/client.dart';
import 'auth/pin.dart';
import 'auth/secure_storage.dart';
import 'auth/session.dart';
import 'db/local_db.dart';
import 'screens/admin_notice.dart';
import 'screens/login.dart';
import 'screens/pin_gate.dart';
import 'screens/pin_setup.dart';
import 'screens/review_queue.dart';
import 'screens/technician_home.dart';
import 'services/bundle_refresh.dart';
import 'services/connectivity_source.dart';
import 'sync/queue.dart';
import 'widgets/app_colors.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final api = ApiClient();
  final secureStorage = FlutterSecureStorageAdapter();
  final session = SessionStore(secureStorage);
  final pin = PinLock(secureStorage);
  final documentsDir = await getApplicationDocumentsDirectory();
  final db = LocalDb(databaseFactory: databaseFactory, path: '${documentsDir.path}/pmrecords.db');
  final syncQueue = SyncQueue(db);
  // Constructed exactly once here and threaded through every screen that
  // needs it -- see the brief's own "construct ONCE app-scoped and inject
  // everywhere" note on PlatformConnectivitySource.
  final connectivity = PlatformConnectivitySource();

  runApp(PmRecordsApp(
    api: api,
    db: db,
    session: session,
    pin: pin,
    connectivity: connectivity,
    syncQueue: syncQueue,
  ));
}

/// The monochrome document-control theme, ported from [AppColors] (itself a
/// 1:1 port of the web app's own palette -- see that file's doc) so the
/// phone and the browser read as the same product: white paper, near-black
/// ink, one accent (the red "stamp") reserved for things that need
/// attention.
final ThemeData pmRecordsTheme = ThemeData(
  useMaterial3: true,
  scaffoldBackgroundColor: AppColors.shell,
  colorScheme: const ColorScheme.light(
    primary: AppColors.ink,
    onPrimary: AppColors.paper,
    secondary: AppColors.ink,
    onSecondary: AppColors.paper,
    surface: AppColors.paper,
    onSurface: AppColors.ink,
    error: AppColors.stamp,
    onError: AppColors.paper,
  ),
  appBarTheme: const AppBarTheme(
    backgroundColor: AppColors.ink,
    foregroundColor: AppColors.paper,
    elevation: 0,
  ),
  textTheme: Typography.blackMountainView.apply(bodyColor: AppColors.ink, displayColor: AppColors.ink),
  inputDecorationTheme: const InputDecorationTheme(
    labelStyle: TextStyle(color: AppColors.mute),
    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.rule)),
    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: AppColors.ink, width: 2)),
  ),
);

class PmRecordsApp extends StatelessWidget {
  const PmRecordsApp({
    super.key,
    required this.api,
    required this.db,
    required this.session,
    required this.pin,
    required this.connectivity,
    required this.syncQueue,
  });

  final ApiClient api;
  final LocalDb db;
  final SessionStore session;
  final PinLock pin;
  final ConnectivitySource connectivity;
  final SyncQueue syncQueue;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PM Records',
      debugShowCheckedModeBanner: false,
      theme: pmRecordsTheme,
      home: AppShell(api: api, db: db, session: session, pin: pin, connectivity: connectivity, syncQueue: syncQueue),
    );
  }
}

enum _Stage { loading, login, pinSetup, pinGate, home }

/// The whole app's state machine: cold-start bootstrap, the login/PIN-setup/
/// PIN-gate sequence, role routing once signed in, and sign-out -- all in
/// one place so every transition between them is made exactly once, in
/// exactly one spot, rather than scattered across screens that each have to
/// agree independently on what "signed in" means.
///
/// Every dependency is a constructor parameter (never looked up globally),
/// so a test builds this directly with fakes/in-memory implementations --
/// same pattern the existing review/record-editor screens already use.
class AppShell extends StatefulWidget {
  const AppShell({
    super.key,
    required this.api,
    required this.db,
    required this.session,
    required this.pin,
    required this.connectivity,
    required this.syncQueue,
  });

  final ApiClient api;
  final LocalDb db;
  final SessionStore session;
  final PinLock pin;
  final ConnectivitySource connectivity;
  final SyncQueue syncQueue;

  @override
  State<AppShell> createState() => AppShellState();
}

class AppShellState extends State<AppShell> {
  _Stage _stage = _Stage.loading;
  Map<String, dynamic>? _user;
  String? _loginNotice;
  String? _bundleNotice;

  @override
  void initState() {
    super.initState();
    unawaited(_bootstrap());
  }

  Future<void> _bootstrap() async {
    final storedUser = await widget.session.loadUser();
    final token = await widget.session.loadDeviceToken();
    widget.api.setDeviceToken(token);

    if (storedUser == null) {
      setState(() {
        _stage = _Stage.login;
        _loginNotice = null;
      });
      return;
    }

    final expiresAtRaw = await widget.session.loadDeviceTokenExpiresAt();
    final expired = expiresAtRaw != null && (DateTime.tryParse(expiresAtRaw)?.isBefore(DateTime.now()) ?? false);

    // "full login when online and token expired" (see the brief): a stored
    // session whose device token has visibly expired, on a device that CAN
    // reach the server right now, is sent back through a full login rather
    // than the PIN gate -- there is no point unlocking into a session that
    // cannot talk to the server anyway. Offline, expiry can't be usefully
    // acted on either way, so it falls through to the PIN gate below same as
    // a still-valid token would.
    if (widget.connectivity.isOnline && expired) {
      setState(() {
        _stage = _Stage.login;
        _loginNotice = 'Your session has expired. Sign in again to continue.';
      });
      return;
    }

    _user = storedUser;
    final role = (storedUser['role'] ?? '').toString();
    if (role != 'technician') {
      setState(() => _stage = _Stage.home);
      return;
    }
    // Every technician cold start with a session goes through EITHER
    // pinSetup or pinGate -- never straight to home -- see `_needsPinSetup`'s
    // doc for the two failure modes this closes: an interrupted first-time
    // setup (session saved, PIN never actually set) and a stale PIN left
    // behind by a PREVIOUS technician on a shared device.
    final username = (storedUser['username'] ?? '').toString();
    if (await _needsPinSetup(username)) {
      setState(() => _stage = _Stage.pinSetup);
    } else {
      setState(() => _stage = _Stage.pinGate);
    }
  }

  /// True if [username] must go through [PinSetupScreen] before anything
  /// else -- shared by both [_bootstrap] and [_onLoginSuccess] so this
  /// decision is made exactly the same way regardless of which one asks.
  /// Two independent conditions force it:
  ///  - **no PIN exists on this device at all.** This is deliberately
  ///    checked on EVERY technician session, not only right after a fresh
  ///    login: a session that got persisted ([SessionStore.save]) but was
  ///    then interrupted before [PinLock.setPin] ever ran (app killed
  ///    between the two) used to fall through `_bootstrap` straight to
  ///    [TechnicianHomeScreen] on the next cold start -- a tokened session
  ///    and every local record behind no gate at all, and the technician
  ///    was never asked again. Gating on `hasPin()` itself, not merely on
  ///    "did a login just succeed", closes that regardless of where the
  ///    interruption happened.
  ///  - **a PIN exists but for a KNOWN different owner** (see
  ///    [PinLock.owner]) -- a previous technician's PIN left on a shared
  ///    device. Checked at `_bootstrap` too, not only at login: tech A signs
  ///    out, tech B logs in (their session is saved immediately, before
  ///    [PinSetupScreen] even opens) and the app is killed before B
  ///    completes setup -- the NEXT cold start must still recognise B's
  ///    session doesn't own the PIN sitting on this device, or B lands on
  ///    [PinGateScreen] with no way to ever satisfy it (A's PIN, which B
  ///    does not know) short of the "sign in with password instead" escape
  ///    hatch. An unattributed PIN (owner `null` -- set before this
  ///    bookkeeping existed) is treated as this technician's own; only a
  ///    KNOWN different owner forces a reset.
  Future<bool> _needsPinSetup(String username) async {
    if (!(await widget.pin.hasPin())) return true;
    final owner = await widget.pin.owner();
    return owner != null && owner != username;
  }

  Future<void> _onLoginSuccess(LoginResult result) async {
    await widget.session.save(
      user: result.user,
      deviceToken: result.deviceToken,
      deviceTokenExpiresAt: result.deviceTokenExpiresAt,
    );
    _user = result.user;
    final role = (result.user['role'] ?? '').toString();
    final username = (result.user['username'] ?? '').toString();
    if (role == 'technician' && await _needsPinSetup(username)) {
      setState(() => _stage = _Stage.pinSetup);
      return;
    }
    await _finishSignIn();
  }

  Future<void> _finishSignIn() async {
    final role = (_user?['role'] ?? '').toString();
    if (role == 'technician') {
      // Best-effort: a failed refresh is surfaced as a visible notice on the
      // technician home screen, never fatal to signing in (the brief: "on
      // each successful online login... failures non-fatal with a visible
      // notice").
      try {
        await refreshBundle(widget.api, widget.db);
        _bundleNotice = null;
      } catch (e) {
        _bundleNotice = 'Could not refresh forms: ${e is ApiException ? e.message : e.toString()}';
      }
    }
    if (!mounted) return;
    setState(() => _stage = _Stage.home);
  }

  Future<void> _signOut() async {
    if (widget.connectivity.isOnline) {
      try {
        await widget.api.logout(); // clears the cookie jar itself on success
      } catch (_) {
        // Best-effort server sign-out only -- see the brief: local sign-out
        // must succeed regardless of whether the server round trip does
        // (offline, a timeout, a 500, ...). The cookie jar still needs
        // forgetting locally even though the network call never confirmed
        // it server-side -- a later sign-in must not replay a stale cookie.
        widget.api.clearCookies();
      }
    } else {
      widget.api.clearCookies();
    }
    await widget.session.clear();
    widget.api.setDeviceToken(null);
    // PIN and local records deliberately survive a sign-out (see the
    // brief): only the session itself is cleared here. A different
    // technician signing in next is forced through PinSetupScreen instead
    // of silently reusing this PIN -- see `_needsPinSetup`.
    _user = null;
    _bundleNotice = null;
    _loginNotice = null;
    if (!mounted) return;
    setState(() => _stage = _Stage.login);
  }

  /// The PIN gate's escape hatch: abandons the PIN attempt entirely and
  /// goes straight to a full online login instead. This is what keeps a
  /// device from being a dead end when the PIN sitting on it isn't (or is
  /// no longer) this technician's own -- see `_needsPinSetup`'s doc for how
  /// that can happen even after this build's own fixes (an interruption
  /// mid-setup) -- and it is also simply the right way out of a lockout
  /// countdown a technician doesn't want to wait through.
  void _usePasswordInstead() {
    setState(() {
      _stage = _Stage.login;
      _loginNotice = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    switch (_stage) {
      case _Stage.loading:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case _Stage.login:
        return LoginScreen(
          api: widget.api,
          connectivity: widget.connectivity,
          notice: _loginNotice,
          onLoginSuccess: _onLoginSuccess,
        );
      case _Stage.pinSetup:
        return PinSetupScreen(
          pin: widget.pin,
          username: (_user?['username'] ?? '').toString(),
          onDone: _finishSignIn,
        );
      case _Stage.pinGate:
        return PinGateScreen(
          pin: widget.pin,
          connectivity: widget.connectivity,
          onUnlocked: () => setState(() => _stage = _Stage.home),
          onUsePassword: _usePasswordInstead,
        );
      case _Stage.home:
        return _buildHome();
    }
  }

  Widget _buildHome() {
    final user = _user;
    if (user == null) {
      // Defensive only -- reachable only if `_stage` were somehow set to
      // `home` without `_user` ever being populated, which none of the
      // transitions above do.
      return const Scaffold(body: Center(child: Text('Signed out')));
    }
    final role = (user['role'] ?? '').toString();
    final username = (user['username'] ?? '').toString();
    final fullName = (user['full_name'] ?? username).toString();

    switch (role) {
      case 'technician':
        return TechnicianHomeScreen(
          api: widget.api,
          db: widget.db,
          connectivity: widget.connectivity,
          syncQueue: widget.syncQueue,
          username: username,
          userFullName: fullName,
          onSignOut: _signOut,
          bundleNotice: _bundleNotice,
        );
      case 'team_leader':
      case 'engineer':
        return ReviewQueueScreen(api: widget.api, connectivity: widget.connectivity, onSignOut: _signOut);
      case 'admin':
        return AdminNoticeScreen(onSignOut: _signOut);
      default:
        return Scaffold(
          appBar: AppBar(title: const Text('PM Records')),
          body: Center(child: Text('This account\'s role ("$role") is not supported on this device.')),
        );
    }
  }
}
