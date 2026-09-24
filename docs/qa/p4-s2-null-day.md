# P4-S2-T2 missing day response

`docs/planning/02-architecture.md` §4 and `specs/screens/day-view.yaml` specify a literal `null` from `day.get` when no rendered page exists. The handler previously returned `{date, markdown:null, updated_at}`. It now returns `null` for a missing file; a rendered page still returns its resource object. The Day view already accepts either response shape and renders the same empty state.

RED: after updating the API, daemon UDS, and Playwright assertions to require `null`, `bun test tests/api/history.test.ts tests/daemon/reconcile.test.ts tests/e2e/day-view.spec.ts` yielded **41 pass, 5 fail**. The failures all showed an object with `markdown:null` in place of the required `null`.

GREEN: after the handler change, the same command yielded **46 pass, 0 fail, 196 assertions**. The Day view test relay no longer injects `null`; its empty-day and Clear today scenarios now receive the daemon's actual `day.get` response. The browser still reaches the daemon through the authenticated test relay. The direct daemon TCP and Side.app WKWebView paths remain separate acceptance steps.
