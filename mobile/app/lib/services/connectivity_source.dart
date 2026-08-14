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
  /// [initialCheck] and [changes] are both independently injectable --
  /// separately from [connectivity] -- specifically so a test can drive the
  /// exact race this class exists to close (see [_applyInitialCheck]'s doc)
  /// without a fake `connectivity_plus` platform channel. `Connectivity`
  /// itself cannot be faked directly: it's a private-constructor,
  /// factory-returned singleton wired to a real platform channel, so
  /// subclassing or constructing a second instance isn't an option. In the
  /// running app both parameters default to that real singleton's own calls.
  PlatformConnectivitySource({
    Connectivity? connectivity,
    Future<List<ConnectivityResult>>? initialCheck,
    Stream<List<ConnectivityResult>>? changes,
  }) : _connectivity = connectivity ?? Connectivity() {
    _sub = (changes ?? _connectivity.onConnectivityChanged).listen((results) {
      _isOnline = _hasConnection(results);
      if (!_controller.isClosed) _controller.add(_isOnline);
    });
    unawaited((initialCheck ?? _connectivity.checkConnectivity()).then(_applyInitialCheck));
  }

  final Connectivity _connectivity;
  late final StreamSubscription<List<ConnectivityResult>> _sub;
  final _controller = StreamController<bool>.broadcast();

  // Optimistic until the first real check resolves, so a screen never flashes
  // an offline state on a device that is, in fact, online -- the same
  // "assume the best, correct fast" choice the rest of this app makes. Kept
  // deliberately optimistic rather than pessimistic: [_applyInitialCheck]
  // below is what closes the resulting hole, by actively correcting this the
  // moment the real answer is known, rather than requiring a caller to
  // reconcile [isOnline] against a value [onChange] never told them about.
  bool _isOnline = true;

  static bool _hasConnection(List<ConnectivityResult> results) =>
      results.any((r) => r != ConnectivityResult.none);

  /// The constructor's one-shot `checkConnectivity()` result. Extracted to
  /// its own method (rather than inlined in the constructor) so a test can
  /// drive exactly this path via the injectable `initialCheck` future above.
  ///
  /// Critically, this EMITS on [onChange], not just updates [_isOnline]: a
  /// device already offline before this app ever launched gets no
  /// `onConnectivityChanged` event to correct it (nothing about its
  /// connectivity changes again -- it was already off), so the optimistic
  /// `true` default would otherwise stand, uncorrected, for the rest of the
  /// session -- every submitting control rendering enabled, with no caption,
  /// while a real tap genuinely reaches (and fails against) the network.
  /// Without this emission, only a LATER change would ever notify a
  /// listener; this call is what notifies one of the FIRST, already-known
  /// answer too.
  void _applyInitialCheck(List<ConnectivityResult> results) {
    final online = _hasConnection(results);
    _isOnline = online;
    if (!_controller.isClosed) _controller.add(online);
  }

  @override
  bool get isOnline => _isOnline;

  @override
  Stream<bool> get onChange => _controller.stream;

  void dispose() {
    unawaited(_sub.cancel());
    unawaited(_controller.close());
  }
}
