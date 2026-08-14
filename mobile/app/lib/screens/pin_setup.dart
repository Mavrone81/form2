import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/pin.dart';
import '../widgets/app_colors.dart';

/// First-time device PIN setup, shown exactly once: right after a
/// technician's first successful online login on this device, before the
/// bundle refresh or the records home. This is the ONE place in the app
/// allowed to call [PinLock.setPin] without first proving the current PIN
/// (see that method's own doc) -- there is no current PIN yet.
class PinSetupScreen extends StatefulWidget {
  const PinSetupScreen({super.key, required this.pin, required this.username, required this.onDone});

  final PinLock pin;

  /// Stamped as this PIN's owner (see [PinLock.setPin]'s `owner` param) --
  /// what lets a later sign-in on this same device by a DIFFERENT
  /// technician detect a stale PIN and force a fresh one, rather than
  /// silently gating them behind a PIN they never set and cannot know.
  final String username;

  final Future<void> Function() onDone;

  @override
  State<PinSetupScreen> createState() => _PinSetupScreenState();
}

class _PinSetupScreenState extends State<PinSetupScreen> {
  final _pinCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  String? _error;
  bool _saving = false;

  static final _digitsOnly = RegExp(r'^\d{4,6}$');

  @override
  void dispose() {
    _pinCtrl.dispose();
    _confirmCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final p = _pinCtrl.text.trim();
    final c = _confirmCtrl.text.trim();
    if (!_digitsOnly.hasMatch(p)) {
      setState(() => _error = 'PIN must be 4 to 6 digits.');
      return;
    }
    if (p != c) {
      setState(() => _error = 'PINs do not match.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    await widget.pin.setPin(p, owner: widget.username);
    if (!mounted) return;
    await widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.shell,
      appBar: AppBar(backgroundColor: AppColors.ink, foregroundColor: AppColors.paper, title: const Text('Set a device PIN')),
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
                    'This PIN unlocks the app on this device while offline. Choose 4 to 6 digits.',
                    style: TextStyle(color: AppColors.mute, fontSize: 13),
                  ),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _pinCtrl,
                    enabled: !_saving,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                    style: const TextStyle(color: AppColors.ink),
                    decoration: const InputDecoration(labelText: 'New PIN'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _confirmCtrl,
                    enabled: !_saving,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                    style: const TextStyle(color: AppColors.ink),
                    decoration: const InputDecoration(labelText: 'Confirm PIN'),
                    onSubmitted: (_) => _save(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: const TextStyle(color: AppColors.stamp, fontSize: 12.5)),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: AppColors.ink, foregroundColor: AppColors.paper),
                    onPressed: _saving ? null : _save,
                    child: const Text('Save PIN'),
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
