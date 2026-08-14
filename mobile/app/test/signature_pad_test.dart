import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/widgets/signature_pad.dart';

const _pngMagic = [137, 80, 78, 71, 13, 10, 26, 10];

// A Column gives its children LOOSE height constraints (it sizes itself to
// its children, rather than handing down a tight height the way Scaffold's
// body or a bare SizedBox(height: ...) would) -- exactly what lets the pad's
// own `Container(height: 160)` win, the same as it does sitting inside the
// real record editor's ListView. Only the width is fixed, to the value each
// test wants to probe.
Widget _harness(double width, SignaturePadController controller) => MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            SizedBox(width: width, child: SignaturePad(controller: controller, locked: false)),
          ],
        ),
      ),
    );

void main() {
  testWidgets('reports the pad\'s actual painted size on layout, not a fixed guess', (tester) async {
    final controller = SignaturePadController();
    expect(controller.paintedSize, isNull); // before any layout at all

    await tester.pumpWidget(_harness(800, controller));
    await tester.pumpAndSettle();

    // The pad's own Container is 160 tall regardless of its parent; width
    // follows the parent (800 here), minus its 1px border on each side.
    expect(controller.paintedSize, isNotNull);
    expect(controller.paintedSize!.width, closeTo(800, 4));
    expect(controller.paintedSize!.height, closeTo(160, 4));
  });

  testWidgets('a differently-sized parent reports a different painted size', (tester) async {
    final controller = SignaturePadController();
    await tester.pumpWidget(_harness(320, controller));
    await tester.pumpAndSettle();

    expect(controller.paintedSize!.width, closeTo(320, 4));
  });

  testWidgets(
      'exporting after a stroke near the right edge of a wide (800px) pad '
      'renders at the real painted size, with the stroke surviving into the pixels',
      (tester) async {
    final controller = SignaturePadController();
    await tester.pumpWidget(_harness(800, controller));
    await tester.pumpAndSettle();

    final gesture = await tester.startGesture(const Offset(780, 100));
    await gesture.moveBy(const Offset(-40, 0));
    await gesture.up();
    await tester.pumpAndSettle();

    expect(controller.isEmpty, isFalse);
    final paintedSize = controller.paintedSize!;

    // `Picture.toImage()`/`Image.toByteData()` are genuine engine-level
    // async work that plain `pumpAndSettle()` never waits for -- `runAsync`
    // is required here. Since `exportPng()` is called directly (not chained
    // onto a Future seeded outside this block), there's no zone-boundary
    // hazard to route around, unlike the full-screen sign flow tested in
    // record_editor_test.dart.
    await tester.runAsync(() async {
      final bytes = await controller.exportPng();
      expect(bytes.length, greaterThan(8));
      expect(bytes.sublist(0, 8), _pngMagic);

      // Pin the export GEOMETRY. A PNG-validity check alone is not enough
      // to catch a regression back to a fixed 600x200 canvas -- a clipped
      // or rescaled stroke still decodes to a perfectly valid (just wrong)
      // PNG. Decoding the real dimensions back out and comparing against
      // the pad's actual painted size is what makes a size regression fail
      // this test.
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final image = frame.image;
      expect(image.width.toDouble(), closeTo(paintedSize.width, 1));
      expect(image.height.toDouble(), closeTo(paintedSize.height, 1));

      // Pin the CONTENT too. The stroke was drawn at local x in [740, 780]
      // on a ~798-wide canvas -- squarely in the rightmost ~10%. A canvas
      // silently clipped or rescaled back to a fixed 600px width would
      // either drop that stroke entirely or paint it at the wrong
      // coordinates; scanning that exact band for a non-background pixel
      // catches both failure modes, not just "some PNG came out".
      final raw = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      expect(raw, isNotNull);
      final pixels = raw!.buffer.asUint8List();
      final bandStartX = (image.width * 0.9).floor();
      var foundInk = false;
      outer:
      for (var y = 0; y < image.height; y++) {
        for (var x = bandStartX; x < image.width; x++) {
          final i = (y * image.width + x) * 4;
          final r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
          // The background is opaque white (AppColors.paper); the stroke is
          // drawn in AppColors.ink, so any visibly non-white opaque pixel in
          // this band can only be the stroke.
          if (a > 0 && (r < 250 || g < 250 || b < 250)) {
            foundInk = true;
            break outer;
          }
        }
      }
      expect(
        foundInk,
        isTrue,
        reason: 'expected the stroke drawn near the right edge of the pad to survive into the exported PNG',
      );
    });
  });

  testWidgets('exportPng falls back to a fixed size when the pad was never laid out', (tester) async {
    final controller = SignaturePadController();
    controller.startStroke(const Offset(5, 5));
    controller.extendStroke(const Offset(20, 20));
    controller.endStroke();

    expect(controller.paintedSize, isNull);

    await tester.runAsync(() async {
      final bytes = await controller.exportPng();
      expect(bytes.length, greaterThan(8));
      expect(bytes.sublist(0, 8), _pngMagic);
    });
  });

  test('encodePngDataUri / decodePngDataUri round-trip, prefix included', () {
    final bytes = Uint8List.fromList(_pngMagic);
    final uri = encodePngDataUri(bytes);
    expect(uri, startsWith(pngDataUriPrefix));
    expect(decodePngDataUri(uri), bytes);
  });

  test('decodePngDataUri tolerates a bare base64 string with no prefix', () {
    final bytes = Uint8List.fromList(_pngMagic);
    final bare = base64Encode(bytes);
    expect(decodePngDataUri(bare), bytes);
  });
}
