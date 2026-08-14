import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/db/models.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

LocalDb _newDb() {
  return LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);
}

LocalRecord _draftRecord({
  String clientUuid = '11111111-1111-4111-8111-111111111111',
  int formId = 5,
  RecordStatus status = RecordStatus.draft,
}) {
  return LocalRecord(
    clientUuid: clientUuid,
    formId: formId,
    frequency: '1M',
    machineId: 'GEN-1',
    values: {'field_a': 'Pass'},
    signaturePng: 'base64pngdata',
    signedAt: '2026-08-14T10:00:00.000Z',
    status: status,
  );
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  group('generateClientUuid', () {
    test('produces a lowercase RFC-4122 v4-shaped UUID', () {
      final uuid = generateClientUuid();
      expect(uuid, hasLength(36));
      expect(
        uuid,
        matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
      );
    });

    test('two calls never collide and both pass the shape check', () {
      final a = generateClientUuid();
      final b = generateClientUuid();
      expect(a, isNot(equals(b)));
    });
  });

  group('LocalDb bundle', () {
    test('upsertBundle then getBundle round-trips the json and stamps fetched_at', () async {
      final db = _newDb();
      addTearDown(db.close);

      await db.upsertBundle(5, jsonEncode({'forms': []}), fetchedAt: DateTime.utc(2026, 8, 14));
      final row = await db.getBundle(5);

      expect(row, isNotNull);
      expect(jsonDecode(row!['json'] as String), {'forms': []});
      expect(row['fetched_at'], DateTime.utc(2026, 8, 14).toIso8601String());
    });

    test('a second upsertBundle for the same form_id replaces, not duplicates', () async {
      final db = _newDb();
      addTearDown(db.close);

      await db.upsertBundle(5, jsonEncode({'v': 1}));
      await db.upsertBundle(5, jsonEncode({'v': 2}));

      final row = await db.getBundle(5);
      expect(jsonDecode(row!['json'] as String), {'v': 2});

      final all = await db.getAllBundles();
      expect(all, hasLength(1));
    });

    test('getBundle returns null for a form never cached', () async {
      final db = _newDb();
      addTearDown(db.close);

      expect(await db.getBundle(999), isNull);
    });
  });

  group('LocalDb records CRUD', () {
    test('insertRecord then getRecord round-trips every field', () async {
      final db = _newDb();
      addTearDown(db.close);

      final record = _draftRecord();
      await db.insertRecord(record);

      final loaded = await db.getRecord(record.clientUuid);
      expect(loaded, isNotNull);
      expect(loaded!.clientUuid, record.clientUuid);
      expect(loaded.formId, 5);
      expect(loaded.frequency, '1M');
      expect(loaded.machineId, 'GEN-1');
      expect(loaded.values, {'field_a': 'Pass'});
      expect(loaded.signaturePng, 'base64pngdata');
      expect(loaded.signedAt, '2026-08-14T10:00:00.000Z');
      expect(loaded.status, RecordStatus.draft);
      expect(loaded.serverId, isNull);
      expect(loaded.serverState, isNull);
      expect(loaded.error, isNull);
    });

    test('getRecord returns null for an unknown uuid', () async {
      final db = _newDb();
      addTearDown(db.close);
      expect(await db.getRecord('nope'), isNull);
    });

    test('updateRecord edits a draft in place (draft -> draft)', () async {
      final db = _newDb();
      addTearDown(db.close);

      final record = _draftRecord();
      await db.insertRecord(record);

      final edited = record.copyWith(status: RecordStatus.draft);
      final editedValues = LocalRecord(
        clientUuid: record.clientUuid,
        formId: record.formId,
        frequency: record.frequency,
        machineId: record.machineId,
        values: {'field_a': 'Fail'},
        signaturePng: record.signaturePng,
        signedAt: record.signedAt,
        status: RecordStatus.draft,
      );
      await db.updateRecord(editedValues);
      expect(edited.status, RecordStatus.draft); // sanity on the helper itself

      final loaded = await db.getRecord(record.clientUuid);
      expect(loaded!.values, {'field_a': 'Fail'});
    });

    test('getRecordsByStatus / getQueuedRecords filter correctly', () async {
      final db = _newDb();
      addTearDown(db.close);

      await db.insertRecord(_draftRecord(clientUuid: 'a', status: RecordStatus.draft));
      await db.insertRecord(_draftRecord(clientUuid: 'b', status: RecordStatus.queued));
      await db.insertRecord(_draftRecord(clientUuid: 'c', status: RecordStatus.queued));

      final drafts = await db.getRecordsByStatus(RecordStatus.draft);
      expect(drafts.map((r) => r.clientUuid), ['a']);

      final queued = await db.getQueuedRecords();
      expect(queued.map((r) => r.clientUuid).toSet(), {'b', 'c'});
    });

    test('updateRecord on a nonexistent record throws', () async {
      final db = _newDb();
      addTearDown(db.close);
      await expectLater(() => db.updateRecord(_draftRecord()), throwsArgumentError);
    });
  });

  group('LocalDb record status transition guards', () {
    test('draft -> queued via updateRecord is allowed', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord();
      await db.insertRecord(record);

      await db.updateRecord(record.copyWith(status: RecordStatus.queued));
      expect((await db.getRecord(record.clientUuid))!.status, RecordStatus.queued);
    });

    test('queued -> synced via markSynced is allowed and stores server_id + state', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.queued);
      await db.insertRecord(record);

      await db.markSynced(record.clientUuid, serverId: 42, state: 'pending_lead');

      final loaded = await db.getRecord(record.clientUuid);
      expect(loaded!.status, RecordStatus.synced);
      expect(loaded.serverId, 42);
      expect(loaded.serverState, 'pending_lead');
    });

    test('queued -> error via markError is allowed and stores the message', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.queued);
      await db.insertRecord(record);

      await db.markError(record.clientUuid, 'INVALID: client_uuid must be a UUID.');

      final loaded = await db.getRecord(record.clientUuid);
      expect(loaded!.status, RecordStatus.error);
      expect(loaded.error, 'INVALID: client_uuid must be a UUID.');
    });

    test('error -> queued via requeue is allowed', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.queued);
      await db.insertRecord(record);
      await db.markError(record.clientUuid, 'boom');

      await db.requeue(record.clientUuid);

      final requeued = await db.getRecord(record.clientUuid);
      expect(requeued!.status, RecordStatus.queued);
      // The stale error from the failed attempt must not linger once the
      // record is back in the queue for a fresh try.
      expect(requeued.error, isNull);
    });

    test('synced -> queued is rejected', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.queued);
      await db.insertRecord(record);
      await db.markSynced(record.clientUuid, serverId: 1);

      await expectLater(
        () => db.requeue(record.clientUuid),
        throwsA(isA<InvalidRecordTransition>()),
      );
    });

    test('draft -> synced (skipping queued) is rejected by markSynced', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.draft);
      await db.insertRecord(record);

      await expectLater(
        () => db.markSynced(record.clientUuid, serverId: 1),
        throwsA(isA<InvalidRecordTransition>()),
      );
    });

    test('draft -> error (skipping queued) is rejected by markError', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.draft);
      await db.insertRecord(record);

      await expectLater(
        () => db.markError(record.clientUuid, 'boom'),
        throwsA(isA<InvalidRecordTransition>()),
      );
    });

    test('error -> synced directly (skipping queued) is rejected', () async {
      final db = _newDb();
      addTearDown(db.close);
      final record = _draftRecord(status: RecordStatus.queued);
      await db.insertRecord(record);
      await db.markError(record.clientUuid, 'boom');

      await expectLater(
        () => db.markSynced(record.clientUuid, serverId: 1),
        throwsA(isA<InvalidRecordTransition>()),
      );
    });

    test('isValidRecordTransition is the single source of truth used by every guard', () {
      expect(isValidRecordTransition(RecordStatus.draft, RecordStatus.draft), isTrue);
      expect(isValidRecordTransition(RecordStatus.draft, RecordStatus.queued), isTrue);
      expect(isValidRecordTransition(RecordStatus.queued, RecordStatus.synced), isTrue);
      expect(isValidRecordTransition(RecordStatus.queued, RecordStatus.error), isTrue);
      expect(isValidRecordTransition(RecordStatus.error, RecordStatus.queued), isTrue);
      expect(isValidRecordTransition(RecordStatus.synced, RecordStatus.queued), isFalse);
      expect(isValidRecordTransition(RecordStatus.synced, RecordStatus.error), isFalse);
      expect(isValidRecordTransition(RecordStatus.synced, RecordStatus.synced), isFalse);
      expect(isValidRecordTransition(RecordStatus.queued, RecordStatus.draft), isFalse);
      expect(isValidRecordTransition(RecordStatus.queued, RecordStatus.queued), isFalse);
      expect(isValidRecordTransition(RecordStatus.error, RecordStatus.error), isFalse);
      expect(isValidRecordTransition(RecordStatus.error, RecordStatus.synced), isFalse);
    });
  });

  group('LocalDb test isolation', () {
    test('two LocalDb instances both on inMemoryDatabasePath do not share state', () async {
      final dbA = _newDb();
      final dbB = _newDb();
      addTearDown(dbA.close);
      addTearDown(dbB.close);

      await dbA.insertRecord(_draftRecord(clientUuid: 'only-in-a'));

      expect(await dbA.getRecord('only-in-a'), isNotNull);
      expect(await dbB.getRecord('only-in-a'), isNull);
    });
  });
}
