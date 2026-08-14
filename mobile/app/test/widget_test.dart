// A basic boot smoke test for the real app shell: no stored session, no
// stored PIN -- the app should come up showing the sign-in screen, with no
// crash along the way. The deeper behaviour (role routing, the sync banner,
// the PIN gate, login failures, ...) is covered in shell_test.dart; this
// file only proves `PmRecordsApp` itself wires together and renders.

import 'package:flutter_test/flutter_test.dart';
import 'package:pmrecords/api/client.dart';
import 'package:pmrecords/auth/pin.dart';
import 'package:pmrecords/auth/secure_storage.dart';
import 'package:pmrecords/auth/session.dart';
import 'package:pmrecords/db/local_db.dart';
import 'package:pmrecords/main.dart';
import 'package:pmrecords/screens/login.dart';
import 'package:pmrecords/services/connectivity_source.dart';
import 'package:pmrecords/sync/queue.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class _NoopConnectivity implements ConnectivitySource {
  @override
  bool get isOnline => true;

  @override
  Stream<bool> get onChange => const Stream.empty();
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
  });

  testWidgets('boots with no stored session and shows the sign-in screen', (tester) async {
    final db = LocalDb(databaseFactory: databaseFactoryFfiNoIsolate, path: inMemoryDatabasePath);
    addTearDown(db.close);
    final storage = InMemorySecureStorage();

    await tester.pumpWidget(PmRecordsApp(
      api: ApiClient(baseUrl: 'http://localhost'),
      db: db,
      session: SessionStore(storage),
      pin: PinLock(storage),
      connectivity: _NoopConnectivity(),
      syncQueue: SyncQueue(db),
    ));
    await tester.pumpAndSettle();

    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.text('PM Records'), findsOneWidget);
  });
}
