# P4-S1-V Settings endpoint registration

The approved task line said 14 RPCs. The implemented Settings page calls **16 distinct methods**: `status`, `permissions`, `settings.get`, `summaryModelDefault`, `historyStatus`, `listApplications`, `mcp.usage`, `historyList`, `appIcons`, `settings.patch`, `pause`, `resume`, `requestPermissions`, `clear`, `providers.setKey`, and `providers.test`. The count in `docs/planning/06-tasks.md` was corrected to 16; no API method or product behavior was added.

`bun test tests/e2e/settings.spec.ts` passed **6 tests, 0 failures, 52 assertions**. The new test starts a synthetic `runDaemon()` and fake helper, then calls each method over its real UDS with intentionally invalid params. Each returns JSON-RPC `-32602` (registered method, invalid params). An unregistered control method returns `-32601` (method not found). This distinguishes server registration from merely having a TypeScript schema.

The P4-S1-V parent remains open until the Side.app WKWebView obtains the daemon TCP token through `web.session` and the browser runs against that listener. The current Settings Playwright suite uses a test relay to the real daemon UDS; its five scenarios are recorded separately in `p4-s1-daemon-e2e.md`.
