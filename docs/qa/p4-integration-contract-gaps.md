# Phase 4 integration contract gaps

Status: implementation blocked at two app/daemon boundaries. This report does not change the approved planning documents or specs.

## 1. Web session delivery to WKWebView

`02-architecture.md` §4 requires a daemon-generated, per-start 32-byte TCP bearer token to reach Side.app through the `result` of `settings.open`. Its §3 protocol defines `settings.open` in the opposite direction: daemon → app command, followed by app → daemon result. The current Swift handler returns `null`, while the daemon keeps the token only in memory and writes only its hash to `run/web.json`. The app therefore cannot obtain the token to open the authenticated page. Browser tests inject a token from `startApiServer` directly; they do not prove the Side.app path.

**Proposed contract decision:** add one explicit daemon → app web-session delivery frame containing `{port, token}` after the TCP listener starts. Side.app keeps the token in memory, opens the requested route through WKWebView with an authenticated initial request, and the web shell removes `?t=` from history before its first RPC. The approved contract must specify whether this is a new command or a documented payload of `settings.open`, when it is sent after a daemon restart, and how the app invalidates the prior token. It must also reconcile the §4 phrase `result of settings.open` with §3 message direction.

**Acceptance after decision:** a launched Side.app opens Settings and Today's summary through the real daemon; no token is written to disk, browser history, logs, or external links; an old token fails after daemon restart; unauthenticated TCP returns 401. Until this is proven, P4-S1-T2, P4-S3-T1/V, and app-level G10 remain open.

## 2. Master-key rotation on Clear all

`04-data-model.md` §4 requires crypto-shredding the master key when all history is cleared. `clearLedger(..., "all")` correctly refuses to run without a rotation callback. Side.app has `SideKeychain.rotateMasterKey()` and `DaemonSupervisor.rotateMasterKeyAfterClearAll()`, but the approved §3 helper protocol has no rotation command and the daemon does not pass a callback to the `clear` handler. The UI's Clear all action therefore fails closed.

**Proposed contract decision:** define a daemon → app `keychain.rotate` command that runs only after the clear transaction commits. It must acknowledge rotation, zero the daemon's old key, and restart the daemon so a fresh `hello` carries the new key. The approved contract must define failure behavior and whether the UI reports a committed deletion when Keychain rotation fails. Do not use a no-op rotation callback or return a success before the old key is invalidated.

**Acceptance after decision:** in a real app/daemon integration test, Clear all removes raw captures, summaries, day pages, index entries, and the old Keychain item; a new master key is supplied through the next `hello`; prior ciphertext cannot be opened; failures stay visible. P4-R5-T1 remains open until this succeeds.

## Current verified boundary

- Browser settings scenarios pass against a real authenticated API server with fake resource handlers; the actual app token path is unverified.
- Partial history clearing and deletion-epoch tests pass; Clear all requires the missing rotation callback.
- The screens' YAML `needs` fields are present in resource contracts (`tests/contracts/rpc.test.ts`). This proves schema coverage, not WKWebView navigation or app/daemon integration.
- `agent_connection` has no RPC endpoint by design (`specs/domain/resources.yaml`): the UI computes its fields from the bundled binary path. The task's former "14 RPCs" count was corrected to the 16 distinct Settings calls and checked against the live daemon UDS; see `p4-s1-v-endpoints.md`.

## P4-S1-V verified subgates

`bun test tests/contracts/rpc.test.ts tests/api/server.test.ts tests/web/settings.test.tsx` passed with 38 tests, 0 failures, and 296 assertions. The contract test covers every Settings YAML `needs` field; successful RPC responses are output-schema validated by `src/api/rpc.ts`. The Settings test checks that a summary link resolves to `#/history/:date#s:<id>` and parses as a history route. The API server test sends an unauthenticated HTTP POST to `/rpc` and observes 401. All four named subgates are now checked in `06-tasks.md`; the parent remains open for the actual Side.app WKWebView path.
