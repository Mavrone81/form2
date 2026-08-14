import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:pmrecords/services/bundle_refresh.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

LocalDb _newDb() => LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);

/// Serves one canned `GET /bundle` payload (or throws) -- no HTTP anywhere,
/// same fake style as the other suites in this directory.
class _FakeApi extends ApiClient {
  _FakeApi() : super(baseUrl: 'http://localhost');

  Map<String, dynamic> bundleResult = const {'forms': <dynamic>[], 'skipped': <dynamic>[]};
  Object? bundleError;
  int bundleCalls = 0;

  @override
  Future<Map<String, dynamic>> bundle() async {
    bundleCalls++;
    final err = bundleError;
    if (err != null) throw err;
    return bundleResult;
  }
}

/// One form's bundle entry, in the shape `server/routes.js` produces (a
/// `form` row plus the definition keys). Generic, invented content only.
Map<String, dynamic> _formEntry(int id, {String title = 'Generic PM form'}) => {
      'form': {'id': id, 'title': title, 'file_name': 'form-$id.xlsx', 'state': 'ready'},
      'fields': <dynamic>[],
      'frequencies': ['Y'],
      'tasks': <dynamic>[],
    };

LocalRecord _draft(String uuid, int formId) => LocalRecord(
      clientUuid: uuid,
      formId: formId,
      frequency: 'Y',
      machineId: 'GEN-1',
      values: const {'field_a': 'Pass'},
      signaturePng: '',
      signedAt: '',
      status: RecordStatus.draft,
    );

void main() {
  setUpAll(sqfliteFfiInit);

  group('refreshBundle', () {
    test('caches every form in the payload, keyed by its own form.id', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [_formEntry(1), _formEntry(2)],
          'skipped': <dynamic>[],
        };

      final result = await refreshBundle(api, db);

      expect(result.formCount, 2);
      expect(result.skippedCount, 0);
      final cached = jsonDecode((await db.getBundle(1))!['json'] as String) as Map;
      expect((cached['form'] as Map)['file_name'], 'form-1.xlsx');
      expect(await db.getBundle(2), isNotNull);
    });

    // I5: the payload is a snapshot of what the server offers, so a form that
    // has been withdrawn, made inactive or unmapped must stop being cached --
    // otherwise the device keeps offering it as something to start a record
    // against, for ever.
    test('a cached form absent from the next fetch disappears', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [_formEntry(1), _formEntry(2)],
          'skipped': <dynamic>[],
        };
      await refreshBundle(api, db);
      expect(await db.getBundle(2), isNotNull);

      api.bundleResult = {
        'forms': [_formEntry(1)],
        'skipped': <dynamic>[],
      };
      await refreshBundle(api, db);

      expect(await db.getBundle(1), isNotNull);
      expect(await db.getBundle(2), isNull,
          reason: 'a form the server no longer offers must not linger on the device');
      expect(await db.getAllBundles(), hasLength(1));
    });

    test('records referencing a dropped form are NOT deleted -- drafts survive', () async {
      final db = _newDb();
      addTearDown(db.close);
      const uuid = '11111111-1111-4111-8111-111111111111';
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [_formEntry(1), _formEntry(2)],
          'skipped': <dynamic>[],
        };
      await refreshBundle(api, db);
      await db.insertRecord(_draft(uuid, 2));

      api.bundleResult = {
        'forms': [_formEntry(1)],
        'skipped': <dynamic>[],
      };
      await refreshBundle(api, db);

      final record = await db.getRecord(uuid);
      expect(record, isNotNull,
          reason: 'work already done against a withdrawn form is still the technician`s work');
      expect(record!.formId, 2);
      expect(record.status, RecordStatus.draft);
      // It simply cannot be joined to a form definition any more -- which is
      // what stops a NEW record being started against it.
      expect(await db.getBundle(2), isNull);
    });

    test('a form the server could not READ this time is kept, not pruned', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [_formEntry(1), _formEntry(2)],
          'skipped': <dynamic>[],
        };
      await refreshBundle(api, db);

      // form 2 moved/corrupted server-side: it is `skipped`, not withdrawn.
      api.bundleResult = {
        'forms': [_formEntry(1)],
        'skipped': [
          {'id': 2, 'error': 'This form could not be read. Ask an admin to rescan.'},
        ],
      };
      final result = await refreshBundle(api, db);

      expect(result.skippedCount, 1);
      expect(await db.getBundle(2), isNotNull,
          reason: 'a transient server-side file problem must not take a form off the device');
    });

    test('a failed fetch throws before touching the cache at all', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [_formEntry(1)],
          'skipped': <dynamic>[],
        };
      await refreshBundle(api, db);

      api.bundleError = ApiException(500, 'Internal error');
      await expectLater(refreshBundle(api, db), throwsA(isA<ApiException>()));

      expect(await db.getBundle(1), isNotNull, reason: 'a refresh that never landed must not empty the cache');
    });

    test('an entry with no usable form id is skipped rather than crashing the refresh', () async {
      final db = _newDb();
      addTearDown(db.close);
      final api = _FakeApi()
        ..bundleResult = {
          'forms': [
            _formEntry(1),
            {'form': <String, dynamic>{}, 'fields': <dynamic>[]},
            {'not a form': true},
          ],
          'skipped': <dynamic>[],
        };

      final result = await refreshBundle(api, db);

      expect(result.formCount, 1);
      expect(await db.getBundle(1), isNotNull);
    });
  });
}
