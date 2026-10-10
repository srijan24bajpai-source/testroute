# Android release (Capacitor)

> **Start with `GO_LIVE.md` section 3** (step-by-step). Set the app ID and site address with
> `node scripts/configure-android.mjs --id <your.id> --url <https://your-site>` instead of editing files by hand.
> Play rejects `com.example.*` IDs, and the ID is permanent once uploaded.


The Android project in `android/` was generated with Capacitor 8 (`npx cap add android`). **No `.aab`/`.apk` was built in the authoring session** because JDK and the Android SDK were not installed there.

## Prerequisites (owner machine or CI)

- Node >= 20.9, npm
- **JDK 17+** (use the JDK bundled with Android Studio), **Android Studio** with Android SDK Platform (latest stable) and Build-Tools; set `ANDROID_HOME`
- A deployed HTTPS site (see `DEPLOY_VERCEL.md`)
- Google Play Console developer account

## Configure

1. **Application ID:** choose a permanent reverse-domain id (cannot change after publishing). Replace `com.example.routepilot` in: `capacitor.config.ts`, `android/app/build.gradle` (`namespace`, `applicationId`), the Java package/dir under `android/app/src/main/java/...` (or run `npx cap sync` after editing `capacitor.config.ts` and rename via Android Studio *Refactor*), `src/config/brand.ts` (`androidAppId`, `appScheme`), the `<data android:scheme>` in `AndroidManifest.xml`, `assetlinks.template.json`, and the Supabase redirect URL.
2. **Server URL:** `CAP_SERVER_URL=https://YOUR-DOMAIN npx cap sync android`. Also replace `YOUR-DOMAIN.example` in the manifest App Link filter.
3. **App Links:** publish `https://YOUR-DOMAIN/.well-known/assetlinks.json` (see `assetlinks.template.json`) with the SHA-256 of the **Play App Signing** certificate (Play Console → Setup → App signing). Without it, `autoVerify` fails and links open in the browser.
4. **Icons/splash:** generated from `resources/icon.svg` (replace with final artwork; regenerate with `npx @capacitor/assets generate --android`, installed ad hoc, then remove).
5. **Version:** bump `versionCode`/`versionName` in `android/app/build.gradle` for every upload.

## OAuth on Android

Google blocks OAuth inside embedded webviews. The app opens the system browser (`@capacitor/browser`), Supabase redirects to `com.example.routepilot://auth/callback?code=…` (PKCE), and `AuthForm` accepts only that scheme+host, exchanges the code, and closes the browser. Add that exact URL to Supabase *Redirect URLs*. Not tested on a device in this session.

## Build

```bash
npm ci
CAP_SERVER_URL=https://YOUR-DOMAIN npx cap sync android
cd android
./gradlew bundleRelease      # Windows: gradlew.bat bundleRelease
# internal-testing debug APK (NOT for Play):
./gradlew assembleDebug      # android/app/build/outputs/apk/debug/app-debug.apk
```
Output AAB: `android/app/build/outputs/bundle/release/app-release.aab`.

## Signing (never commit keystores)

1. Create an upload key **outside the repo**:
   `keytool -genkeypair -v -keystore ~/keys/routepilot-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
2. Put credentials in `~/.gradle/gradle.properties` (not the project): `RP_STORE_FILE=…`, `RP_STORE_PASSWORD=…`, `RP_KEY_ALIAS=upload`, `RP_KEY_PASSWORD=…`.
3. Add to `android/app/build.gradle`:
   ```gradle
   android {
     signingConfigs { release {
       storeFile file(RP_STORE_FILE); storePassword RP_STORE_PASSWORD
       keyAlias RP_KEY_ALIAS; keyPassword RP_KEY_PASSWORD } }
     buildTypes { release { signingConfig signingConfigs.release; minifyEnabled true } }
   }
   ```
   (Guard with `if (project.hasProperty('RP_STORE_FILE'))` so unsigned CI builds still work.)
4. Enrol in **Play App Signing** on first upload; keep the upload keystore backed up offline.

## Play Console steps (manual, owner-only)

Create app → complete store listing (`PLAY_STORE_LISTING.md`) → content rating questionnaire → Data safety form (`PRIVACY_DATA_MAP.md`) → privacy-policy URL (`https://YOUR-DOMAIN/privacy` after you complete it) → account-deletion URL (`https://YOUR-DOMAIN/account`) → target-audience/ads declarations → provide reviewer login if sign-in is required → upload AAB to Internal testing, then follow Google's **current** testing requirements for new personal developer accounts before Production (check Play Console help; these rules change) → submit for review. Publication has **not** happened.

## Permissions

Only `INTERNET`. No location, contacts, camera, storage, or notifications are requested.
