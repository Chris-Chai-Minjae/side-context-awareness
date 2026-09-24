# P4-S1-T2 / P4-S2-T2 direct TCP E2E

2026-09-24, macOS arm64, Bun 1.3.5. Base commit: `99e69a5`.

## Scope and path

The Settings and Day view Playwright fixtures now launch the real `runDaemon()` TCP listener and use the `{ port, token }` from its `web.session` command observed by an in-process synthetic fake helper. The helper acknowledges that command with `null`. Both fixtures compare its port and SHA-256 token hash with the exact `{ port, tokenHash }` object in the temporary `run/web.json`; the plaintext token is absent from that file. No relay server is started, and the tests assert that the relay directory does not exist.

The browser's initial GET carries `Bearer <token>` and `?t=<token>`. After bootstrap, the page URL has no `?t=`, and every browser `/rpc` request is asserted to use the daemon port and Bearer token. Missing and incorrect Bearer requests to the actual TCP listener return HTTP 401. Existing UI scenarios, RPC request-count checks, provider-key redaction, and the literal `null` missing-day response remain covered. Synthetic settings, key, and ledger data stay in temporary directories; no `~/.aside` files or user ledger rows were used.

## RED / GREEN and gates

- RED: `bun test tests/e2e/settings.spec.ts --test-name-pattern 'direct Settings RPC rejects'` exited 1 because relay port `56500` differed from daemon port `56498`.
- RED: `bun test tests/e2e/day-view.spec.ts --test-name-pattern 'literal null day response'` exited 1 because relay port `56532` differed from daemon port `56531`.
- GREEN: `bun test tests/e2e/settings.spec.ts tests/e2e/day-view.spec.ts` exited 0: 17 pass, 0 fail, 390 assertions.
- `bun test` first run: 699 pass, 1 fail in the unrelated provider-key heap snapshot test. The isolated test then passed, and a fresh full `bun test` exited 0: 700 pass, 0 fail, 1 snapshot, 4647 assertions across 69 files.
- `npx tsc --noEmit` exited 0 with no output.
- `npx biome check .` exited 0: 186 files checked, no fixes applied.
- `swift test --package-path apps/side-mac` exited 0: SideCaptureKitTests 139 pass and SideAppTests 10 pass, both with 0 failures.
- `git diff --check` exited 0.

## Remaining boundary

These E2E tests use headless Chrome and an in-process fake helper. Actual `Side.app` `WKWebView` startup, native Keychain, and physical TCC permission behavior require separate app and device verification.

## Integrated result after key rotation

The direct TCP tests and key rotation were integrated at `bf83cc5` and `8b134e8`. The four named Settings and Day view connection subgates, all five Day view scenarios, and the script-as-text assertion pass against the daemon listener. This closes `P4-S1-V`, `P4-S2-T2`, and `P4-S2-V` under their listed criteria. The native `Side.app` path remains part of `P4-S3-V` and the manual gates; this browser fixture does not prove it.

The first integrated full `bun test` exposed a test-process resource issue: repeated in-process Day view fixtures left 4–5 SQLite file descriptors per fixture after `Database.close()`. A minimal 12-iteration `openLedger`/`close()` loop increased `/dev/fd` entries from 8 to 41; a minimal `Database.transaction()` case reproduced retained descriptors, while calling `Bun.gc(true)` after each close kept that minimal loop at 5. The E2E files now force collection in `afterAll`, after Playwright closes. Forcing GC while the browser was still open caused its `browser.close()` hook to stall, so cleanup order is part of the regression fix. With that order, the integrated full `bun test` passed **705 tests, 0 failures, 1 snapshot, 4,680 assertions across 71 files**. `npx tsc --noEmit` and `npx biome check .` also passed. This is a test fixture lifecycle fix; production daemon shutdown still relies on process exit after closing its databases.

`P4-R5-T1` uses the literal `null` missing-day result required by `02-architecture.md` §4 and `specs/screens/day-view.yaml`; its older task line said `markdown=null`, which could not describe the same response. The acceptance line in `06-tasks.md` was aligned to the existing approved response contract. `tests/api/history.test.ts`, `tests/daemon/reconcile.test.ts`, and the direct Day view E2E assert the literal result. Clear all rotation is separately covered by `p4-r5-t1-clear-all-rotation.md`; native Keychain behavior remains unverified.
