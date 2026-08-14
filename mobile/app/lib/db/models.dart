import 'dart:convert';
import 'dart:math';

import '../api/client.dart' show SyncRecord;

/// Generates a lowercase, RFC-4122-shaped v4 UUID (36 chars, dashes
/// included) using [Random.secure] -- no `uuid` package needed for one
/// function. The version nibble is forced to `4` and the variant nibble to
/// one of `8`, `9`, `a`, `b` (the `10xx` variant bits), exactly like every
/// other v4 generator, so a server-side UUID column/validator never
/// distinguishes these from "real" ones.
String generateClientUuid() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant 10xx

  String hex(int start, int end) =>
      bytes.sublist(start, end).map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}

/// A local record's lifecycle. Transitions are deliberately one-directional
/// except for the two documented loops:
///  - `draft` -> `draft` (editing a not-yet-submitted record in place)
///  - `error` -> `queued` (retrying a record the server rejected at the
///    transport/validation level)
/// Every other pair -- most importantly `synced` -> anything -- is refused
/// by [isValidRecordTransition]; a synced record is a fact the server has
/// already accepted (or adjudicated, for `rejected`/`pending_lead`/etc, all
/// of which still count as "the server holds it" per the sync contract) and
/// must never be re-queued or silently edited on the device.
enum RecordStatus {
  draft,
  queued,
  synced,
  error;

  String get dbValue => name;

  static RecordStatus fromDbValue(String value) =>
      RecordStatus.values.firstWhere((s) => s.dbValue == value, orElse: () => throw ArgumentError('Unknown record status: $value'));
}

/// True if moving a record from [from] to [to] is a sensible lifecycle step.
/// Called from every write path in `LocalDb` that changes `status` on an
/// existing row -- never trust a caller to have checked this first.
bool isValidRecordTransition(RecordStatus from, RecordStatus to) {
  if (from == to) return from == RecordStatus.draft;
  switch (from) {
    case RecordStatus.draft:
      return to == RecordStatus.queued;
    case RecordStatus.queued:
      return to == RecordStatus.synced || to == RecordStatus.error;
    case RecordStatus.error:
      return to == RecordStatus.queued;
    case RecordStatus.synced:
      return false;
  }
}

/// Thrown by `LocalDb` whenever a caller asks for a status change that
/// [isValidRecordTransition] refuses -- e.g. `synced` -> `queued`.
class InvalidRecordTransition implements Exception {
  InvalidRecordTransition(this.from, this.to, this.clientUuid);

  final RecordStatus from;
  final RecordStatus to;
  final String clientUuid;

  @override
  String toString() => 'InvalidRecordTransition($clientUuid: ${from.dbValue} -> ${to.dbValue})';
}

/// One offline-recorded maintenance record, mirroring the `records` table
/// row-for-row. `values` is the decoded form-field map (stored as
/// `values_json` in SQL); `serverState` mirrors `SyncResult.state` once the
/// server has answered for this record (`pending_lead`, `rejected`,
/// `approved`, ...) -- distinct from [error], which is only ever populated
/// for the `error` status (a transport/validation failure, never a state the
/// server otherwise accepted).
class LocalRecord {
  LocalRecord({
    required this.clientUuid,
    required this.formId,
    required this.frequency,
    required this.machineId,
    required this.values,
    required this.signaturePng,
    required this.signedAt,
    required this.status,
    this.serverId,
    this.serverState,
    this.error,
  });

  final String clientUuid;
  final dynamic formId;
  final String frequency;
  final String machineId;
  final Map<String, dynamic> values;
  final String signaturePng;
  final String signedAt;
  final RecordStatus status;
  final int? serverId;
  final String? serverState;
  final String? error;

  LocalRecord copyWith({
    RecordStatus? status,
    int? serverId,
    String? serverState,
    String? error,
    bool clearError = false,
  }) {
    return LocalRecord(
      clientUuid: clientUuid,
      formId: formId,
      frequency: frequency,
      machineId: machineId,
      values: values,
      signaturePng: signaturePng,
      signedAt: signedAt,
      status: status ?? this.status,
      serverId: serverId ?? this.serverId,
      serverState: serverState ?? this.serverState,
      error: clearError ? null : (error ?? this.error),
    );
  }

  /// The exact shape `ApiClient.sync` expects for this record.
  SyncRecord toSyncRecord() => SyncRecord(
        clientUuid: clientUuid,
        formId: formId,
        frequency: frequency,
        machineId: machineId,
        values: values,
        signaturePng: signaturePng,
        signedAtDevice: signedAt,
      );

  Map<String, Object?> toDbMap() => {
        'client_uuid': clientUuid,
        'form_id': formId,
        'frequency': frequency,
        'machine_id': machineId,
        'values_json': jsonEncode(values),
        'signature_png': signaturePng,
        'signed_at': signedAt,
        'status': status.dbValue,
        'server_id': serverId,
        'server_state': serverState,
        'error': error,
      };

  factory LocalRecord.fromDbMap(Map<String, Object?> map) => LocalRecord(
        clientUuid: map['client_uuid'] as String,
        formId: map['form_id'],
        frequency: map['frequency'] as String,
        machineId: map['machine_id'] as String,
        values: Map<String, dynamic>.from(jsonDecode(map['values_json'] as String) as Map),
        signaturePng: map['signature_png'] as String,
        signedAt: map['signed_at'] as String,
        status: RecordStatus.fromDbValue(map['status'] as String),
        serverId: map['server_id'] as int?,
        serverState: map['server_state'] as String?,
        error: map['error'] as String?,
      );
}
