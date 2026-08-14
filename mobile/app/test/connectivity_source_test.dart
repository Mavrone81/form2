import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/services/connectivity_source.dart';

// `Connectivity` itself is a private-constructor, factory-returned singleton
// wired to a real platform channel -- it cannot be subclassed or given a
// second, fake-backed instance. [PlatformConnectivitySource] instead exposes
// its one-shot `checkConnectivity()` result and its `onConnectivityChanged`
// stream as independently injectable constructor parameters, so these tests
// drive exactly those two inputs directly -- no platform channel, no fake
// plugin, involved at all.

void main() {
  group('PlatformConnectivitySource', () {
    test(
      'a device already offline before the initial check resolves corrects isOnline AND '
      'emits false on onChange -- not just updating isOnline silently',
      () async {
        final source = PlatformConnectivitySource(
          initialCheck: Future.value(const [ConnectivityResult.none]),
          changes: const Stream<List<ConnectivityResult>>.empty(),
        );
        addTearDown(source.dispose);

        // The optimistic default, read synchronously before the injected
        // check has had a chance to resolve.
        expect(source.isOnline, isTrue);

        // The only way this test's `changes` stream (empty, forever) can
        // ever produce an event is the initial-check correction itself --
        // proving the correction is emitted, not merely applied to the
        // synchronous getter.
        final firstEvent = await source.onChange.first;
        expect(firstEvent, isFalse);
        expect(source.isOnline, isFalse);
      },
    );

    test('a device already online resolves the same way, with no surprises', () async {
      final source = PlatformConnectivitySource(
        initialCheck: Future.value(const [ConnectivityResult.wifi]),
        changes: const Stream<List<ConnectivityResult>>.empty(),
      );
      addTearDown(source.dispose);

      final firstEvent = await source.onChange.first;
      expect(firstEvent, isTrue);
      expect(source.isOnline, isTrue);
    });

    test('a later change on the live stream still updates isOnline and emits', () async {
      final source = PlatformConnectivitySource(
        initialCheck: Future.value(const [ConnectivityResult.wifi]),
        changes: Stream.fromIterable([
          const [ConnectivityResult.none],
        ]),
      );
      addTearDown(source.dispose);

      final events = await source.onChange.take(2).toList();
      // The initial-check correction (true, a no-op relative to the
      // optimistic default) followed by the live stream's own event (false)
      // -- both paths feed the same [onChange].
      expect(events, [true, false]);
      expect(source.isOnline, isFalse);
    });

    test('dispose() closes the stream without throwing even if a correction is still in flight', () async {
      final source = PlatformConnectivitySource(
        initialCheck: Future.delayed(const Duration(milliseconds: 20), () => const [ConnectivityResult.none]),
        changes: const Stream<List<ConnectivityResult>>.empty(),
      );
      source.dispose();
      // The delayed initialCheck future resolves after dispose(); its
      // `.then` callback must guard against the already-closed controller
      // (see `if (!_controller.isClosed)`) rather than throwing.
      await Future<void>.delayed(const Duration(milliseconds: 40));
    });
  });
}
