# Build & Release Guide (Expo EAS)

This project is configured for Expo EAS builds. Follow these steps to produce a TestFlight build and submit to Apple.

## Prereqs
- Apple Developer account with App Store Connect access
- Expo account and EAS CLI installed locally
- App identifiers used here:
  - iOS bundle identifier: `com.avantrei.spreadly`
  - Android package: `com.avantrei.spreadly`

> If you need different IDs, update `app.json` under `ios.bundleIdentifier` and `android.package` before building.

## 1) Log in and link project
- In a terminal from the project root:
  - Login: `eas login`
  - Configure: `eas whoami` (confirm)

## 2) iOS credentials
- Run `eas build:configure` and follow prompts
  - Let EAS manage credentials (recommended) or upload your own
- First time, EAS will create: App ID, push key, distribution certificate, provisioning profile

## 3) Build for TestFlight (production profile)
React downgraded to 18.2.0 and new architecture disabled for stability.

Recommended commands:
```bash
eas build -p ios --profile production
eas build -p android --profile production
```
Track progress:
```bash
eas build:list --limit 5
eas build:inspect --build-id <BUILD_ID>
```

## 4) Submit to App Store Connect
- When the build finishes, submit:
  - `eas submit --platform ios --profile preview`
  - Or let the interactive prompt pick the last build
- The build will appear in App Store Connect under TestFlight after processing

## 5) Invite testers
- In App Store Connect → Your App → TestFlight
  - Add internal testers (immediate) or set up external testing (requires Beta App Review)

## Versioning
- App config is in `app.json`:
  - `version`: user-facing version (e.g., 1.0.0)
  - `ios.buildNumber`: string increment per App Store upload (e.g., 1.0.1)
  - `android.versionCode`: integer increment per Play Store upload (e.g., 2)

## Deep links and notifications
- Your custom scheme is `myfirstapp` and is already configured in `app.json`
- Expo Notifications is installed; EAS-managed credentials will enable the iOS push entitlement automatically

## Troubleshooting
**Dependency install failures (Install dependencies phase):**
- Ensure `react` is `18.2.0` (not 19.x) and matches Expo SDK 54 expectations
- Remove unnecessary native tooling (`@react-native-community/cli`) – already done
- Confirm `newArchEnabled` is `false` in `app.json` for this release
- Delete local `node_modules` + lock file, reinstall, then retry build

```bash
rm -rf node_modules package-lock.json
npm install
npx expo doctor
```

**Inspect failed build:**
```bash
eas build:inspect --build-id <BUILD_ID>
```
Look at sections: “Install dependencies” and “Prebuild”. Peer dependency or Cocoapods errors show here.

**Credentials issues:**
```bash
eas credentials
```

**Re-run with verbose:**
```bash
EXPO_DEBUG=1 eas build -p ios --profile production
```

**When to prebuild:** Only if adding a custom native module not supported by managed workflow. Otherwise skip.

## Minimal Preflight Checklist
1. Email login succeeds & invalid email errors are clean.
2. Scoreboard loads week games without runtime errors.
3. Final game triggers edge function (check console logs).
4. Weekly standings update (games_graded increments) after finals.
5. Locked lines persist after app restart.
6. No red screen warnings in navigation flow.

## Optional Optimizations
- Add `.easignore` to exclude CI artifacts and local logs.
- Use Yarn for faster dependency resolution (`yarn import`).
- After stable release, consider re-enabling new architecture.

