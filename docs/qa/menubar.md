# P4-S3-T1/T2/V — Menu bar QA

Date: 2026-09-24. Scope: `specs/screens/menubar.yaml` and the matching P4-S3 tasks in `docs/planning/06-tasks.md`. No live Side window, TCC state, user ledger, or `~/.aside` data was touched.

## Code evidence

| Contract | Evidence | Boundary |
|---|---|---|
| Five status strings, three icons, 30-second cache, immediate menu-open refresh, Pause ▸ 30 minutes, Resume | `MenuStateTests` maps all five statuses, forces a refresh on menu open, and checks the pause/resume state change. New `MenuBarRPCTests` sends `status`, `pause` with `durationMs: 1800000`, and `resume` over a real temporary Unix socket to a synthetic HTTP RPC responder. | Swift model and UDS wire behavior; no native menu rendering screenshot. |
| Helper `settings.open` | `CommandRouterTests.testApplicationsConfigureAndSettingsCommandsUseInjectedServices` checks command dispatch and success. `SupervisorTests` checks `web.session` delivery and invalidation. | No physical app/helper exchange. |
| Settings and Today's summary routes | `MenuStateTests.testSettingsSessionBootstrapsBothRoutesWithoutExternalTokenLeak` checks `/settings/context-awareness`, today's `/history/<date>`, and bootstrap token construction. `SettingsNavigationTests` checks local and external navigation policy. | No actual WKWebView navigation observed. |
| Web token cleanup | `tests/web/shell.test.tsx` checks `history.replaceState` removes `?t=` from the current entry without increasing history length, and `/rpc` uses a Bearer header. `tests/e2e/settings.spec.ts` checks the real daemon TCP listener, bootstrap URL cleanup, and authenticated RPC in a synthetic browser fixture. | Initial local bootstrap request contains `?t=<token>` by design. Native WKWebView history, caches, and external browser behavior remain unobserved. |
| Quit | `SupervisorTests.testQuit...` checks SIGTERM and the five-second forced-exit path; `SideApp` calls `runtime.quit()` before app termination. | Existing Side processes were not stopped here. |

## Independent source and test audit (2026-09-24)

At `a5e5e69`, the menu source already covers the five approved status strings, three icons, four pause choices, conditional Resume, 30-second status cache, menu-open refresh request, settings and today's routes, and Quit's daemon shutdown path. The existing tests exercise the model and a synthetic Unix-socket RPC responder. `settings.open` is routed by `CommandRouter`; the supervisor passes `web.session` to `SettingsWindowController`; the web shell removes the bootstrap `t` query with `history.replaceState`; and the TCP server requires Bearer auth even when the URL contains `?t=`. These are source and synthetic-test findings; no live native menu or WKWebView was observed. No production gap within the owned files was reproduced, so this audit added no production test or code change and has no new RED/GREEN cycle.

| Command | Current result |
|---|---|
| `swift test --package-path apps/side-mac --filter 'MenuStateTests\|MenuBarRPCTests'` | Exit 0; 6 menu model tests and 3 synthetic UDS menu RPC tests passed, 0 failures. |
| `swift test --package-path apps/side-mac` | Exit 0; all Swift suites passed, 0 failures. |
| `bun test` | Exit 0; 753 pass, 0 fail, 1 snapshot, 4,887 assertions across 76 files. |
| `npx tsc --noEmit` | Exit 0; no output. |
| `npx biome check .` | Exit 0; 202 files checked, no fixes applied. |

The three `menubar.yaml` scenarios have model or synthetic-path coverage: pause for 30 minutes maps to `Paused until HH:MM` and the paused icon; a failed daemon status request maps to the not-running line and error icon; and Settings constructs the authenticated local request. The remaining native acceptance evidence is a real menu-open refresh, rendered icon and menu screenshots, a real `settings.open`/WKWebView navigation, inspection of WKWebView history after token cleanup, and Quit of an isolated app and daemon. Until that evidence exists, P4-S3-T1/T2 and the Endpoint, Navigation, and Auth subgates of P4-S3-V stay open.

## Manual acceptance checklist — isolated future run

Use a fresh macOS user account or an isolated test Mac with a separately launched Side.app. Do not terminate an existing Side process, reset its TCC grants, or reuse a real user's ledger. Record the app build/commit, macOS version, test account, time, and screenshot or screen recording path; redact the token and any captured content.

- [ ] With capture running, open the native menu. Capture `Capturing` and the active icon; confirm the icon does not blink during capture.
- [ ] Select **Pause ▸ 30 minutes**. Capture `Paused until HH:MM` and the paused icon; reopen the menu and confirm status was refreshed. Select **Resume** and capture `Capturing` with Resume hidden.
- [ ] Stop only the isolated test daemon. Open the menu and capture `Capture is not running` with the error icon; restart the isolated app/daemon without affecting any existing process.
- [ ] Click **Settings…** and **Today's summary…**. Capture the Settings page and today's day route in WKWebView, then inspect the current URL/history for absence of `t` after bootstrap. Check that external links never carry the token and that a stale token fails after daemon restart. Keep token values out of evidence files.
- [ ] Quit the isolated Side.app and record that its test daemon exits through the documented shutdown path.

**Verdict:** source, model, synthetic UDS, and browser-fixture contracts are proven by the commands above. P4-S3-T2's required native screenshots and P4-S3-V's live WKWebView/auth boundary remain open; no P4-S3 checkbox was changed.
