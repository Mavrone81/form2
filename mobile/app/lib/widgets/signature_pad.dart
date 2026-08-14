import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'app_colors.dart';

/// Owns one signature pad's in-progress strokes and renders them to PNG
/// bytes on demand -- no drawing package, just `dart:ui`'s own
/// `PictureRecorder` -> `Canvas` -> `Image.toByteData(format: png)` path.
///
/// A caller (the record editor) creates one of these, hands it to a
/// [SignaturePad], and calls [exportPng] when the technician taps
/// "Sign & queue".
class SignaturePadController extends ChangeNotifier {
  final List<List<Offset>> _strokes = [];

  List<List<Offset>> get strokes => List.unmodifiable(_strokes);

  bool get isEmpty => _strokes.isEmpty;

  void startStroke(Offset point) {
    _strokes.add([point]);
    notifyListeners();
  }

  void extendStroke(Offset point) {
    if (_strokes.isEmpty) return;
    _strokes.last.add(point);
    notifyListeners();
  }

  void endStroke() {
    // Nothing to close off -- a stroke is just the list of points already
    // recorded. Kept as an explicit method (rather than folding into
    // extendStroke) so the gesture callbacks below read as three distinct
    // moments: pan start, pan update, pan end.
  }

  void clear() {
    _strokes.clear();
    notifyListeners();
  }

  /// Renders every recorded stroke onto a white [size]-shaped canvas and
  /// returns the result as PNG bytes -- exactly what `LocalRecord.signaturePng`
  /// stores (base64-encoded by the caller).
  Future<Uint8List> exportPng({Size size = const Size(600, 200)}) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, size.width, size.height));
    canvas.drawRect(Rect.fromLTWH(0, 0, size.width, size.height), Paint()..color = AppColors.paper);

    final paint = Paint()
      ..color = AppColors.ink
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    for (final stroke in _strokes) {
      for (var i = 0; i < stroke.length - 1; i++) {
        canvas.drawLine(stroke[i], stroke[i + 1], paint);
      }
      // A tap with no drag is still a mark -- draw a dot so it isn't lost.
      if (stroke.length == 1) {
        canvas.drawCircle(stroke.first, paint.strokeWidth / 2, paint..style = PaintingStyle.fill);
        paint.style = PaintingStyle.stroke;
      }
    }

    final picture = recorder.endRecording();
    final image = await picture.toImage(size.width.round(), size.height.round());
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    return byteData!.buffer.asUint8List();
  }
}

class _StrokesPainter extends CustomPainter {
  const _StrokesPainter(this.strokes);

  final List<List<Offset>> strokes;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AppColors.ink
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    for (final stroke in strokes) {
      for (var i = 0; i < stroke.length - 1; i++) {
        canvas.drawLine(stroke[i], stroke[i + 1], paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _StrokesPainter oldDelegate) => oldDelegate.strokes != strokes;
}

/// A full-width draw pad: [GestureDetector] captures the strokes into
/// [controller], [CustomPaint] renders them. Once [locked], gestures are
/// ignored and no clear affordance is shown -- there is nothing left to
/// draw over a signature that has already been recorded.
class SignaturePad extends StatefulWidget {
  const SignaturePad({super.key, required this.controller, required this.locked});

  final SignaturePadController controller;
  final bool locked;

  @override
  State<SignaturePad> createState() => _SignaturePadState();
}

class _SignaturePadState extends State<SignaturePad> {
  @override
  Widget build(BuildContext context) {
    final pad = AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) => CustomPaint(
        painter: _StrokesPainter(widget.controller.strokes),
        child: const SizedBox.expand(),
      ),
    );

    return Container(
      height: 160,
      width: double.infinity,
      decoration: BoxDecoration(border: Border.all(color: AppColors.rule), color: AppColors.paper),
      child: widget.locked
          ? pad
          : GestureDetector(
              behavior: HitTestBehavior.opaque,
              onPanStart: (details) => widget.controller.startStroke(details.localPosition),
              onPanUpdate: (details) => widget.controller.extendStroke(details.localPosition),
              onPanEnd: (_) => widget.controller.endStroke(),
              child: pad,
            ),
    );
  }
}
