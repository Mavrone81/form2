import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'secure_storage.dart';

/// A device-local PIN gate, 4-6 digits, so a technician can reopen the app
/// while offline without a server round trip -- there is no connection to
/// check a password against out on the shop floor. Only a salted sha256 of
/// the PIN is ever persisted, never the PIN itself, mirroring the hashing
/// discipline `server/auth.js` already applies to passwords.
class PinLock {
  PinLock(this._storage);

  final SecureStorage _storage;

  static const _hashKey = 'pin_hash';
  static const _saltKey = 'pin_salt';
  static final RegExp _pinShape = RegExp(r'^\d{4,6}$');

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

  /// Sets or replaces the device PIN. Throws [ArgumentError] for anything
  /// that is not 4-6 digits -- callers should validate in the UI before
  /// calling this, but the gate never trusts that alone.
  Future<void> setPin(String pin) async {
    if (!_pinShape.hasMatch(pin)) {
      throw ArgumentError('PIN must be 4 to 6 digits.');
    }
    final salt = generateSalt();
    final hash = hashPin(pin, salt);
    await _storage.write(_saltKey, salt);
    await _storage.write(_hashKey, hash);
  }

  Future<bool> hasPin() async => (await _storage.read(_hashKey)) != null;

  /// Gates app open: true only if a PIN has been set AND the supplied PIN
  /// hashes to the stored value. False (never an exception) for "no PIN set
  /// yet" so a fresh install's offline-first screen can fail closed instead
  /// of crashing.
  Future<bool> verify(String pin) async {
    final salt = await _storage.read(_saltKey);
    final hash = await _storage.read(_hashKey);
    if (salt == null || hash == null) return false;
    return hashPin(pin, salt) == hash;
  }

  Future<void> clear() async {
    await _storage.delete(_saltKey);
    await _storage.delete(_hashKey);
  }
}
