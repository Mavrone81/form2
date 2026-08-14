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
      expect(await pin.verify('1234'), isFalse);
    });

    test('setPin then verify with the same PIN succeeds', () async {
      await pin.setPin('1234');
      expect(await pin.hasPin(), isTrue);
      expect(await pin.verify('1234'), isTrue);
    });

    test('wrong PIN fails verification', () async {
      await pin.setPin('1234');
      expect(await pin.verify('4321'), isFalse);
    });

    test('accepts 4, 5 and 6 digit PINs', () async {
      await pin.setPin('1234');
      expect(await pin.verify('1234'), isTrue);
      await pin.setPin('12345');
      expect(await pin.verify('12345'), isTrue);
      await pin.setPin('123456');
      expect(await pin.verify('123456'), isTrue);
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
      expect(await lock.verify('123456'), isTrue);
    });

    test('clear removes the stored PIN', () async {
      await pin.setPin('1234');
      await pin.clear();
      expect(await pin.hasPin(), isFalse);
      expect(await pin.verify('1234'), isFalse);
    });
  });
}
