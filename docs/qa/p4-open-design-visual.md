# P4 Open Design visual refinement

## Scope and result

CSS-only transfer of the approved Open Design Settings and Day layout into the existing Preact UI. `src/web/styles.css` is the only production source changed. English copy, data, components, behavior, and the imported `design/` files were left intact. **CSS visual verdict: PASS** from two independent read-only reviews of the final eight captures. Exact whole-prototype parity remains **REVISE** for the state and markup differences below.

## Visual evidence

All captures are synthetic demo routes, with no user ledger or credential data. Before, reference, and final screenshots are in `/tmp/side-open-design-qa/{before,reference,final}/`. Each folder covers Settings and Day at 1280 × 900 and 375 × 900, in light and dark mode. The `final/` captures were made after the last CSS edit and build. The imported HTML reference uses Korean copy and populated sample data; the production demo uses approved English copy and different synthetic data, so raw pixel similarity is not a whole-page fidelity verdict.

| Check | Before | Final |
|---|---:|---:|
| Settings desktop effective content width | 720px | 720px, matching prototype card x280–1000 |
| Header height | Baseline screenshot retained; no DOM measurement recorded | 64px at both widths and themes |
| Day desktop article / evidence columns | 2fr / 1fr, evidence at least 260px | 856px / 320px in 1200px content |
| 375px document width, Settings and Day | 375px | 375px in both themes; no horizontal overflow |
| Settings switch and button hit heights | 24px / 36px | 44px / 44px |
| Scrolling | `.app-main` and evidence pane nested scrolling | Document scrolling; evidence pane reflows below article at 760px |

The final mobile Day title keeps the complete `2026-09-24` date together. The 375px normal and non-normal demo states were also checked for overflow: Settings `loading`, `error`, `empty`, `permissions_needed`, `paused`; Day `loading`, `error`, `empty`, `expired-evidence`. Each had `documentElement.scrollWidth - innerWidth = 0`.

## Interaction and accessibility checks

At 375px, the Settings theme button switched to dark, Add opened a dialog, Escape closed it, keyboard focus rendered a 3px outline, and reduced-motion computed button transition duration was `0s`. On Day, a source link loaded evidence, the Match input remained 44px high, Find highlighted one match, and the expanded evidence state had no horizontal overflow. The underlying demo fixture holds some setting values static, so its typed-text switch is not evidence of persisted state changes; the repository's real Settings and Day E2E tests cover the approved RPC behavior.

## Gates

| Command | Result |
|---|---|
| `bun test` | 744 pass, 0 fail; 76 files, 4,843 assertions |
| `npx tsc --noEmit` | exit 0 |
| `npx biome check src` | 95 files clean |
| `bun run build:web` | 116 modules bundled, exit 0 |
| `swift test --package-path apps/side-mac` | 153 SideCaptureKit and 13 SideApp tests pass; no Swift files changed afterward |
| `npx biome check .` | 202 files clean after excluding the imported, standalone Open Design HTML artifact in `biome.json`; production source remains included. |

## Markup and state gaps outside CSS ownership

- The Day demo has one date. `src/web/pages/day-view.tsx` renders previous/next links only when adjacent dates exist, while the prototype shows disabled arrow controls. Matching that state requires a data fixture or markup decision.
- `src/web/main.tsx` marks History navigation active only for the real history route, so the Day demo lacks the prototype's active History underline. A CSS selector cannot infer the current demo route from the present DOM.
- The production Settings demo has no permission banner, denylist entries, provider row, or MCP counts in its normal state, unlike the populated prototype. Exact visual comparison of those rows requires equivalent synthetic fixture data.
- The Day evidence metadata is emitted as plain paragraphs, a heading, and a time element in `src/web/components/evidence-panel.tsx`; the prototype uses labelled metadata pairs. CSS cannot supply the missing labels without changing copy or markup.

No source or design artifacts outside the assigned CSS file were edited by this task, and no commit was made. At final status, unrelated concurrent modifications were visible in `docs/planning/02-architecture.md`, two files under `specs/`, and `tests/api/providers.test.ts`; they were left untouched.
