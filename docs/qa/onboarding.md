# P4-S4-T2/V — Onboarding QA

Date: 2026-09-24. Scope: `specs/screens/onboarding.yaml` and the matching P4-S4 tasks in `docs/planning/06-tasks.md`. No TCC reset, System Settings interaction, user ledger read, or `~/.aside` write was performed.

## Code evidence

| Contract | Evidence | Boundary |
|---|---|---|
| Permission fields, one-second polling, optional Screen Recording | `OnboardingFlowTests` covers first launch, permission advancement, Screen Recording skip persisting `screenOcr:false`, health sheet visibility, and provider-step resume after a simulated restart. New `OnboardingRPCTests.testPermissionRequestUsesApprovedHelperMethodOverUDS` checks `requestPermissions` and its `kinds` payload on a temporary Unix socket. | Fake permissions; no physical TCC grant or restart. |
| Provider skip and setup | `OnboardingFlowTests` checks skip, provider save, optional key storage, test, and model selection order. Existing UDS tests check `settings.get` and the skip patch. | No live provider or summary queue. |
| Finish → menu state | New `OnboardingRPCTests.testEnableSendsApprovedSettingsPatchOverUDS` checks `settings.patch({enabled:true})`. `OnboardingFlowTests.testEnableRefreshesCachedMenuImmediatelyAfterSuccess` checks the controller callback bypasses the 30-second cache and shows `Capturing` when the fake status is running; its failure and already-enabled tests check no extra refresh. The daemon reconciler tests cover enabled settings and fake helper health. | The `running` status is supplied by a fake; actual native app/daemon timing and `stop_reason='no-summary-model'` after provider skip remain unobserved. |

`swift test --package-path apps/side-mac --filter 'MenuBarRPCTests|OnboardingRPCTests'` exited 0: 8 selected tests, 0 failures (5 onboarding RPC, 3 menu RPC). `swift test --package-path apps/side-mac` exited 0 with no failures, including the onboarding flow, controller callback, and permission suites. `bun test` exited 0: 714 pass, 0 fail, 1 snapshot, 4,703 assertions across 73 files. `npx tsc --noEmit` exited 0 with no output. `npx biome check .` exited 0: 197 files checked, no fixes applied. The two added Swift tests extend synthetic UDS integration coverage; no production code was changed in this task, so no production RED/GREEN cycle applies.

## Manual TCC/new-user checklist — isolated future run

Use a new macOS user account or isolated test Mac and a separately launched Side.app. Preserve existing Side processes and permissions. Do not run `tccutil reset` in the current account. Record app build/commit, macOS version, test account, time, and screen recording path; redact any provider key or captured content.

- [ ] Start with Accessibility, Input Monitoring, and Screen Recording ungranted. Capture the intro and the three permission steps with the correct System Settings deep links.
- [ ] Grant Accessibility in System Settings and record that onboarding advances within two seconds. Repeat for Input Monitoring; verify the helper health's `permissionSheetVisible` state while the sheet is open.
- [ ] Exercise the optional Screen Recording skip and confirm `screenOcr=false` in test settings. In a separate fresh run, grant Screen Recording, allow any required app restart, and capture provider-step resume.
- [ ] Skip the provider, press **Enable Context Awareness**, and capture the sheet closing and menu changing to `Capturing`. Query the isolated daemon's status and verify `enabled=true` and `running`; verify pending summary work records `stop_reason='no-summary-model'` using synthetic/test data only.
- [ ] In a separate run, save a synthetic provider, confirm `providers.setKey` and `providers.test` succeed without exposing the key, and verify Enable reaches the menu.

**Verdict:** field mapping, approved RPC payloads, fake-service flow, and menu-refresh wiring are proven at code level. P4-S4-T2's physical TCC/restart recording and P4-S4-V's actual `finish → running` observation remain open; no P4-S4 checkbox was changed.
