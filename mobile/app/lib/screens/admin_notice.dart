import 'package:flutter/material.dart';

import '../widgets/app_colors.dart';

/// The whole of an admin's experience in this app: a plain notice that admin
/// work (user management, form catalog, etc.) happens on the web app, plus a
/// way back out. There is deliberately no admin functionality here to keep
/// in sync with the web app's own -- duplicating it would just be a second
/// place for it to drift out of date.
class AdminNoticeScreen extends StatelessWidget {
  const AdminNoticeScreen({super.key, this.onSignOut});

  final VoidCallback? onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(
        backgroundColor: AppColors.ink,
        foregroundColor: AppColors.paper,
        title: const Text('PM Records'),
        actions: [
          if (onSignOut != null)
            IconButton(icon: const Icon(Icons.logout), tooltip: 'Sign out', onPressed: onSignOut),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: const [
              Text(
                'Admin work happens on the web',
                style: TextStyle(color: AppColors.ink, fontSize: 17, fontWeight: FontWeight.w700),
              ),
              SizedBox(height: 8),
              Text(
                'User management and the form catalog are managed from the web app. '
                'This device app is for technicians recording maintenance and for '
                'team leaders/engineers reviewing records.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.mute, fontSize: 13),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
