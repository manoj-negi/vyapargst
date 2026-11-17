# THE CITY CART — Android and iOS apps

Capacitor 8 apps for the existing billing website. Everything for the apps lives in this folder; the
website's own development and production workflow is unchanged.

## How it fits together (read this first)

THE CITY CART renders every screen on the server (Express + EJS, with the data filled in per request).
There is no separate frontend bundle, so the apps do **not** copy the website. They open the same
backend in a native WebView:

```
 Android / iOS app (this folder)            Your backend (project root)          PostgreSQL
 ┌──────────────────────────────┐   HTTPS   ┌─────────────────────────────┐      ┌──────────┐
 │ WebView → pages from backend │ ────────▶ │ Express + EJS views          │ ───▶ │ same DB  │
 │ native.js (share, Back, …)   │           │ public/ (CSS, JS, native.js)│      └──────────┘
 │ www/: connection screen      │           └─────────────────────────────┘
 └──────────────────────────────┘
```

- **One frontend:** the screens, validations, GST calculations, Section/Department autofill and
  previous-discount logic are the website's own code. A fix to the website is a fix to the apps.
- **Phone layout** (bottom navigation, safe areas, card rows, folding filters) is in the shared
  `public/css/app.css`, so phone browsers get it too. The desktop layout is unchanged.
- **Native-only helpers** are in `public/js/native.js`, loaded only when the page runs inside the app
  (the app adds `TheCityCartApp/<version>` to its user agent). They cover PDF/CSV sharing, Print →
  share PDF, Android Back, external links, the keyboard and the splash screen. Plugin access comes
  from `public/js/vendor/capacitor-bridge.js`, built from `bridge/` by `npm run bridge`.
- **The database** is only ever reached by the backend. The app holds no database credentials or
  secrets; it signs in through the normal login page with the normal session cookie (same origin,
  so no CORS changes were needed).
- **The packaged `www/` folder** holds the "Connection required" screen with Retry. It is shown
  when the backend cannot be reached, and nothing is stored on the phone. Offline billing is
  **not** supported: that would need on-device storage and syncing, which is not built.

### What needs an app rebuild, and what doesn't

| Change | Website | Apps |
|---|---|---|
| Views, CSS, JS in `public/`, business logic, database | deploy backend | appear on next screen load, no app update |
| `capacitor.config.ts`, plugins, icons/splash, app name/ID, permissions, `www/` connection screen, `bridge/` | — | rebuild and re-release the app |
| Production server address (`MOBILE_PRODUCTION_URL`) | — | rebuild and re-release |

## Requirements

- Node.js 22+ (the project uses `~/.nvm/versions/node/v22.23.4`).
- **Android:** Android Studio 2025.2.1 or newer (it includes a suitable JDK), with SDK Platform 36
  and an emulator image. Set `ANDROID_HOME=~/Library/Android/sdk`.
- **iOS:** macOS with Xcode 26 or newer from the App Store, plus an iOS simulator runtime (Xcode →
  Settings → Components). Swift Package Manager is used, so CocoaPods is not needed.
- Check https://capacitorjs.com/docs/getting-started/environment-setup when upgrading.

## Install

```bash
cd "/Users/anilsingh/Desktop/vyapar app/vyapargst"
npm install                    # website/backend (as before)
cd mobile-app && npm install   # Capacitor CLI, platforms and plugins
```

## Run everything locally

### 1. Start the backend (it also serves the shared frontend)

```bash
cd "/Users/anilsingh/Desktop/vyapar app/vyapargst"
npm run dev                    # http://localhost:3000, restarts on change
```

The backend listens on all network interfaces, so emulators and phones on your Wi-Fi can reach it.
There is no separate frontend server to start: step 1 serves the screens, CSS and JS.

**Live reload while developing:** `npm run dev` restarts the server when `src/` changes. Edits to
`views/` and `public/` apply on the next page load. In the app, pull to refresh or switch tabs. No
app rebuild is needed for these.

### 2. Which server address each target uses

| Target | Command prefix | Server address | Why |
|---|---|---|---|
| Android emulator | `MOBILE_ENV=android-emulator` | `http://10.0.2.2:3000` | `10.0.2.2` is the emulator's alias for your Mac |
| iOS simulator | `MOBILE_ENV=ios-simulator` | `http://localhost:3000` | the simulator shares the Mac's network |
| Phone on Wi-Fi | `MOBILE_ENV=device` | `http://<Mac's Wi-Fi IP>:3000` (detected automatically) | see below |
| Production | `MOBILE_ENV=production` | `MOBILE_PRODUCTION_URL` (must be https) | |

**A physical phone cannot use `localhost`.** On the phone, `localhost` means the phone itself, not
your Mac. The `device` builds therefore use the Mac's Wi-Fi address. Find it with
`ipconfig getifaddr en0`, or set it yourself with `MOBILE_DEV_HOST=192.168.1.20`. Other overrides:
`MOBILE_DEV_PORT=3000`, or `MOBILE_DEV_URL=http://…` for a full URL.

### 3. Build and sync

```bash
cd mobile-app
npm run sync:android:emulator   # or sync:ios:simulator, sync:device, sync:production
```

This writes `www/` with that environment's server address, then runs `cap sync`, which copies it and
the config into `android/` and `ios/` and updates the native plugins.

### 4. Android emulator

1. Android Studio → Device Manager → create a Pixel device (API 35/36), then start it.
2. Run:
   ```bash
   cd mobile-app
   npm run android:emulator
   ```
   Or `npm run open:android` and press Run in Android Studio.

### 5. iOS simulator (Xcode)

```bash
cd mobile-app
npm run ios:simulator           # pick a simulator when asked
```

Or `npm run open:ios`, choose an iPhone simulator and press Run.

### 6. A real phone on the same Wi-Fi

1. The Mac and the phone must be on the same Wi-Fi, and the backend must be running (step 1).
2. If macOS asks whether `node` may accept incoming connections, choose **Allow**.
3. Check that the phone can reach the backend: open `http://<Mac IP>:3000/healthz` in the phone's
   browser. It should show `{"ok":true}`.
4. **Android:** turn on Developer options → USB debugging, connect by USB once, then run
   `npm run android:device`.
5. **iPhone:** connect it, run `npm run open:ios` after `npm run sync:device`, choose your iPhone and
   your Apple ID team under Signing & Capabilities, then press Run. iOS asks for **Local Network**
   access the first time; allow it.

### 7. Android debug APK (install without a store)

```bash
cd mobile-app
npm run apk:debug               # built for a phone on your Wi-Fi (device addresses)
# or: npm run apk:debug:emulator
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, or copy the file to the phone and
open it (allow "install unknown apps").

## Security of the development setup

- **Unencrypted HTTP is allowed only in development:**
  - Android: `android/app/src/debug/res/xml/network_security_config.xml` (debug builds only).
    Release builds use `src/main/res/xml/network_security_config.xml`, which allows HTTPS only.
  - iOS: the Debug configuration uses `ios/App/App/Info-Debug.plist`, which allows local networking.
    Release uses `Info.plist`, which keeps full App Transport Security.
- **A release build refuses** a server address that is not https (Gradle check in
  `android/app/build.gradle`). `MOBILE_ENV=production` also requires a public https address.
- **WebView debugging** (`chrome://inspect`, Safari Develop menu) is on for development
  environments and off for production.
- **Android backups of app data are disabled** (`allowBackup="false"`).

## Store release preparation (nothing is published by these steps)

1. **App name and ID:** `MOBILE_APP_NAME` and `MOBILE_APP_ID` (default `com.thecitycart.billing`).
   Choose the final ID before the first upload; it cannot change afterwards. After changing it,
   update `android/app/build.gradle` (`applicationId`, `namespace`, and the Java package folder of
   `MainActivity`) and the iOS bundle identifier in Xcode, or remove `android/` and `ios/` and run
   `npx cap add android` / `npx cap add ios` again.
2. **Version:** `npm run version:set -- 1.0.1 2` (version name, build number). This updates
   `package.json`, the Android `versionCode`/`versionName` and the iOS
   `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`. The build number must increase with every upload.
3. **Icons and splash:**
   - Sources are in `assets/` (made from the brand logo: `icon-only.png`, `icon-foreground.png`,
     `icon-background.png`, `splash.png`, `splash-dark.png`). `brand/logo.png` is the logo used on the
     connection screen.
   - To regenerate after changing them: `npm run assets`.
4. **Production build:**
   ```bash
   MOBILE_PRODUCTION_URL=https://billing.your-domain.in npm run sync:production
   ```
   The backend must be deployed at that https address with `NODE_ENV=production` (secure session
   cookies).
5. **Android signing:**
   - Create an upload key: `keytool -genkey -v -keystore ~/keys/citycart-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`.
   - Create `android/keystore.properties` (git-ignored):
     ```
     storeFile=/Users/<you>/keys/citycart-upload.jks
     storePassword=…
     keyAlias=upload
     keyPassword=…
     ```
   - Build with `cd android && ./gradlew bundleRelease`. The output is
     `app/build/outputs/bundle/release/app-release.aab`.
   - Never commit the keystore or passwords. Losing the upload key requires a Play Console key reset.
6. **iOS signing:** an Apple Developer Program membership, then in Xcode set your Team, a
   distribution certificate and an App Store provisioning profile. Use Product → Archive, then
   upload from the Organizer.
7. **Permissions in use:**
   - Android: `INTERNET` only.
   - iOS: the camera reason string (`NSCameraUsageDescription`), because the item-image and logo
     upload fields offer "Take Photo". The Local Network permission is requested in Debug only.
   - Add nothing else until a feature needs it.
8. **Check the current store rules before submitting:**
   - Google Play: target API level, Data safety form, privacy policy URL.
   - Apple: the App Review Guidelines, especially 4.2 "Minimum Functionality" for apps built around
     web content, plus App Privacy details.
   - Approval is never guaranteed. Capacitor's docs describe `server.url` (used here because the
     screens are server-rendered) as meant for live reload. Apps that load a remote site can be
     rejected, so review this choice and the native features before submitting. The alternative
     is a client-rendered mobile frontend talking to a JSON API, which would be a separate project.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | writes `www/` for `MOBILE_ENV` |
| `npm run sync:android:emulator` / `sync:ios:simulator` / `sync:device` / `sync:production` | build + `cap sync` for that environment |
| `npm run android:emulator` / `android:device` | sync and run on Android |
| `npm run ios:simulator` / `ios:device` | sync and run on iOS |
| `npm run open:android` / `open:ios` | open the native project in Android Studio / Xcode |
| `npm run apk:debug` | debug APK for a phone on your Wi-Fi |
| `npm run bridge` | rebuild `public/js/vendor/capacitor-bridge.js` after changing `bridge/` or upgrading Capacitor |
| `npm run assets` | regenerate icons and splash screens |
| `npm run version:set -- <x.y.z> <build>` | set the version everywhere |
| `npm test` | unit tests for the environment and server-address rules |
| `npm run doctor` | Capacitor's own setup check |

## Troubleshooting

- **"Connection required" screen:**
  - Check that the backend is running (`npm run dev`).
  - Check that the address shown on the screen opens `/healthz` from the device.
  - Emulator: it must be `10.0.2.2`, not `localhost`.
  - Phone: same Wi-Fi as the Mac, the macOS firewall allows `node`, and the Mac's IP hasn't
    changed. Re-run `npm run sync:device` after it changes.
- **Android shows "net::ERR_CLEARTEXT_NOT_PERMITTED":** you installed a release build against an
  http address. Use a debug build for development.
- **iOS cannot reach the Mac over Wi-Fi:** allow Local Network access (Settings → Privacy &
  Security → Local Network), and make sure you're running the Debug configuration.
- **Signed out after every launch:** the session cookie is `Secure` when the backend runs with
  `NODE_ENV=production`, so a production backend must be served over https.
- **A PDF doesn't appear:** the app shares it through the system share sheet (Save to Files, Drive,
  WhatsApp, Print…). Check that the backend can generate PDFs (it uses Puppeteer).
- **`cap` says the native project is out of date:** run the matching `npm run sync:…` again.
- **Changed `bridge/` or upgraded `@capacitor/core`:** run `npm run bridge`, commit
  `public/js/vendor/capacitor-bridge.js`, and deploy the backend.

## Folder structure

```
mobile-app/
├── README.md
├── package.json / package-lock.json   mobile dependencies and scripts (separate from the website)
├── capacitor.config.ts                app ID/name, server address per MOBILE_ENV, plugins
├── config/environments.mjs            emulator / simulator / device / production addresses
├── bridge/capacitor-bridge.ts         → ../public/js/vendor/capacitor-bridge.js (npm run bridge)
├── www-src/                           connection screen (index.html, offline.html, css, js)
├── www/                               generated by npm run build (git-ignored)
├── brand/logo.png                     logo for the connection screen
├── assets/                            icon and splash sources for npm run assets
├── scripts/                           build-www, build-bridge, set-version, tests
├── android/                           Android Studio project (debug-only cleartext, signing hook)
└── ios/                               Xcode project (Info-Debug.plist for development)
```

Shared frontend pieces used by the apps live in the main project:
- `public/js/native.js`
- `public/js/vendor/capacitor-bridge.js`
- the phone section of `public/css/app.css`
- `views/partials/bottom-nav.ejs`
- the `/healthz` route in `src/app.ts`
