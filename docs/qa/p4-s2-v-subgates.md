# P4-S2-V Day view connection subgates

The four named connection subgates passed in a synthetic browser and daemon fixture. The parent P4-S2-V and P4-S2-T2 remain open because the test browser uses an authenticated relay to the daemon UDS; the approved app-to-daemon web-token delivery contract is unresolved. The empty-day `null` response is injected by that relay. These results do not prove the Side.app WKWebView path.

## Evidence

Command: `bun test tests/contracts/rpc.test.ts tests/e2e/day-view.spec.ts tests/api/server.test.ts`

Result: **22 pass, 0 fail, 257 assertions** across three files (2.63 seconds, 2026-09-24 local run).

- **Field Coverage:** `tests/contracts/rpc.test.ts` reads `specs/screens/day-view.yaml` and verifies every `needs` field for `day_pages`, `history_status`, and `evidence` exists in its RPC output schema.
- **Endpoint:** `tests/e2e/day-view.spec.ts` calls the registered daemon UDS implementations for `historyStatus`, `day.get`, `read`, and `clear` through `tests/e2e/day-view-fixture.ts`; its returned objects pass the resource schemas. The test writes only a synthetic ledger in a temporary directory.
- **Navigation:** Browser clicks move to the previous and next summary dates and from the day page to Settings. The summary hash scrolls to the cited section.
- **Auth:** Missing Bearer returns HTTP 401 on the daemon TCP server and on the test relay. `tests/api/server.test.ts` independently checks incorrect Bearer, Host, and Origin handling.

## Remaining acceptance boundary

Run the browser through the actual Side.app WKWebView against the daemon TCP port after the approved web-session delivery contract is resolved. Remove the test relay for that acceptance path, then check P4-S2-T2 and the parent P4-S2-V only after its named scenarios pass end to end.
