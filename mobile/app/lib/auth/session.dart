import 'dart:convert';

import 'secure_storage.dart';

/// Persists what the app needs to resume a signed-in technician across a
/// cold start without a fresh login: the paired device's bearer token and
/// the last user JSON the server returned on login. A browser-style session
/// cookie is deliberately NOT persisted here -- [ApiClient] holds that only
/// for the lifetime of the process, same as a browser tab; a device that has
/// gone offline (or restarted) authenticates with the token instead, which
/// is exactly why the server issues one for this app in the first place.
class SessionStore {
  SessionStore(this._storage);

  final SecureStorage _storage;

  static const _tokenKey = 'device_token';
  static const _tokenExpiresKey = 'device_token_expires_at';
  static const _userKey = 'user_json';

  /// Stores the signed-in user and, when the login call minted one, the
  /// device token alongside it. `deviceToken: null` leaves any
  /// already-stored token untouched -- a plain re-login without
  /// `wantDeviceToken` must not silently erase a token this device already
  /// holds from a previous pairing.
  Future<void> save({
    required Map<String, dynamic> user,
    String? deviceToken,
    String? deviceTokenExpiresAt,
  }) async {
    await _storage.write(_userKey, jsonEncode(user));
    if (deviceToken != null) {
      await _storage.write(_tokenKey, deviceToken);
      await _storage.write(_tokenExpiresKey, deviceTokenExpiresAt);
    }
  }

  Future<Map<String, dynamic>?> loadUser() async {
    final raw = await _storage.read(_userKey);
    if (raw == null) return null;
    return Map<String, dynamic>.from(jsonDecode(raw) as Map);
  }

  Future<String?> loadDeviceToken() => _storage.read(_tokenKey);

  Future<String?> loadDeviceTokenExpiresAt() => _storage.read(_tokenExpiresKey);

  /// Full sign-out: forgets the user, the device token and its expiry.
  Future<void> clear() async {
    await _storage.delete(_userKey);
    await _storage.delete(_tokenKey);
    await _storage.delete(_tokenExpiresKey);
  }
}
