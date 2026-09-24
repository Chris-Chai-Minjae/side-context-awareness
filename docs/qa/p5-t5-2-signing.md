# P5-T5.2 — Developer ID signing and notarization

## Scope and release procedure

`apps/side-mac/scripts/sign-notarize.sh` operates on the `Side.app` produced by `bun run build`. It checks the bundle layout, Apple Events and Screen Recording purpose strings, and the Apple Events entitlement. `preflight` is read-only; `release` requires an installed `Developer ID Application` identity and an existing `notarytool` Keychain profile. The script copies the app into a temporary directory, signs the three bundled dylibs and `side` executable before the outer app, submits a ZIP with `notarytool --wait`, requires `Accepted`, staples and validates the app ticket, checks `spctl`, then creates the final ZIP. It never modifies the input app or stores credentials.

```sh
sh apps/side-mac/scripts/sign-notarize.sh preflight apps/side-mac/.build/release/Side.app
sh apps/side-mac/scripts/sign-notarize.sh release \
  apps/side-mac/.build/release/Side.app \
  'Developer ID Application: TEAM NAME (TEAMID)' \
  existing-keychain-profile \
  /path/to/Side.zip
```

`Side.entitlements` grants `com.apple.security.automation.apple-events` to the app that sends browser Apple events. `Info.plist` explains Apple Events and optional Screen Recording. Accessibility and Input Monitoring are explained in the existing onboarding UI; Apple does not name a usage-description key for those two services in its [macOS protected resources list](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos).

## Evidence

| Check | Result |
|---|---|
| `bun test tests/release/signing.test.ts` RED before script existed | 0 pass, 4 fail |
| `bun test tests/release/signing.test.ts` GREEN after implementation | 5 pass, 0 fail (synthetic preflight, missing purpose string, missing identity, Accepted and Invalid submissions) |
| `sh -n apps/side-mac/scripts/sign-notarize.sh` | pass |
| `plutil -lint apps/side-mac/Info.plist apps/side-mac/Side.entitlements` | both OK |
| `security find-identity -v -p codesigning` | 0 valid identities found |
| `bun test` | exit 0; 713 pass, 0 fail, 1 snapshot |
| `npx tsc --noEmit` | exit 0; 0 errors |
| `npx biome check .` | exit 0; 193 files checked, no fixes |
| `swift test --package-path apps/side-mac` | exit 0; SideCaptureKit 144 and SideApp 10 tests, 0 failures |

The Accepted and Invalid paths use command stubs and a synthetic bundle. They prove control flow only. Actual Developer ID signing, Hardened Runtime launch, Apple notarization, ticket stapling, and `spctl -a -vv Side.app` returning `accepted` with `source=Notarized Developer ID` remain **unverified** because this Mac has no Developer ID identity. Keep P5-T5.2 unchecked until a release Mac with a valid identity and Keychain profile runs the procedure and validates the distributed ZIP on a clean Mac.

## Apple references

- [Creating distribution-signed code for macOS](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac): sign nested code individually before the outer app; use Hardened Runtime and a secure timestamp for Developer ID distribution.
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution): Developer ID, Hardened Runtime, secure timestamp, and valid signatures are notarization requirements.
- [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow): `notarytool submit --keychain-profile --wait`, then staple the app; ZIP archives themselves cannot be stapled.
- [Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) and [NSAppleEventsUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription): app entitlement and purpose string for browser automation.
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit): `NSScreenCaptureUsageDescription` for screen capture access.
