import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../services/connectivity_source.dart';
import '../widgets/app_colors.dart';

/// The only screen that ever calls [ApiClient.login]. Online username +
/// password only -- there is no offline path through here at all (see the
/// app shell's own bootstrap, which routes an offline cold start with a
/// stored session to the PIN gate instead, never here). [onLoginSuccess] is
/// awaited before this screen stops showing its spinner, so the caller's own
/// post-login work (persisting the session, first-time PIN setup, the
/// bundle refresh) can run to completion first.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.api,
    required this.connectivity,
    required this.onLoginSuccess,
    this.notice,
  });

  final ApiClient api;
  final ConnectivitySource connectivity;
  final Future<void> Function(LoginResult result) onLoginSuccess;

  /// Context-setting copy shown above the form -- e.g. "sign in for the
  /// first time needs a connection" (no stored session, offline) or "your
  /// session has expired" (a stored session whose device token has expired,
  /// while online). `null` shows a plain sign-in form with no extra copy.
  final String? notice;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  String? _error;
  late bool _online;
  StreamSubscription<bool>? _sub;

  @override
  void initState() {
    super.initState();
    _online = widget.connectivity.isOnline;
    _sub = widget.connectivity.onChange.listen((online) {
      if (!mounted) return;
      setState(() => _online = online);
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_online) {
      setState(() => _error = 'You need a connection to sign in.');
      return;
    }
    final username = _username.text.trim();
    final password = _password.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _error = 'Enter a username and password.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final result = await widget.api.login(username, password, wantDeviceToken: true);
      await widget.onLoginSuccess(result);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Could not sign in: $e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'PM Records',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.ink, fontSize: 24, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Sign in to continue',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.mute, fontSize: 13),
                  ),
                  const SizedBox(height: 24),
                  if (!_online) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: AppColors.tint, border: Border.all(color: AppColors.rule)),
                      child: const Text(
                        "You're offline. Signing in for the first time needs a connection.",
                        style: TextStyle(color: AppColors.stamp, fontSize: 12.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(height: 16),
                  ] else if (widget.notice != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: AppColors.tint, border: Border.all(color: AppColors.rule)),
                      child: Text(
                        widget.notice!,
                        style: const TextStyle(color: AppColors.ink, fontSize: 12.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],
                  TextField(
                    controller: _username,
                    enabled: !_submitting,
                    style: const TextStyle(color: AppColors.ink),
                    decoration: const InputDecoration(labelText: 'Username'),
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    enabled: !_submitting,
                    obscureText: true,
                    style: const TextStyle(color: AppColors.ink),
                    decoration: const InputDecoration(labelText: 'Password'),
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: const TextStyle(color: AppColors.stamp, fontSize: 12.5)),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: AppColors.ink, foregroundColor: AppColors.paper),
                    onPressed: _submitting ? null : _submit,
                    child: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.paper),
                          )
                        : const Text('Sign in'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
