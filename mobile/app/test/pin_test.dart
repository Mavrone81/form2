import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/auth/pin.dart';
import 'package:pmrecords/auth/secure_storage.dart';

void main() {
  group('PinLock hashing', () {
    test('hashPin is deterministic for the same salt and PIN', () {
      final salt = PinLock.generateSalt();
      expect(PinLock.hashPin('1234', salt), PinLock.hashPin('1234', salt));
    });

    test('generateSalt differs on every call', () {
      final salts = List.generate(20, (_) => PinLock.generateSalt());
      expect(salts.toSet().length, salts.length);
    });

    test('hashPin differs for a different salt, same PIN', () {
      final a = PinLock.generateSalt();
      final b = PinLock.generateSalt();
      expect(PinLock.hashPin('1234', a), isNot(equals(PinLock.hashPin('1234', b))));
    });

    test('hashPin differs for a different PIN, same salt', () {
      final salt = PinLock.generateSalt();
      expect(PinLock.hashPin('1234', salt), isNot(equals(PinLock.hashPin('4321', salt))));
    });
  });

  group('PinLock round trip', () {
    late PinLock pin;

    setUp(() => pin = PinLock(InMemorySecureStorage()));

    test('no PIN set yet: verify fails and hasPin is false', () async {
      expect(await pin.hasPin(), isFalse);
      expect(await pin.verifyBool('1234'), isFalse);
    });

    test('setPin then verify with the same PIN succeeds', () async {
      await pin.setPin('1234');
      expect(await pin.hasPin(), isTrue);
      final result = await pin.verify('1234');
      expect(result.status, PinVerifyStatus.ok);
      expect(result.isOk, isTrue);
    });

    test('wrong PIN fails verification', () async {
      await pin.setPin('1234');
      final result = await pin.verify('4321');
      expect(result.isOk, isFalse);
      expect(result.status, PinVerifyStatus.wrongPin);
    });

    test('accepts 4, 5 and 6 digit PINs', () async {
      await pin.setPin('1234');
      expect(await pin.verifyBool('1234'), isTrue);
      await pin.setPin('12345');
      expect(await pin.verifyBool('12345'), isTrue);
      await pin.setPin('123456');
      expect(await pin.verifyBool('123456'), isTrue);
    });

    test('rejects a PIN shorter than 4 or longer than 6 digits, or non-digits', () async {
      expect(() => pin.setPin('123'), throwsArgumentError);
      expect(() => pin.setPin('1234567'), throwsArgumentError);
      expect(() => pin.setPin('12a4'), throwsArgumentError);
    });

    test('salt differs per set, even for the identical PIN, so the stored hash also differs', () async {
      final storage = InMemorySecureStorage();
      final lock = PinLock(storage);

      await lock.setPin('123456');
      final saltA = await storage.read('pin_salt');
      final hashA = await storage.read('pin_hash');

      await lock.setPin('123456');
      final saltB = await storage.read('pin_salt');
      final hashB = await storage.read('pin_hash');

      expect(saltA, isNotNull);
      expect(saltA, isNot(equals(saltB)));
      expect(hashA, isNot(equals(hashB)));
      // Both remain valid for the same PIN against their own generation.
      expect(await lock.verifyBool('123456'), isTrue);
    });

    test('clear removes the stored PIN', () async {
      await pin.setPin('1234');
      await pin.clear();
      expect(await pin.hasPin(), isFalse);
      expect(await pin.verifyBool('1234'), isFalse);
    });
  });

  group('PinLock attempt limiting / lockout', () {
    late InMemorySecureStorage storage;
    late DateTime clock;
    late PinLock pin;

    PinLock makeLock() => PinLock(storage, now: () => clock);

    setUp(() async {
      storage = InMemorySecureStorage();
      clock = DateTime.utc(2026, 1, 1, 12, 0, 0);
      pin = makeLock();
      await pin.setPin('1234');
    });

    test('reports remaining attempts before the initial lock', () async {
      final r1 = await pin.verify('0000');
      expect(r1.status, PinVerifyStatus.wrongPin);
      expect(r1.remainingBeforeLock, 4);

      final r2 = await pin.verify('0000');
      expect(r2.remainingBeforeLock, 3);

      final r3 = await pin.verify('0000');
      expect(r3.remainingBeforeLock, 2);

      final r4 = await pin.verify('0000');
      expect(r4.remainingBeforeLock, 1);
    });

    test('5 consecutive wrong PINs locks the gate for 30 seconds', () async {
      for (var i = 0; i < 4; i++) {
        expect((await pin.verify('0000')).status, PinVerifyStatus.wrongPin);
      }
      final fifth = await pin.verify('0000');
      expect(fifth.status, PinVerifyStatus.lockedOut);
      expect(fifth.lockedUntil, clock.add(const Duration(seconds: 30)));
    });

    test('the correct PIN during lockout is still refused until expiry', () async {
      for (var i = 0; i < 5; i++) {
        await pin.verify('0000');
      }
      // Still locked, 10s into a 30s lockout.
      clock = clock.add(const Duration(seconds: 10));
      final duringLock = await pin.verify('1234');
      expect(duringLock.status, PinVerifyStatus.lockedOut);

      // Now past the 30s cooldown: the correct PIN succeeds.
      clock = clock.add(const Duration(seconds: 21)); // total 31s since lock
      final afterLock = await pin.verify('1234');
      expect(afterLock.isOk, isTrue);
    });

    test('one more wrong attempt right after the first cooldown re-locks at double the delay (60s)', () async {
      for (var i = 0; i < 5; i++) {
        await pin.verify('0000'); // 5th locks for 30s
      }
      clock = clock.add(const Duration(seconds: 31)); // cooldown over
      final sixth = await pin.verify('0000');
      expect(sixth.status, PinVerifyStatus.lockedOut);
      expect(sixth.lockedUntil, clock.add(const Duration(seconds: 60)));
    });

    test('lockout delay keeps doubling and is capped at 30 minutes', () async {
      // Lockout 1: 30s.
      for (var i = 0; i < 5; i++) {
        await pin.verify('0000');
      }
      // Lockout 2: 60s.
      clock = clock.add(const Duration(seconds: 31));
      var r = await pin.verify('0000');
      expect(r.lockedUntil, clock.add(const Duration(seconds: 60)));

      // Lockout 3: 120s.
      clock = clock.add(const Duration(seconds: 61));
      r = await pin.verify('0000');
      expect(r.lockedUntil, clock.add(const Duration(seconds: 120)));

      // Lockout 4: 240s.
      clock = clock.add(const Duration(seconds: 121));
      r = await pin.verify('0000');
      expect(r.lockedUntil, clock.add(const Duration(seconds: 240)));

      // Fast-forward through several more lockout cycles to prove the cap:
      // stage 4 -> 240s, 5 -> 480s, 6 -> 960s, 7 -> 1920s which must clamp
      // to the 30 minute (1800s) ceiling.
      clock = clock.add(const Duration(seconds: 241));
      r = await pin.verify('0000'); // stage 5: 480s
      expect(r.lockedUntil, clock.add(const Duration(seconds: 480)));

      clock = clock.add(const Duration(seconds: 481));
      r = await pin.verify('0000'); // stage 6: 960s
      expect(r.lockedUntil, clock.add(const Duration(seconds: 960)));

      clock = clock.add(const Duration(seconds: 961));
      r = await pin.verify('0000'); // stage 7 would be 1920s, capped to 1800s
      expect(r.lockedUntil, clock.add(const Duration(seconds: 1800)));
    });

    test('a successful verify resets the counter and the lockout entirely', () async {
      for (var i = 0; i < 5; i++) {
        await pin.verify('0000'); // locks for 30s
      }
      clock = clock.add(const Duration(seconds: 31));
      expect((await pin.verify('1234')).isOk, isTrue);

      // Fresh budget: a single wrong attempt now reports 4 remaining, not
      // an immediate re-lock.
      final next = await pin.verify('0000');
      expect(next.status, PinVerifyStatus.wrongPin);
      expect(next.remainingBeforeLock, 4);
    });

    test('the failure counter persists across a new PinLock instance over the same storage', () async {
      await pin.verify('0000');
      await pin.verify('0000');
      await pin.verify('0000'); // 3 failures, 2 remaining

      final reopened = makeLock(); // simulates a cold start reading the same storage
      final result = await reopened.verify('0000'); // 4th failure
      expect(result.status, PinVerifyStatus.wrongPin);
      expect(result.remainingBeforeLock, 1);

      final locking = await reopened.verify('0000'); // 5th failure locks
      expect(locking.status, PinVerifyStatus.lockedOut);
    });

    test('setPin clears any prior attempt count / lockout', () async {
      for (var i = 0; i < 5; i++) {
        await pin.verify('0000'); // now locked
      }
      await pin.setPin('9999');
      final result = await pin.verify('9999');
      expect(result.isOk, isTrue);
    });

    test('lockout state round-trips through a single storage key (no multi-write crash window)', () async {
      for (var i = 0; i < 3; i++) {
        await pin.verify('0000'); // 3 failures, not yet locked
      }

      // Exactly one key holds the whole attempt/lockout unit -- the fix for
      // the crash window a 3-key write sequence had (a kill between writes
      // could leave a bumped lockout stage with no enforced lockedUntil).
      final raw = await storage.read('pin_attempt_state');
      expect(raw, isNotNull);
      expect(await storage.read('pin_fail_count'), isNull);
      expect(await storage.read('pin_lockout_stage'), isNull);
      expect(await storage.read('pin_locked_until'), isNull);

      final decoded = jsonDecode(raw!) as Map<String, dynamic>;
      expect(decoded['failCount'], 3);
      expect(decoded['lockoutStage'], 0);
      expect(decoded['lockedUntil'], isNull);

      // Round trip: a fresh instance over the same storage reads the exact
      // same state back out (this is also what makes persistence across a
      // cold start work at all).
      final reopened = makeLock();
      final fourth = await reopened.verify('0000');
      expect(fourth.remainingBeforeLock, 1);

      // Push it into an actual lockout and confirm the single key still
      // carries the lockedUntil timestamp faithfully.
      final fifth = await reopened.verify('0000');
      expect(fifth.status, PinVerifyStatus.lockedOut);
      final lockedRaw = jsonDecode((await storage.read('pin_attempt_state'))!) as Map<String, dynamic>;
      expect(DateTime.parse(lockedRaw['lockedUntil'] as String), fifth.lockedUntil);
    });

    test('a legacy split-key attempt state (pre-single-key) is never read back as a fallback', () async {
      // Simulate state as if written by an earlier (hypothetical) build
      // that used the three separate keys this version replaced.
      await storage.write('pin_fail_count', '4');
      await storage.write('pin_lockout_stage', '1');
      await storage.write('pin_locked_until', clock.add(const Duration(hours: 1)).toIso8601String());

      // No `pin_attempt_state` key exists, so this must read back as a
      // completely fresh, unlocked budget -- the legacy keys must not
      // resurrect a phantom lockout.
      final result = await pin.verify('0000');
      expect(result.status, PinVerifyStatus.wrongPin);
      expect(result.remainingBeforeLock, 4);
    });
  });
}
