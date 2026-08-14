plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.bevorasg.pmrecords"
    // flutter.compileSdkVersion (36) is behind what flutter_secure_storage
    // 11.0.0 compiles against (37); AGP enforces that :app's compileSdk be
    // at least as high as every AAR dependency's, via the
    // checkReleaseAarMetadata task. APIs are backward compatible, so this
    // is safe to raise independent of minSdk (26, above) and targetSdk.
    // Revisit when Flutter's own default catches up.
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.bevorasg.pmrecords"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // Pinned at 26 (Android 8) per the plan's device support floor rather
        // than Flutter's own default, which drifts upward with each release.
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // The release keystore never enters this repo (see android/.gitignore and
    // the root check-no-sensitive-files.sh). CI decodes it from the
    // ANDROID_KEYSTORE_B64 GitHub secret to a runner-temp path and passes the
    // four values below as environment variables (see
    // .github/workflows/android.yml). Locally none of these are set, so
    // `releaseKeystorePath` is null and the release build type falls back to
    // debug signing -- `flutter build apk --release` still works for local
    // testing without anyone needing the real keystore or its passwords.
    val releaseKeystorePath: String? = System.getenv("KEYSTORE_PATH")
    val releaseKeystorePass: String? = System.getenv("KEYSTORE_PASS")
    val releaseKeyAlias: String? = System.getenv("KEY_ALIAS")
    val releaseKeyPass: String? = System.getenv("KEY_PASS")
    val hasReleaseSigning =
        !releaseKeystorePath.isNullOrEmpty() &&
            !releaseKeystorePass.isNullOrEmpty() &&
            !releaseKeyAlias.isNullOrEmpty() &&
            !releaseKeyPass.isNullOrEmpty()

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePass
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPass
            }
        }
    }

    buildTypes {
        release {
            // Real signing when the env vars are present (CI, from the
            // ANDROID_KEYSTORE_* secrets); otherwise fall back to the debug
            // keys so local dev builds (`flutter build apk`,
            // `flutter build apk --release`) keep working without the
            // keystore.
            signingConfig =
                if (hasReleaseSigning) {
                    signingConfigs.getByName("release")
                } else {
                    signingConfigs.getByName("debug")
                }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
