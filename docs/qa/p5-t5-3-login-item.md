# P5-T5.3 — Open at Login (code portion)

## Scope

- Added a SwiftUI `Open at Login` toggle to the Side menu.
- The toggle reads `SMAppService.mainApp.status`, calls `register()` when enabled and `unregister()` when disabled, and refreshes from the system status when the menu opens.
- A registered item needing approval displays the System Settings action; registration failures leave the toggle at the system-reported state and display an error.
- Side already starts its supervised daemon from `SideApplicationDelegate.applicationDidFinishLaunching` via `SideRuntime.start()`.

## Evidence (2026-09-24)

- Apple API: [SMAppService.mainApp](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp), [register()](https://developer.apple.com/documentation/servicemanagement/smappservice/register%28%29), [Status](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum). Apple documents launch of the main app at subsequent logins and a separate `requiresApproval` status.
- RED: `swift test --package-path apps/side-mac --filter LoginItemTests` failed because `LoginItemServicing` and `LoginItemStatus` did not exist.
- GREEN: the same focused command passed 3 tests, 0 failures.
- `bun test`: 705 pass, 0 fail.
- `npx tsc --noEmit`: exit 0.
- `npx biome check .`: 188 files checked, no fixes applied.
- `swift test --package-path apps/side-mac`: 157 XCTest cases passed, 0 failures (144 SideCaptureKitTests and 13 SideAppTests).
- `swift build -c release --package-path apps/side-mac`: build complete.

## Remaining acceptance

The current checkout has no live packaged, signed Side.app acceptance run. After P5-T5.1 supplies the bundled app, enable the toggle in that app, confirm Side is allowed under System Settings → General → Login Items, reboot or log out and back in, and verify that Side and its supervised daemon start automatically and `capture_status.state` is `running`. Until that live check passes, P5-T5.3 remains unchecked in `docs/planning/06-tasks.md`.
