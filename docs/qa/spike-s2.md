# Spike S-2 — Chromium AX activation

## Reproduce

Run `swift scripts/spikes/s2-ax.swift --inventory` first. After an exclusive desktop slot is granted, keep each browser on a stable, ordinary page and run `swift scripts/spikes/s2-ax.swift --measure BrowserName` for each running browser. The script neither launches nor focuses apps, opens tabs, visits pages, nor reads browser URLs or titles. It emits one JSON line per browser containing metrics and AX error codes only. `--inventory` never writes browser AX attributes; `--measure` sets `AXManualAccessibility=true` and also `AXEnhancedUserInterface=true` for Chrome, trying the selected window if the application element rejects an attribute, then restores successful writes at the end.

The probe samples a four-second idle CPU window **before any AX read**, then scans the focused window (main/first window fallback) for `AXStaticText` values beneath each `AXWebArea`. It reports the largest area's UTF-8 byte count without outputting text, so two web areas cannot inflate one page's threshold. It polls for the first complete, nonempty web tree for up to eight seconds after setting the attributes; `firstTreeMs` includes traversal time, or is zero when the complete tree was already present. A second four-second CPU window follows tree polling. CPU is the main browser PID plus recursive child PIDs, from `proc_pidinfo(PROC_PIDTASKINFO)` user+system time converted from Mach ticks; one core at full use is 100%. `cpuDeltaPoints = enabledCPUPercent - baselineCPUPercent`. If a PID disappears or resource accounting is unavailable, the CPU value is null with `cpuNote`. A tree scan stops at 8,000 nodes or four seconds; truncated counts cannot prove the 2,048-byte threshold.

This is a steady-state CPU comparison on one host and one page, not an isolated causal benchmark. A preexisting AX tree or other accessibility client can make the before/after contrast inconclusive. With multiple web areas, the largest area may still differ from the active page; use a controlled page and treat the number as a bounded observation. Closing tabs, scrolling, page loading, or other desktop work during the two CPU windows invalidates comparison. Browser AX activation is transient but can influence the browser while the probe runs.

## Environment and results

Inventory on 2026-09-24: macOS 27.0 arm64, Chrome 153.0.8010.47, Aside 1.0.922.1. This Swift process has Accessibility trust. Aside is running; Chrome is installed but was initially not running; Arc, Brave, and Edge are absent according to Launch Services. The coordinator granted exclusive browser UI slots after S-1 and S-4. Chrome was launched on a synthetic page for measurement, then terminated. For the second Aside run, S-4 had left `AXWindows=0`, so the first two attempts returned `no_ax_window`; a synthetic window was created, measured, and closed. The final state was Aside foreground with `AXWindows=0`. No browser attribute write succeeded. Browser session persistence was not measured; only window count and foreground were restored.

| Browser | Inventory | Before bytes | After bytes | First tree ms | Baseline CPU % | Enabled CPU % | Delta pp | Verdict |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Chrome | installed, launched for probe | 4,347 | 4,347 | 0 (tree preexisting) | 0.268 | 0.110 | −0.158 | activation unavailable |
| Arc | absent | — | — | — | — | — | — | unmeasured |
| Brave | absent | — | — | — | — | — | — | unmeasured |
| Edge | absent | — | — | — | — | — | — | unmeasured |
| Aside | running | 5,599 | 5,599 | 0 (tree preexisting) | 2.570 | 2.836 | +0.266 | activation unavailable |

The final Chrome scan had one `AXWebArea` and 254/255 nodes before/after; the final Aside scan had one `AXWebArea` and 80/80 nodes. Neither scan was truncated, and no restoration error was reported.

The first Aside run summed two `AXWebArea` nodes and reported 5,772 bytes and +1.823 CPU points; that aggregation could not establish the active page's byte count. The final run measured one area, so 5,599 bytes is the applicable observation. The CPU differences across runs also show workload variance; neither can be attributed to an AX setter that failed.

Both measured browsers already had web text before the setter calls, so the observed bytes and CPU changes cannot be attributed to `AXManualAccessibility`. The earlier implementation measured post-set rescans at 22 ms for Chrome and 9 ms for Aside; these are not activation readiness times because the tree was preexisting. Chrome and Aside returned `-25205` (attribute unsupported) for `AXManualAccessibility` on both app and window. Chrome returned `-25208` (not implemented) for `AXEnhancedUserInterface` on the app and `-25205` on the window. The first Chrome post-launch run had zero web bytes before the synthetic page loaded; a later valid tree showed 4,347 bytes in one web area. One additional Chrome CPU window and one Aside CPU window were rejected because the child PID set changed.

S-2 passes for a browser only when an untruncated after tree has at least 2,048 bytes **and** its valid activation-attributable CPU delta is at most 1.0 percentage point. Neither measured browser establishes that activation works. The raw final CPU deltas are within 1.0 point but are background drift when all attribute writes fail. Missing apps, missing TCC permission, no AX window, unsupported attributes, truncated trees, or unavailable CPU are bounded inconclusive results. The parent coordinator owns any architecture decision and the planning checklist.

Final verification: `swiftc -typecheck scripts/spikes/s2-ax.swift` passed; `swift test --package-path apps/side-mac` passed (1 test); `bun test` passed (60 tests, 0 failures); `npx tsc --noEmit` passed; `npx biome check .` passed (48 files). An earlier Biome run failed on concurrently edited contract files; this worker made no changes outside its two owned files.
