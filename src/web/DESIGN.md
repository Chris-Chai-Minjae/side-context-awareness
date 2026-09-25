# Side web shell design system

## 0. Research Log

- Embedded reference: use the Side palette and compact controls defined by the approved screen specifications.
- Approved source: `docs/planning/06-screens.md` and `specs/shared/components.yaml` fix the copy, states, and four shared components.
- This task is a functional shell for a local WKWebView. External screen research and image concepts are outside its approved scope; no visual-fidelity claim is made.

## 1. Atmosphere & Identity

A quiet local control surface. The signature is an ink-on-paper frame with a slim status rail; warnings gain emphasis through content and contrast, not decoration.

## 2. Color

| Role | Token | Light | Dark |
|---|---|---|---|
| Canvas | `--canvas` | `#ffffff` | `#111315` |
| Panel | `--panel` | `#f5f5f5` | `#1d2023` |
| Text | `--ink` | `#090b0c` | `#f6f7f7` |
| Muted text | `--muted` | `#62696c` | `#aab1b4` |
| Hairline | `--line` | `#dce0e2` | `#353a3d` |
| Focus | `--focus` | `#235e8a` | `#8fc9f0` |
| Warning surface | `--warning` | `#fff4db` | `#3a3020` |
| Danger | `--danger` | `#a62d2d` | `#f38a8a` |
| Overlay | `--scrim` | `rgb(9 11 12 / 0.46)` | `rgb(9 11 12 / 0.68)` |

All CSS color values come from these tokens. Status color is never the sole status signal.

## 3. Typography

System UI font (`-apple-system`, `BlinkMacSystemFont`, `system-ui`, `sans-serif`) matches the native host without a network font. Heading is 24px/1.2, brand 18px/1.5, body 16px/1.5, control 14px/1.4, caption 12px/1.4. Monospace is system monospace for evidence only.

## 4. Spacing & Layout

Base unit is 4px. `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-6` 24px, `--space-8` 32px. The shell has a fixed header and one scrollable main region (`min-block-size: 0`); content width is at most 720px. At narrow widths, header controls wrap and the content remains one column.
Controls have an 8px radius and panels a 12px radius; structural edges stay square.

## 5. Components

- **PermissionBanner**: status region with four copy variants. `Allow` appears only when permissions are needed or unavailable. No banner for `none`; long text wraps.
- **PauseControl**: labelled select plus Pause button, with Resume and status text while paused. Buttons have visible focus, hover, active, and disabled states. A pending request disables actions.
- **ConfirmDialog**: modal title, body, Cancel, and destructive confirm button. Escape cancels; focus enters the dialog and returns to the trigger. No destructive callback before confirm.
- **UntrustedTextView**: pre-wrapped, wrapping text container; literal match segments use `<mark>`. Empty text has a plain empty state. Markup from evidence is always text.
- **Shell**: top app identity and route navigation stay fixed; the main region owns vertical scroll. Loading, error, empty, and normal content keep the same frame.

The demo route is the component showcase for all four primitives and all four shell data states. Components are independent of the settings and day-view pages.

## 6. Motion & Interaction

Color and opacity feedback use 150ms ease-out. No ambient animation. `prefers-reduced-motion` removes transitions. Hash navigation uses native links and preserves browser history.

## 7. Depth & Surface

Borders-only: one-pixel hairlines and tonal panel fills separate regions. No shadows or glass effects.

## 8. Accessibility Constraints & Accepted Debt

Target WCAG 2.2 AA: readable text contrast, labelled controls, visible keyboard focus, keyboard-closeable dialog, status text independent of color, and responsive reflow at 375px. No accepted design debt in this task.
