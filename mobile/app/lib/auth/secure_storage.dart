import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Minimal async key-value contract for anything that must not live in
/// plain preferences: the device token, the signed-in user's JSON, and the
/// PIN's salted hash. Both [SessionStore] and [PinLock] depend on this
/// instead of `flutter_secure_storage` directly, so unit tests can supply
/// [InMemorySecureStorage] and never touch a platform channel.
abstract class SecureStorage {
  Future<void> write(String key, String? value);
  Future<String?> read(String key);
  Future<void> delete(String key);
}

/// A storage-interface fake for unit tests: same contract, held in a plain
/// [Map], no platform channel involved.
class InMemorySecureStorage implements SecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<void> write(String key, String? value) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

/// The production [SecureStorage]: backed by the OS keystore/keychain via
/// `flutter_secure_storage`.
class FlutterSecureStorageAdapter implements SecureStorage {
  FlutterSecureStorageAdapter([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<void> write(String key, String? value) => _storage.write(key: key, value: value);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}
