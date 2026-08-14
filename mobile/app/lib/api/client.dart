import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// A non-2xx response from the server, carrying the HTTP status and the
/// server's own `{error: "..."}` message verbatim -- never a generic
/// "something went wrong", so a caller can show the technician exactly what
/// the server said (a throttle message, a permission message, etc).
class ApiException implements Exception {
  ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// The result of a successful `POST /api/login`. `user` is every field the
/// server returned except the two device-token fields, which are split out
/// here so a caller never has to know the server flattens them into the
/// same JSON object.
class LoginResult {
  LoginResult({required this.user, this.deviceToken, this.deviceTokenExpiresAt});

  final Map<String, dynamic> user;
  final String? deviceToken;
  final String? deviceTokenExpiresAt;
}

/// One offline-recorded record, exactly the shape `POST /api/sync` expects
/// in its `records` array.
class SyncRecord {
  SyncRecord({
    required this.clientUuid,
    required this.formId,
    required this.frequency,
    required this.machineId,
    required this.values,
    required this.signaturePng,
    required this.signedAtDevice,
  });

  final String clientUuid;
  final dynamic formId;
  final String frequency;
  final String machineId;
  final Map<String, dynamic> values;
  final String signaturePng;
  final String signedAtDevice;

  Map<String, dynamic> toJson() => {
        'client_uuid': clientUuid,
        'formId': formId,
        'frequency': frequency,
        'machineId': machineId,
        'values': values,
        'signaturePng': signaturePng,
        'signedAtDevice': signedAtDevice,
      };
}

/// A sync record's own `{code, message}` failure -- FORBIDDEN, NOT_FOUND,
/// INVALID, or the generic ERROR. Absent (null on [SyncResult]) both for
/// success AND for the "replay of a rejected record" case, which the server
/// answers with `state: 'rejected'` and no `error` at all -- callers must
/// inspect `state`, not just "was there an error", to tell those apart.
class SyncRecordError {
  SyncRecordError(this.code, this.message);

  final String code;
  final String message;
}

class SyncResult {
  SyncResult({required this.clientUuid, this.submissionId, this.state, this.error});

  final String clientUuid;
  final int? submissionId;
  final String? state;
  final SyncRecordError? error;
}

/// Talks to the PM Records server. Two authentication modes travel together
/// on every request this client makes, because the server itself decides
/// per-route which one it honours:
///  - a session cookie, captured from `Set-Cookie` on any response and
///    replayed on every later request (the browser-session-shaped routes:
///    the submissions queue/detail/sign/reject/pdf);
///  - a device bearer token, sent as `Authorization: Bearer <token>` once
///    [setDeviceToken] (or a `wantDeviceToken` login) has set one (the
///    device-shaped routes: bundle, sync).
/// Sending both costs nothing on a route that only reads one of them.
///
/// `baseUrl` and `httpClient` are both constructor parameters specifically
/// so a test can point this at a local `dart:io` HttpServer instead of the
/// real deployment.
class ApiClient {
  ApiClient({
    String baseUrl = 'https://eform.bevorasg.com/api',
    http.Client? httpClient,
  })  : baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        _client = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  String? _deviceToken;
  final Map<String, String> _cookies = {};

  String? get deviceToken => _deviceToken;

  /// Adopts a device token minted by a previous login (or restored from
  /// [SessionStore] on a cold start). Passing `null` forgets it.
  void setDeviceToken(String? token) => _deviceToken = token;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> _headers({bool withBody = false}) {
    final headers = <String, String>{};
    if (withBody) headers['Content-Type'] = 'application/json';
    if (_cookies.isNotEmpty) {
      headers['Cookie'] = _cookies.entries.map((e) => '${e.key}=${e.value}').join('; ');
    }
    final token = _deviceToken;
    if (token != null) headers['Authorization'] = 'Bearer $token';
    return headers;
  }

  // Set-Cookie can legally appear as several headers on one response;
  // dart:io/package:http fold those into one string joined by ",". A cookie
  // value itself never contains a comma, so splitting on "," and taking the
  // "name=value" crumb before the first ";" of each piece recovers every
  // cookie safely -- the one attribute that CAN contain a comma (Expires)
  // is discarded here anyway, since this jar only ever needs the pair to
  // replay on the next request, not the attributes.
  void _captureCookies(http.Response response) {
    final raw = response.headers['set-cookie'];
    if (raw == null) return;
    for (final part in raw.split(',')) {
      final crumb = part.split(';').first.trim();
      final eq = crumb.indexOf('=');
      if (eq <= 0) continue;
      final name = crumb.substring(0, eq).trim();
      final value = crumb.substring(eq + 1).trim();
      if (name.isEmpty) continue;
      _cookies[name] = value;
    }
  }

  String _extractErrorMessage(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded['error'] is String) return decoded['error'] as String;
    } catch (_) {
      // Body wasn't JSON (or wasn't the expected shape) -- fall through to
      // the raw body below, still better than swallowing the message.
    }
    return body;
  }

  /// Decodes a JSON response body, or throws [ApiException] for any
  /// non-2xx status -- the one place every method below funnels through, so
  /// "surface a typed exception with the server's own message" only has to
  /// be right once.
  dynamic _decodeOrThrow(http.Response response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(response.statusCode, _extractErrorMessage(response.body));
    }
    if (response.body.isEmpty) return null;
    return jsonDecode(response.body);
  }

  Future<LoginResult> login(String username, String password, {bool wantDeviceToken = false}) async {
    final response = await _client.post(
      _uri('/login'),
      headers: _headers(withBody: true),
      body: jsonEncode({
        'username': username,
        'password': password,
        if (wantDeviceToken) 'wantDeviceToken': true,
      }),
    );
    _captureCookies(response);
    final body = Map<String, dynamic>.from(_decodeOrThrow(response) as Map);
    final token = body.remove('device_token') as String?;
    final expiresAt = body.remove('device_token_expires_at') as String?;
    if (token != null) _deviceToken = token;
    return LoginResult(user: body, deviceToken: token, deviceTokenExpiresAt: expiresAt);
  }

  /// Best-effort server-side sign-out: destroys the session this client's
  /// cookie jar is holding. Deliberately does NOT touch [_deviceToken] --
  /// that is a separate credential the device keeps for its own later
  /// syncing, and this call has no opinion on it; a caller that wants the
  /// token forgotten too (a full local sign-out) clears [SessionStore] and
  /// calls [setDeviceToken] `null` itself, same as sign-in never assumes a
  /// server round trip either.
  Future<void> logout() async {
    final response = await _client.post(_uri('/logout'), headers: _headers());
    _captureCookies(response);
    _decodeOrThrow(response);
  }

  Future<Map<String, dynamic>> bundle() async {
    final response = await _client.get(_uri('/bundle'), headers: _headers());
    _captureCookies(response);
    return Map<String, dynamic>.from(_decodeOrThrow(response) as Map);
  }

  Future<List<SyncResult>> sync(List<SyncRecord> records) async {
    final response = await _client.post(
      _uri('/sync'),
      headers: _headers(withBody: true),
      body: jsonEncode({'records': records.map((r) => r.toJson()).toList()}),
    );
    _captureCookies(response);
    final body = _decodeOrThrow(response) as Map;
    final results = (body['results'] as List).cast<Map<String, dynamic>>();
    return results.map((r) {
      final errorMap = r['error'] as Map<String, dynamic>?;
      return SyncResult(
        clientUuid: r['client_uuid'] as String,
        submissionId: r['submissionId'] as int?,
        state: r['state'] as String?,
        error: errorMap == null ? null : SyncRecordError(errorMap['code'] as String, errorMap['message'] as String),
      );
    }).toList();
  }

  Future<List<dynamic>> queue() async {
    final response = await _client.get(_uri('/submissions'), headers: _headers());
    _captureCookies(response);
    return _decodeOrThrow(response) as List;
  }

  Future<Map<String, dynamic>> submission(int id) async {
    final response = await _client.get(_uri('/submissions/$id'), headers: _headers());
    _captureCookies(response);
    return Map<String, dynamic>.from(_decodeOrThrow(response) as Map);
  }

  Future<Map<String, dynamic>> sign(int id, String signaturePng) async {
    final response = await _client.post(
      _uri('/submissions/$id/sign'),
      headers: _headers(withBody: true),
      body: jsonEncode({'signaturePng': signaturePng}),
    );
    _captureCookies(response);
    return Map<String, dynamic>.from(_decodeOrThrow(response) as Map);
  }

  Future<Map<String, dynamic>> reject(int id, String reason) async {
    final response = await _client.post(
      _uri('/submissions/$id/reject'),
      headers: _headers(withBody: true),
      body: jsonEncode({'reason': reason}),
    );
    _captureCookies(response);
    return Map<String, dynamic>.from(_decodeOrThrow(response) as Map);
  }

  /// Raw PDF bytes. Handled separately from [_decodeOrThrow] because a
  /// successful response here is never JSON -- only a failure is.
  Future<Uint8List> pdf(int id) async {
    final response = await _client.get(_uri('/submissions/$id/pdf'), headers: _headers());
    _captureCookies(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(response.statusCode, _extractErrorMessage(response.body));
    }
    return response.bodyBytes;
  }
}
