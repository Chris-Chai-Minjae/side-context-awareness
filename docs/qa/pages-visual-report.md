# GitHub Pages landing page QA — 2026-09-25

## Scope and result

Reviewed `docs/index.html` as a standalone static page against the Side design tokens and beginner guide. **PASS for local page rendering and navigation** at 1440 × 900 desktop and 375 × 812 phone, in Korean and English. The page has no external assets, analytics, credential fields, or live Side data; the history panel is labelled as a synthetic illustration.

| Check | Result |
|---|---|
| Four fresh full-page captures | Visually inspected; no clipping, overlap, awkward CJK line break, or horizontal scroll |
| Language controls | Correct `html lang`, title, one visible locale, `aria-pressed`, and 44px button targets |
| In-page navigation | All three links resolve to visible sections in both languages; 44px link targets |
| Local beginner guide | HTTP 200 from the local static server |
| Visible outbound links | Ten distinct hrefs per locale; GitHub repository, README, agent guide, QA, and MIT paths use the intended repository |
| Network requests | Only the local static page was requested; no tracker or external asset request |
| Required copy | MiMo, MiniMax, OpenAI, Keychain, Claude Code, MCP, and Grok Build status present in both languages |
| Project checker | `bun run check` passed (`tsc --noEmit && biome check .`; 208 files checked) |

The GitHub and Pages URLs are prepared for publication. Their live availability is outside this local check and should be verified after the repository and Pages site are published. This review did not launch Side.app or request macOS permissions.
