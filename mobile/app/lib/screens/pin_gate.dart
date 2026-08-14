import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/pin.dart';
import '../widgets/app_colors.dart';

/// Offline-capable device unlock: the technician's cold-start gate whenever
/// this device already holds a signed-in session (see the app shell's
/// bootstrap). Every outcome of [PinLock.verify] gets its own honest copy --
/// in particular [PinVerifyStatus.lockedOut] always renders a countdown
/// ("try again in Ns"), never a bare "wrong PIN"/exception-shaped message,
/// since that is a materially different situation for the technician to
/// understand (a mistake vs. a timed cooldown).
///
/// No live ticking clock here on purpose: recomputing the remaining seconds
/// happens only when the technician submits again (which re-calls
/// [PinLock.verify] and gets a freshly computed remainder against the SAME
/// `lockedUntil`) -- avoids a `Timer.periodic` this screen would otherwise
/// have to cancel precisely on every dispose path, for a cosmetic tick most
/// technicians won't be staring at anyway.
class PinGateScreen extends StatefulWidget {
  const PinGateScreen({super.key, required this.pin, required this.onUnlocked});

  final PinLock pin;
  final VoidCallback onUnlocked;

  @override
  State<PinGateScreen> createState() => _PinGateScreenState();
}

class _PinGateScreenState extends State<PinGateScreen> {
  final _ctrl = TextEditingController();
  String? _message;
  bool _submitting = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final pin = _ctrl.text.trim();
    setState(() => _submitting = true);
    final result = await widget.pin.verify(pin);
    _ctrl.clear();
    if (!mounted) return;
    switch (result.status) {
      case PinVerifyStatus.ok:
        widget.onUnlocked();
        return;
      case PinVerifyStatus.wrongPin:
        setState(() {
          _submitting = false;
          _message = 'Incorrect PIN. ${result.remainingBeforeLock} attempt(s) left before a cooldown.';
        });
        return;
      case PinVerifyStatus.lockedOut:
        final remainingMs = result.lockedUntil!.difference(DateTime.now()).inMilliseconds;
        final remainingSeconds = (remainingMs / 1000).ceil().clamp(1, 999999);
        setState(() {
          _submitting = false;
          _message = 'Too many attempts. Try again in ${remainingSeconds}s.';
        });
        return;
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
                    'Enter your device PIN',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.ink, fontSize: 20, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    "You're offline -- unlocking with your PIN keeps this device working.",
                    textAlign: TextAlign.center,
                    style: TextStyle(color: AppColors.mute, fontSize: 12.5),
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _ctrl,
                    enabled: !_submitting,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                    style: const TextStyle(color: AppColors.ink),
                    decoration: const InputDecoration(labelText: 'PIN'),
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_message != null) ...[
                    const SizedBox(height: 12),
                    Text(_message!, style: const TextStyle(color: AppColors.stamp, fontSize: 12.5)),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: AppColors.ink, foregroundColor: AppColors.paper),
                    onPressed: _submitting ? null : _submit,
                    child: const Text('Unlock'),
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
