import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';

/// A live yes/no "is this device online right now" signal, abstracted behind
/// a plain stream of [bool] so a screen (and its widget tests) never touches
/// `connectivity_plus` -- and so never a platform channel -- directly.
/// [PlatformConnectivitySource] wraps the real plugin for the running app; a
/// test hands in its own implementation (a `StreamController<bool>` it
/// controls) to drive a screen offline and online deterministically, with no
/// platform channel involved at all.
abstract class ConnectivitySource {
  /// The last known state, read synchronously -- e.g. to decide a screen's
  /// very first frame before [onChange] has emitted anything.
  bool get isOnline;

  /// Emits every time online/offline status changes. Does not need to (and
  /// for [PlatformConnectivitySource], does not) replay the current value to
  /// a brand-new listener -- a caller combines this with [isOnline] for the
  /// state at the moment it first subscribes (see the review screens' own
  /// `initState`).
  Stream<bool> get onChange;
}

/// The real [ConnectivitySource], backed by `connectivity_plus`. A device
/// reporting anything other than [ConnectivityResult.none] on ANY interface
/// counts as online -- matching how the plugin itself flags "definitely
/// offline" only with a single-element `[none]` list.
class PlatformConnectivitySource implements ConnectivitySource {
  PlatformConnectivitySource({Connectivity? connectivity}) : _connectivity = connectivity ?? Connectivity() {
    _sub = _connectivity.onConnectivityChanged.listen((results) {
      _isOnline = _hasConnection(results);
      _controller.add(_isOnline);
    });
    // checkConnectivity() answers the CURRENT state immediately, so a screen
    // built before the first onConnectivityChanged event still reads the
    // right value from isOnline rather than the optimistic default below.
    unawaited(_connectivity.checkConnectivity().then((results) {
      _isOnline = _hasConnection(results);
    }));
  }

  final Connectivity _connectivity;
  late final StreamSubscription<List<ConnectivityResult>> _sub;
  final _controller = StreamController<bool>.broadcast();

  // Optimistic until the first real check resolves, so a screen never flashes
  // an offline state on a device that is, in fact, online -- the same
  // "assume the best, correct fast" choice the rest of this app makes.
  bool _isOnline = true;

  static bool _hasConnection(List<ConnectivityResult> results) =>
      results.any((r) => r != ConnectivityResult.none);

  @override
  bool get isOnline => _isOnline;

  @override
  Stream<bool> get onChange => _controller.stream;

  void dispose() {
    unawaited(_sub.cancel());
    unawaited(_controller.close());
  }
}
