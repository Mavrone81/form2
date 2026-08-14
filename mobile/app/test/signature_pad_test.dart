import 'dart:convert';
import 'dart:typed_data';

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

  testWidgets('exporting after a stroke near the right edge of a wide (800px) pad produces valid PNG bytes', (tester) async {
    final controller = SignaturePadController();
    await tester.pumpWidget(_harness(800, controller));
    await tester.pumpAndSettle();

    final gesture = await tester.startGesture(const Offset(780, 100));
    await gesture.moveBy(const Offset(-40, 0));
    await gesture.up();
    await tester.pumpAndSettle();

    expect(controller.isEmpty, isFalse);

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
