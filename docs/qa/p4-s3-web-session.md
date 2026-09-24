# P4-S3-T1 web session delivery

## Scope and result

The daemon now sends one `web.session {port, token}` command after the TCP listener is published and the app's `hello` arrives. Startup requires a correlated success response whose data is `null`; a rejection stops startup and removes `run/web.json`. The Swift supervisor validates and caches the session only in memory, clears it on stop or child exit, and passes changes to `SettingsWindowController` through `SideRuntime`. `settings.open` still opens Settings and returns `null`.

Settings and Today's summary now bootstrap the local web shell with the same token in the initial Bearer header and `?t=` query. The existing shell removes `t` using `history.replaceState` before its first RPC, and its RPC client sends the token only in the Bearer header. On session loss, the window drops its web view and shows the unavailable state. External navigation carrying the current token is refused.

## Evidence

- RED: `bun test tests/contracts/protocol.test.ts tests/daemon/web-session.test.ts` failed because `web.session` was rejected by the protocol and never sent by the daemon. The first Swift RED attempt exposed a test syntax error; after correction, the implementation compile failed because `NSNull` is not `Encodable`. These were resolved before GREEN.
- GREEN: focused Bun tests: 5 pass, 0 fail. Focused Swift tests for command acceptance, invalid arguments, child crash invalidation, and bootstrap requests: 4 pass, 0 fail.
- `bun test`: 698 pass, 0 fail across 69 files. Existing shell tests assert URL cleanup before RPC, Bearer auth, and no token in the RPC URL or body. Existing API tests assert missing/incorrect Bearer gives 401 and wrong Host/Origin gives 403.
- `npx tsc --noEmit`: exit 0. `npx biome check .`: exit 0, 185 files checked. `bun run build:web`: exit 0, 116 modules bundled.
- `swift test --package-path apps/side-mac`: SideCaptureKitTests 139 pass, SideAppTests 10 pass, 0 failures.
- Synthetic daemon test confirms `run/web.json` contains only the port and SHA-256 token hash, with no raw token; the fake app acknowledges `web.session` once.

## Limits

The signed Side.app and a live WKWebView were not launched, so this does not prove the physical GUI path or browser history on a real app run. Keychain rotation and planning/spec documents were outside this worktree task and were not changed. No real ledger rows or `~/.aside/` writes were used.
