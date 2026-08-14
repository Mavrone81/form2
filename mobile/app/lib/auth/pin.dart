import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'secure_storage.dart';

/// The three shapes [PinLock.verify] can return. Kept as a discriminated
/// result rather than a bare bool so a caller can show honest copy -- "wrong
/// PIN, 2 attempts left" reads very differently from "locked for another 4
/// minutes", and a bool alone cannot carry that distinction.
enum PinVerifyStatus { ok, wrongPin, lockedOut }

class PinVerifyResult {
  const PinVerifyResult._(this.status, {this.remainingBeforeLock, this.lockedUntil});

  factory PinVerifyResult.ok() => const PinVerifyResult._(PinVerifyStatus.ok);

  factory PinVerifyResult.wrongPin(int remainingBeforeLock) =>
      PinVerifyResult._(PinVerifyStatus.wrongPin, remainingBeforeLock: remainingBeforeLock);

  factory PinVerifyResult.lockedOut(DateTime lockedUntil) =>
      PinVerifyResult._(PinVerifyStatus.lockedOut, lockedUntil: lockedUntil);

  final PinVerifyStatus status;

  /// Set only for [PinVerifyStatus.wrongPin]: attempts left before the
  /// initial 5-failure lockout triggers.
  final int? remainingBeforeLock;

  /// Set only for [PinVerifyStatus.lockedOut]: when the gate reopens.
  final DateTime? lockedUntil;

  bool get isOk => status == PinVerifyStatus.ok;
}

/// A device-local PIN gate, 4-6 digits, so a technician can reopen the app
/// while offline without a server round trip -- there is no connection to
/// check a password against out on the shop floor. Only a salted sha256 of
/// the PIN is ever persisted, never the PIN itself, mirroring the hashing
/// discipline `server/auth.js` already applies to passwords.
///
/// A 4-6 digit PIN is a 10^4-10^6 keyspace -- tiny next to a real password.
/// The server login this PIN substitutes for has its own throttle (see
/// `server/login-throttle.js`), so the local gate needs an equivalent:
/// **5 consecutive wrong PINs lock the gate for 30s.** If the very next
/// attempt after a cooldown is ALSO wrong, the lockout re-triggers
/// immediately (no fresh 5-attempt budget) at double the previous delay --
/// 60s, then 120s, ... capped at 30 minutes -- because a device that has
/// already shown a pattern of failures must not be free to keep trying
/// indefinitely just because 30 seconds passed. A correct PIN at any point
/// resets the counter and the lockout entirely.
///
/// Deliberately does NOT wipe any local data after N failures in this
/// version: the entire point of the offline PIN gate is that a technician's
/// queued-but-unsynced records live only on this device until the next
/// sync, so destroying local state on a guessed-wrong PIN would be strictly
/// worse than the problem it defends against. Escalating lockout is the
/// full defense for now -- a wipe policy is a deliberate non-goal here, not
/// an oversight to revisit casually.
class PinLock {
  PinLock(this._storage, {DateTime Function()? now}) : _now = now ?? DateTime.now;

  final SecureStorage _storage;
  final DateTime Function() _now;

  static const _hashKey = 'pin_hash';
  static const _saltKey = 'pin_salt';
  static const _failCountKey = 'pin_fail_count';
  static const _lockoutStageKey = 'pin_lockout_stage';
  static const _lockedUntilKey = 'pin_locked_until';

  static final RegExp _pinShape = RegExp(r'^\d{4,6}$');

  static const _attemptsBeforeLock = 5;
  static const _baseLockSeconds = 30;
  static const _maxLockSeconds = 30 * 60;

  /// A fresh random salt, hex-encoded. Generated with [Random.secure] (not
  /// the default PRNG) since it feeds a security-relevant hash, exactly as
  /// the server-side token/salt generation does.
  static String generateSalt({int bytes = 16}) {
    final rand = Random.secure();
    return List<int>.generate(bytes, (_) => rand.nextInt(256))
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  /// Pure function: salt and PIN in, hex sha256 out. Exposed statically (no
  /// storage involved) so hashing itself is directly testable.
  static String hashPin(String pin, String salt) => sha256.convert(utf8.encode('$salt:$pin')).toString();

  /// Fixed-time comparison of two hex hash strings: length check first (both
  /// are always 64-char sha256 hex here, but a mismatched length is itself
  /// not secret), then an XOR-fold over every code unit rather than
  /// short-circuiting on the first difference, so a wrong guess cannot be
  /// timed character-by-character.
  static bool _hashesMatch(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }

  /// Sets or replaces the device PIN. Throws [ArgumentError] for anything
  /// that is not 4-6 digits -- callers should validate in the UI before
  /// calling this, but the gate never trusts that alone. Also clears any
  /// attempt count / lockout: a newly-set PIN always starts with a clean
  /// slate.
  Future<void> setPin(String pin) async {
    if (!_pinShape.hasMatch(pin)) {
      throw ArgumentError('PIN must be 4 to 6 digits.');
    }
    final salt = generateSalt();
    final hash = hashPin(pin, salt);
    await _storage.write(_saltKey, salt);
    await _storage.write(_hashKey, hash);
    await _resetAttempts();
  }

  Future<bool> hasPin() async => (await _storage.read(_hashKey)) != null;

  /// Gates app open. Returns a [PinVerifyResult] so the caller can
  /// distinguish "wrong, N attempts left" from "locked until <time>" -- see
  /// the class doc for the full lockout policy. All attempt/lockout state
  /// is read fresh from [_storage] on every call (never cached on this
  /// instance), so it persists across a cold start where a new [PinLock] is
  /// constructed over the same underlying storage.
  ///
  /// During an active lockout the PIN is never even hashed and compared --
  /// a correct PIN is refused too, both because that is the policy and so a
  /// locked-out attempt cannot be timed to learn whether the guess was
  /// close.
  Future<PinVerifyResult> verify(String pin) async {
    final salt = await _storage.read(_saltKey);
    final hash = await _storage.read(_hashKey);
    if (salt == null || hash == null) return PinVerifyResult.wrongPin(_attemptsBeforeLock);

    final now = _now();
    final lockedUntil = await _readLockedUntil();
    if (lockedUntil != null && now.isBefore(lockedUntil)) {
      return PinVerifyResult.lockedOut(lockedUntil);
    }

    if (_hashesMatch(hashPin(pin, salt), hash)) {
      await _resetAttempts();
      return PinVerifyResult.ok();
    }

    final failCount = (await _readInt(_failCountKey)) + 1;
    final lockoutStage = await _readInt(_lockoutStageKey);

    // Still inside the initial 5-attempt budget: no lockout has ever
    // triggered yet (lockoutStage == 0) and this failure alone doesn't spend
    // the last of it.
    if (lockoutStage == 0 && failCount < _attemptsBeforeLock) {
      await _storage.write(_failCountKey, '$failCount');
      return PinVerifyResult.wrongPin(_attemptsBeforeLock - failCount);
    }

    // Either this is the 5th consecutive failure (first lockout), or a
    // lockout already happened before and this is the first wrong attempt
    // since its cooldown expired (immediate re-lock at the next tier).
    final nextStage = lockoutStage + 1;
    final delaySeconds = min(_baseLockSeconds * pow(2, nextStage - 1).toInt(), _maxLockSeconds);
    final until = now.add(Duration(seconds: delaySeconds));
    await _storage.write(_failCountKey, '0');
    await _storage.write(_lockoutStageKey, '$nextStage');
    await _storage.write(_lockedUntilKey, until.toIso8601String());
    return PinVerifyResult.lockedOut(until);
  }

  /// Bool-compatible convenience wrapper for call sites that only care
  /// pass/fail, not the reason why not.
  Future<bool> verifyBool(String pin) async => (await verify(pin)).isOk;

  Future<void> clear() async {
    await _storage.delete(_saltKey);
    await _storage.delete(_hashKey);
    await _resetAttempts();
  }

  Future<void> _resetAttempts() async {
    await _storage.delete(_failCountKey);
    await _storage.delete(_lockoutStageKey);
    await _storage.delete(_lockedUntilKey);
  }

  Future<int> _readInt(String key) async {
    final raw = await _storage.read(key);
    return raw == null ? 0 : int.parse(raw);
  }

  Future<DateTime?> _readLockedUntil() async {
    final raw = await _storage.read(_lockedUntilKey);
    if (raw == null) return null;
    return DateTime.parse(raw);
  }
}
