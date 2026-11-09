# Stock Blueprint for Android (APK)

Owner, 09-Nov-2026: "my friends suggest ... if you make an app, it will be easily accessible. Can you make an app that
works on Android, iOS? I am not going to list this to App Store or Play Store." Choice: **Android = an APK file**,
**iPhone = the website added to the Home Screen** (an installable web app - Safari: Share → Add to Home Screen).

## What it is
A **Trusted Web Activity** (Google's androidbrowserhelper `LauncherActivity`): the app opens
`https://stock-blueprint-sandy.vercel.app/` full screen in the phone's Chrome. So:
- the app is always the newest website (no app update needed when the site changes);
- the owner's PIN, My Watchlists, the Backtest Lab and the bell work exactly as on the website;
- phone pop-ups (Web Push, `web/sw.js` + `api/push.js`) show as **this app's** notifications (`DelegationService`,
  small icon `ic_notification_icon`).

Chrome hides its address bar only when the site proves the app is ours: `web/.well-known/assetlinks.json` holds the
SHA-256 of the app's signing certificate (package `com.stockblueprint.app`). Without a match the app still works, with
a thin address bar on top.

## Build (Linux, JDK 17+, Gradle 8.9+)
```
# Android SDK: platforms;android-35 + build-tools;35.0.0 (sdkmanager), then:
export ANDROID_HOME=/path/to/android-sdk
export KEYSTORE_FILE=/path/to/blueprint.jks KEYSTORE_PASSWORD=... KEY_ALIAS=blueprint
cd android && echo "sdk.dir=$ANDROID_HOME" > local.properties
gradle assembleRelease          # -> app/build/outputs/apk/release/app-release.apk
```
The signing key is **never** in this repo (`*.jks` is git-ignored). A new key = a new SHA-256 in
`web/.well-known/assetlinks.json` (the list may hold both) and the phone must uninstall the old app first (Android only
updates an app signed with the same key). Icons: `node tools/build_icons.js` (also writes `res/*/ic_launcher.png`).

## Install on the phone
Send `StockBlueprint.apk` to the phone (WhatsApp to yourself, Google Drive or a USB cable) → tap it → Android asks
"Allow from this source?" → Allow → Install. Then open **Blueprint**, type the My Watchlists PIN once (My Watchlists →
Sync), and in the bell 🔔 tap **Turn on phone pop-ups on this device**.
