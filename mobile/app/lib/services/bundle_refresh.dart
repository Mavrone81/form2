import 'dart:convert';

import '../api/client.dart';
import '../db/local_db.dart';

/// What one [refreshBundle] call did, for a caller that wants to show the
/// technician a short summary without re-querying [LocalDb] itself.
class BundleRefreshResult {
  BundleRefreshResult({required this.formCount, required this.skippedCount});

  final int formCount;
  final int skippedCount;
}

/// `GET /api/bundle` -> [LocalDb.replaceBundle], the one place that wiring
/// happens for the whole app: called after every successful online login,
/// and again from the technician home screen's manual refresh action.
///
/// `GET /bundle`'s own shape (see `server/routes.js`) is
/// `{generated_at, forms: [...], skipped: [...]}` -- each `forms[i]` is
/// already the exact JSON [FormBundle.fromJson] expects (a `form` object
/// carrying that form's own `id`, plus `fields`/`frequencies`/`tasks`), so
/// each entry is cached verbatim, keyed by its own `form.id`.
///
/// The response is a full snapshot of what the server offers, so it is
/// applied as one: forms present are upserted, and any form the device has
/// cached that is NOT in this response is dropped (see
/// [LocalDb.replaceBundle]). Without that, a form withdrawn or unmapped
/// server-side stayed on the device for ever and kept being offered as
/// something to start a record against.
///
/// `skipped` entries (a form the server could not READ this time) are the
/// one exception: they carry no bundle to cache, but their ids are passed to
/// `replaceBundle`'s `keep` so a transient server-side file problem does not
/// delete the copy this device already holds. They are counted for the
/// caller's notice exactly as before.
///
/// Throws whatever [ApiClient.bundle] throws (typically [ApiException])
/// BEFORE touching the database at all, so a failed refresh leaves the
/// cached bundle exactly as it was -- callers decide for themselves whether
/// that failure is fatal (it never is per the brief: "failures non-fatal
/// with a visible notice").
Future<BundleRefreshResult> refreshBundle(ApiClient api, LocalDb db) async {
  final data = await api.bundle();
  final forms = (data['forms'] as List?) ?? const [];
  final now = DateTime.now();
  final jsonByFormId = <int, String>{};
  for (final entry in forms) {
    if (entry is! Map) continue;
    final map = Map<String, dynamic>.from(entry);
    final formMeta = map['form'];
    if (formMeta is! Map) continue;
    final formId = _asFormId(formMeta['id']);
    if (formId == null) continue;
    jsonByFormId[formId] = jsonEncode(map);
  }
  final skipped = (data['skipped'] as List?) ?? const [];
  final keep = <int>{};
  for (final entry in skipped) {
    final id = _asFormId(entry is Map ? entry['id'] : null);
    if (id != null) keep.add(id);
  }
  await db.replaceBundle(jsonByFormId, keep: keep, fetchedAt: now);
  return BundleRefreshResult(formCount: jsonByFormId.length, skippedCount: skipped.length);
}

/// A form id from the wire, which may arrive as an int or as a string
/// depending on how it was serialised. `null` for anything that is neither.
int? _asFormId(Object? raw) {
  if (raw is int) return raw;
  if (raw == null) return null;
  return int.tryParse(raw.toString());
}
