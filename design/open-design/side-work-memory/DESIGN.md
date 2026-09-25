# Side Work Memory Prototype Design System

## 1. Atmosphere & identity

A quiet local utility: ink, paper, clear rules, and spare blue interaction cues. The signature is a precise information rhythm from page title to section headings to rows. It has no decorative imagery, blur, shadow, or ambient motion.

## 2. Color

`brand-spec.md` contains the supplied-source OKLch conversions. `--bg`, `--surface`, `--fg`, `--muted`, `--border`, and `--accent` bind exactly to those values in light and dark themes. `--warning` and `--danger` also come from the supplied palette. Derived hover surfaces use `oklch()` relative to each theme's surface lightness; no new hue is introduced. Blue is reserved for selected controls, navigation links, and focus.

## 3. Typography

Use the supplied system UI direction for both display and body because this is a native desktop utility surface. Display uses the platform's system font stack; body uses `system-ui`. Mono uses the platform UI mono stack for configuration snippets. Type scale: page title 28/34, section title 17/24, row label 15/22, body 15/23, detail 13/20, code 12/18. Use tabular numerals for dates and counts.

## 4. Spacing & layout

Base unit 4px. Primary spacing steps are 4, 8, 12, 16, 20, 24, 32, and 40px. Desktop Settings has a 760px max-width centered column. Day uses a 1200px max-width split grid with a fluid article and a 320px evidence pane. At 760px and below, the evidence pane moves below the article; at 600px and below, row controls stack under their explanations. At 375px there is a 16px page gutter and no horizontal scrolling. The document owns scrolling; no nested scroll pane is needed.

## 5. Components

- **App header:** wordmark, Settings and History routes, one theme button. Selected navigation has an underline. Hover strengthens the surface without lightening the label; focus has the supplied blue ring.
- **Section panel:** section heading and optional action, content rows separated by hairlines. Default and dark variants share geometry. No shadows.
- **Setting row:** label, exact explanatory copy, right-aligned switch or dropdown. Switch uses `role="switch"`, `aria-checked`, a 44px hit target, and selected/unselected colors with 3:1 icon contrast. Mobile stacks the control beneath the text.
- **Buttons and selects:** neutral, primary ink, and danger text variants; all are at least 44px high and have hover, active, disabled, and focus states.
- **Dialog:** native modal with labelled title, exact required confirmation copy, action row, Escape support, and an initial focus target. No background effect beyond a dim backdrop.
- **History summary row:** 10-minute range, title, description, and route link. Hover marks the row; keyboard focus marks the link.
- **Evidence pane:** label/value metadata, URL, match input, source text with `<mark>` highlights. The pane reflows below the article on narrow screens; untrusted text is inserted with text nodes.
- **Status banner:** tonal warning surface with text and optional Allow action. It is announced with `role="status"`.
- **Code block:** mono text wraps rather than forcing page overflow; a Copy control is adjacent.

## 6. Motion & interaction

No ambient animation. A short 120ms color response is used only for hover and pressed controls; `prefers-reduced-motion` disables transitions. Route changes and dialogs are immediate. Prototype mutations remain in memory and affect synthetic examples only. Day source links update the required `#e:` or `#s:` fragment and Evidence selection.

## 7. Depth & surface

Borders and tonal shifts only: `1px solid var(--border)` and `var(--surface)`. There are no shadows, gradients, glass, or decorative layers.

## 8. Accessibility constraints & accepted debt

Target WCAG 2.2 AA: 4.5:1 body text, 3:1 large text/icons, visible keyboard focus, semantic controls, 44px minimum hit targets, native modal focus behavior, meaningful status announcements, and no horizontal scroll at 375px. The supplied blue remains a functional contrast color, not decoration.

| Item | Location | Reason | Exit |
|---|---|---|---|
| Native Side permission and MCP behavior | Browser-only prototype | No Side backend or device permissions are connected | Implement in Side after design approval |
| Route refresh handling | Single HTML preview | The prototype can update History API routes while open; server-side fallback is outside this artifact | Add route fallback in a production host |
