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

/// `GET /api/bundle` -> [LocalDb.upsertBundle] per ready form, the one place
/// that wiring happens for the whole app: called after every successful
/// online login, and again from the technician home screen's manual refresh
/// action.
///
/// `GET /bundle`'s own shape (see `server/routes.js`) is
/// `{generated_at, forms: [...], skipped: [...]}` -- each `forms[i]` is
/// already the exact JSON [FormBundle.fromJson] expects (a `form` object
/// carrying that form's own `id`, plus `fields`/`frequencies`/`tasks`), so
/// each entry is cached verbatim, keyed by its own `form.id`. `skipped`
/// entries (a form the server could not read) carry no bundle to cache and
/// are simply counted, not stored.
///
/// Throws whatever [ApiClient.bundle] throws (typically [ApiException]) --
/// callers decide for themselves whether that failure is fatal (it never is
/// per the brief: "failures non-fatal with a visible notice").
Future<BundleRefreshResult> refreshBundle(ApiClient api, LocalDb db) async {
  final data = await api.bundle();
  final forms = (data['forms'] as List?) ?? const [];
  final now = DateTime.now();
  var formCount = 0;
  for (final entry in forms) {
    if (entry is! Map) continue;
    final map = Map<String, dynamic>.from(entry);
    final formMeta = map['form'];
    if (formMeta is! Map) continue;
    final rawId = formMeta['id'];
    final formId = rawId is int ? rawId : int.tryParse(rawId?.toString() ?? '');
    if (formId == null) continue;
    await db.upsertBundle(formId, jsonEncode(map), fetchedAt: now);
    formCount++;
  }
  final skipped = (data['skipped'] as List?) ?? const [];
  return BundleRefreshResult(formCount: formCount, skippedCount: skipped.length);
}
