import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';

/// Starts a real dart:io HttpServer on an ephemeral loopback port and hands
/// every request to [handler], which is responsible for writing and closing
/// the response. Using a real server (not a mocked http.Client) is
/// deliberate: it is the only way to prove ApiClient sends exactly the
/// headers and body the server contract requires, and parses exactly what a
/// real HTTP response looks like.
Future<HttpServer> _startServer(Future<void> Function(HttpRequest request) handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    await handler(request);
  });
  return server;
}

Future<Map<String, dynamic>> _readJsonBody(HttpRequest request) async {
  final raw = await utf8.decoder.bind(request).join();
  if (raw.isEmpty) return {};
  return jsonDecode(raw) as Map<String, dynamic>;
}

void _writeJson(HttpRequest request, int status, Object body, {String? setCookie}) {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  if (setCookie != null) request.response.headers.set('set-cookie', setCookie);
  request.response.write(jsonEncode(body));
}

String _baseUrlFor(HttpServer server) => 'http://${server.address.address}:${server.port}';

void main() {
  group('ApiClient.login', () {
    test('sends wantDeviceToken and parses the returned device token', () async {
      Map<String, dynamic>? received;
      final server = await _startServer((request) async {
        received = await _readJsonBody(request);
        _writeJson(
          request,
          200,
          {
            'id': 7,
            'username': 'tech1',
            'role': 'technician',
            'device_token': 'a' * 64,
            'device_token_expires_at': '2026-09-13T00:00:00.000Z',
          },
          setCookie: 'connect.sid=s%3Aabc123; Path=/; HttpOnly',
        );
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));
      final result = await client.login('tech1', 'secret', wantDeviceToken: true);

      expect(received!['username'], 'tech1');
      expect(received!['password'], 'secret');
      expect(received!['wantDeviceToken'], isTrue);

      expect(result.deviceToken, 'a' * 64);
      expect(result.deviceTokenExpiresAt, '2026-09-13T00:00:00.000Z');
      expect(result.user['username'], 'tech1');
      expect(result.user['role'], 'technician');
      expect(result.user.containsKey('device_token'), isFalse);
      expect(client.deviceToken, 'a' * 64);
    });

    test('a plain login (no wantDeviceToken) omits the flag and holds no device token', () async {
      Map<String, dynamic>? received;
      final server = await _startServer((request) async {
        received = await _readJsonBody(request);
        _writeJson(request, 200, {'id': 3, 'username': 'lead1', 'role': 'team_leader'});
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));
      final result = await client.login('lead1', 'secret');

      expect(received!.containsKey('wantDeviceToken'), isFalse);
      expect(result.deviceToken, isNull);
      expect(client.deviceToken, isNull);
    });
  });

  group('ApiClient.bundle authentication', () {
    test('sends the Bearer header when a device token is held', () async {
      String? authHeader;
      final server = await _startServer((request) async {
        authHeader = request.headers.value('authorization');
        _writeJson(request, 200, {'generated_at': 'now', 'forms': [], 'skipped': []});
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));
      client.setDeviceToken('deadbeef' * 8);
      final result = await client.bundle();

      expect(authHeader, 'Bearer ${'deadbeef' * 8}');
      expect(result['generated_at'], 'now');
    });

    test('sends the session cookie, and no Authorization header, when no token is held', () async {
      String? authHeader;
      String? cookieHeader;
      final loginServer = await _startServer((request) async {
        if (request.uri.path == '/login') {
          _writeJson(request, 200, {'id': 1, 'role': 'team_leader'}, setCookie: 'connect.sid=xyz789; Path=/');
        } else {
          authHeader = request.headers.value('authorization');
          cookieHeader = request.headers.value('cookie');
          _writeJson(request, 200, {'generated_at': 'now', 'forms': [], 'skipped': []});
        }
        await request.response.close();
      });
      addTearDown(loginServer.close);

      final client = ApiClient(baseUrl: _baseUrlFor(loginServer));
      await client.login('lead1', 'secret'); // no wantDeviceToken -> session cookie only
      await client.bundle();

      expect(authHeader, isNull);
      expect(cookieHeader, contains('connect.sid=xyz789'));
    });
  });

  group('ApiClient.sync', () {
    test('posts the exact record shape and parses per-record results', () async {
      Map<String, dynamic>? received;
      final server = await _startServer((request) async {
        received = await _readJsonBody(request);
        _writeJson(request, 200, {
          'results': [
            {'client_uuid': '11111111-1111-1111-1111-111111111111', 'submissionId': 42, 'state': 'pending_lead'},
            {
              'client_uuid': '22222222-2222-2222-2222-222222222222',
              'submissionId': null,
              'state': null,
              'error': {'code': 'INVALID', 'message': 'client_uuid must be a UUID.'},
            },
            // Replay of a rejected record: state carries the fact, no error.
            {'client_uuid': '33333333-3333-3333-3333-333333333333', 'submissionId': 9, 'state': 'rejected'},
          ],
        });
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));
      client.setDeviceToken('token123');
      final records = [
        SyncRecord(
          clientUuid: '11111111-1111-1111-1111-111111111111',
          formId: 5,
          frequency: '1M',
          machineId: 'GEN-1',
          values: {'field_a': 'Pass'},
          signaturePng: 'base64pngdata',
          signedAtDevice: '2026-08-14T10:00:00.000Z',
        ),
      ];

      final results = await client.sync(records);

      final sentRecords = received!['records'] as List;
      expect(sentRecords, hasLength(1));
      final sent = sentRecords.first as Map<String, dynamic>;
      expect(sent['client_uuid'], '11111111-1111-1111-1111-111111111111');
      expect(sent['formId'], 5);
      expect(sent['frequency'], '1M');
      expect(sent['machineId'], 'GEN-1');
      expect(sent['values'], {'field_a': 'Pass'});
      expect(sent['signaturePng'], 'base64pngdata');
      expect(sent['signedAtDevice'], '2026-08-14T10:00:00.000Z');

      expect(results, hasLength(3));

      expect(results[0].clientUuid, '11111111-1111-1111-1111-111111111111');
      expect(results[0].submissionId, 42);
      expect(results[0].state, 'pending_lead');
      expect(results[0].error, isNull);

      expect(results[1].submissionId, isNull);
      expect(results[1].state, isNull);
      expect(results[1].error, isNotNull);
      expect(results[1].error!.code, 'INVALID');
      expect(results[1].error!.message, 'client_uuid must be a UUID.');

      // Rejected replay: state present, error explicitly absent -- the app
      // must branch on `state`, not on "was there an error".
      expect(results[2].state, 'rejected');
      expect(results[2].submissionId, 9);
      expect(results[2].error, isNull);
    });
  });

  group('ApiClient error handling', () {
    test('a non-2xx response surfaces a typed ApiException with status and message', () async {
      final server = await _startServer((request) async {
        _writeJson(request, 401, {'error': 'Username or password is incorrect.'});
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));

      await expectLater(
        () => client.login('tech1', 'wrong'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 401)
              .having((e) => e.message, 'message', 'Username or password is incorrect.'),
        ),
      );
    });

    test('a 429 throttle response is also surfaced as ApiException', () async {
      final server = await _startServer((request) async {
        _writeJson(request, 429, {'error': 'Too many failed attempts. Please try again in 15 minutes.'});
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));

      await expectLater(
        () => client.login('tech1', 'wrong'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'statusCode', 429)),
      );
    });

    test('a 400 from sync surfaces ApiException (malformed request, not a per-record error)', () async {
      final server = await _startServer((request) async {
        _writeJson(request, 400, {'error': 'records must be an array.'});
        await request.response.close();
      });
      addTearDown(server.close);

      final client = ApiClient(baseUrl: _baseUrlFor(server));
      client.setDeviceToken('token123');

      await expectLater(
        () => client.sync([]),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 400)
              .having((e) => e.message, 'message', 'records must be an array.'),
        ),
      );
    });
  });

  group('ApiClient default base URL', () {
    test('defaults to the production API root when unset', () {
      final client = ApiClient();
      expect(client.baseUrl, 'https://eform.bevorasg.com/api');
    });
  });
}
