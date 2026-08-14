import 'dart:convert';

import 'package:flutter/material.dart';

import '../db/local_db.dart';
import '../db/models.dart';
import '../domain/bundle.dart';
import '../widgets/app_colors.dart';
import 'record_editor.dart';

/// The technician's entry point: every form whose bundle has been cached on
/// this device (from a prior `GET /api/bundle`, offline-ready). Tapping one
/// creates a brand-new draft record and opens it in [RecordEditorScreen] --
/// exactly the "tap -> create draft via LocalDb + open editor" flow from the
/// brief. Nothing here talks to the network; a form only appears once it has
/// been synced down at least once.
class FormsListScreen extends StatefulWidget {
  const FormsListScreen({super.key, required this.db, required this.username});

  final LocalDb db;

  /// The signed-in technician's username, stamped as this device's own
  /// `record_owners` entry for every draft this screen creates -- see
  /// `LocalDb`'s `record_owners` doc for why: it is what lets a later
  /// sign-out/sign-in of a DIFFERENT technician on the same device tell
  /// "my drafts" apart from "the previous technician's drafts" instead of
  /// silently mixing (and, worse, syncing) both under one identity.
  final String username;

  @override
  State<FormsListScreen> createState() => _FormsListScreenState();
}

class _FormsListScreenState extends State<FormsListScreen> {
  late Future<List<FormBundle>> _bundlesFuture;

  @override
  void initState() {
    super.initState();
    _bundlesFuture = _loadBundles();
  }

  Future<List<FormBundle>> _loadBundles() async {
    final rows = await widget.db.getAllBundles();
    final bundles = rows
        .map((row) => FormBundle.fromJson(jsonDecode(row['json'] as String) as Map<String, dynamic>))
        .toList();
    bundles.sort((a, b) => a.form.title.compareTo(b.form.title));
    return bundles;
  }

  Future<void> _startDraft(FormBundle bundle) async {
    final record = LocalRecord(
      clientUuid: generateClientUuid(),
      formId: bundle.form.id,
      frequency: '',
      machineId: '',
      values: const {},
      signaturePng: '',
      signedAt: '',
      status: RecordStatus.draft,
    );
    await widget.db.insertRecord(record);
    await widget.db.setRecordOwner(record.clientUuid, widget.username);
    if (!mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => RecordEditorScreen(db: widget.db, clientUuid: record.clientUuid)),
    );
    // A new draft (or a queue) may have been created by the screen just
    // popped -- nothing here depends on the list changing, so no reload is
    // needed; this form always starts a fresh draft on the next tap too.
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: const Text('Ready forms'),
      ),
      body: FutureBuilder<List<FormBundle>>(
        future: _bundlesFuture,
        builder: (context, snapshot) {
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final bundles = snapshot.data!;
          if (bundles.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No forms downloaded yet. Sync while online to fetch forms.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppColors.mute, fontSize: 13),
                ),
              ),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: bundles.length,
            separatorBuilder: (context, index) => const SizedBox(height: 8),
            itemBuilder: (context, i) {
              final bundle = bundles[i];
              return Material(
                color: AppColors.paper,
                child: InkWell(
                  onTap: () => _startDraft(bundle),
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(border: Border.all(color: AppColors.rule)),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          bundle.form.title,
                          style: const TextStyle(color: AppColors.ink, fontSize: 14, fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${bundle.form.docNumber} · rev ${bundle.form.revision}',
                          style: const TextStyle(color: AppColors.mute, fontSize: 11.5),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
