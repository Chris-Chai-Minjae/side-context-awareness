# P4-S4 native window and TCC check — 2026-09-24

## Onboarding window regression

- Before the fix, the launched `Side.app` onboarding window measured **80 × 184 pt** with `orca computer list-windows`; its text was clipped.
- `NSHostingController`'s default sizing options constrained the containing `NSWindow` to the SwiftUI content's small intrinsic size. The window now disables automatic hosting size constraints and sets a 640 × 470 pt content minimum. It also keeps the `NSWindow` alive after `close()` under Swift ARC.
- RED: the new `OnboardingWindowSizeTests` could not compile before extracting the window factory. Initial GREEN attempt exposed a post-test `objc_release` crash; setting `isReleasedWhenClosed = false` fixed it.
- `swift test --package-path apps/side-mac --filter OnboardingWindowSizeTests`: 1 passed, 0 failed.
- `swift test --package-path apps/side-mac`: exit 0; SideAppTests 19 passed, 0 failed.
- `bun test`: 768 passed, 0 failed. `bun run check`: exit 0; Biome checked 205 files.
- `bun run build`: exit 0. After relaunch, `orca computer list-windows --app pid:<Side PID> --json` measured **640 × 498 pt** including title bar. A direct screenshot showed the complete Accessibility step and button.

## Physical TCC observation

- The macOS Accessibility list showed `Side` switched on. The current app's daemon `permissions` RPC returned `{"accessibility":false,"input_monitoring":false,"screen_recording":false,"automation":{}}`, including after restarting Side.
- This development bundle is ad hoc signed; `codesign -dr -` reports a `cdhash` designated requirement. A rebuild changes that hash, so the existing enabled TCC entry may be associated with an earlier build. This is a diagnosis to verify, not a confirmed TCC database reading.
- After the user removed the old entry and added the current build, the live `permissions` RPC returned `accessibility:true`; the native window advanced to **Allow Input Monitoring**. This supports the stale-entry diagnosis. The TCC database itself was not read.
- The build was copied to `/Applications/Side.app` with `ditto`, without re-signing. `codesign --verify --deep --strict` passed, and the copied app retained the same designated `cdhash`. The process executable path was `/Applications/Side.app/Contents/MacOS/Side`.
- Following user approval and the native app's restart, the live RPC returned `accessibility:true`, `input_monitoring:true`, and `screen_recording:true`; the native window advanced to **Add a summary provider**. These are physical checks for the permission portion of `P4-S4-T2`. Provider configuration, finish-to-running, and capture behavior are still pending.
