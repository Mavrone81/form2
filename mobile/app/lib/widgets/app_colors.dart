import 'package:flutter/material.dart';

/// The monochrome document-control palette, ported 1:1 from the web app's
/// `:root` custom properties (see `web/css/app.css`) so the phone and the
/// browser read as the same product.
///
/// Every color here is fully opaque. Dimming an out-of-scope task row (or
/// any other "not right now" state) is done by swapping in [tint]/[tintInk]
/// -- a different, still fully-legible ink on a tinted paper -- never by
/// lowering opacity or fading text: this project's own user has reported
/// low-contrast text as a defect before, and the rule is not to repeat it.
class AppColors {
  const AppColors._();

  static const ink = Color(0xFF16181D);
  static const paper = Color(0xFFFFFFFF);
  static const shell = Color(0xFFE9EAED);
  static const rule = Color(0xFFC8CBD1);
  static const soft = Color(0xFFF4F5F7);
  static const mute = Color(0xFF6B7078);
  static const stamp = Color(0xFFB4232A);
  static const ok = Color(0xFF0F6E5C);

  /// Background and ink for a row that is present but out of the currently
  /// selected interval's scope -- readable, just visibly de-emphasised.
  static const tint = Color(0xFFEEF0F3);
  static const tintInk = Color(0xFF3D434B);
}
