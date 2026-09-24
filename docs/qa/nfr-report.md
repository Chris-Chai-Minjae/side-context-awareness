# P5-T5.4 NFR benchmark evidence

2026-09-24 JST, macOS arm64, Bun 1.3.5. This is a **partial measurement** of the approved `08-nfr-test-gates.md` §1 budgets. The task remains unchecked until the bundled `Side.app`, its daemon and helper, a normal provider, and a full eight-hour app run have been measured. All generated content was fictional and stored only in temporary `side-nfr-*` directories, removed after each run. No Aside ledger rows or user captures were read.

## Results

| Approved item | Target | Current measurement | Evidence and limit |
|---|---:|---:|---|
| Daemon CPU, 10-minute mean | ≤2% of one core | **Unmeasured** | `cpu.ts` samples the actual daemon PID with `ps -o %cpu`; bundled daemon PID pending. |
| Side.app CPU, 10-minute mean | ≤1% of one core | **Unmeasured** | Same script samples actual app PID; bundled app PID pending. |
| Daemon RSS, unloaded / embedding loaded | ≤150 / ≤350 MiB | **Unmeasured** | `rss.ts` samples `ps -o rss` and reports mean and peak; requires separate real daemon states. |
| Capture trigger → ledger commit p95, without / with OCR | ≤1.5 / ≤4 s | **Unmeasured end to end**; ledger write-to-visible-row proxy p95 **1.34 ms** (120 fictional events) | `latency.ts` uses `writeLedgerEvent` and confirms the row. Scheduled captures now store `triggerAt` in their encrypted event payload. The proxy excludes AX/Swift helper, OCR, and daemon transport; it is not the full gate. |
| Eight-hour disk footprint and day page | ≤60 MB/day; page ≤200 KB | **0.854 MB** total (847,872 ledger and sidecar bytes + 5,871 page bytes); 96 events, 48 summaries, 96 sealed blobs | `disk.ts` runs real ledger writes, frame sealing, and day-page rendering on one synthetic eight-hour day. It excludes `index.db`, logs, and real capture variability, so the 60 MB app target is still unverified. The page proxy is below 200 KB. |
| `history_search` p95, 14 days | ≤300 ms | **21.01 ms** client round trip; **20 ms** MCP log | `latency.ts --real-embedding`: 120 measured MCP stdio → UDS → actual handler/SQLite calls after 8 warmups; 14 days and 1,344 fictional events. Excludes bundled app resource contention and real browser-history provider. |
| `memory_search` p95, cold load excluded | ≤500 ms | **7.95 ms** client round trip; **7 ms** MCP log | Same 120-call path with real warmed MiniLM q8 inference and 672 indexed fictional chunks. Excludes bundled app resource contention. |
| Window end → day-page summary, normal provider | ≤3 min | **Unmeasured** | A normal provider and the running app's summary queue are needed. `summaryLagMs` is available for timestamp calculation but no synthetic timestamp was presented as a production measurement. |

## Reproduction

```sh
bun run scripts/bench/cpu.ts --daemon-pid <daemon-pid> --app-pid <app-pid> --seconds 600
bun run scripts/bench/rss.ts --daemon-pid <daemon-pid> --seconds 600
bun run scripts/bench/latency.ts --real-embedding
bun run scripts/bench/disk.ts
```

`cpu.ts` reports the arithmetic mean of `ps` samples. `rss.ts` converts KiB to MiB and reports mean and peak. Both fail if the target PID disappears. Run RSS once before loading the embedding model and again after it is loaded. The real embedding latency command uses existing 14-day benchmark fixture code, stores its fixture in a separate temporary directory, and cleans it after measurement.

## Verification and remaining gate

TDD RED: `bun test tests/bench/nfr.test.ts` failed because the bench modules did not exist. GREEN: six focused tests passed, including real synthetic ledger and day-page work. `bun test`: final rerun 711 passed, 0 failed (one prior full run returned 710/1 with failure detail lost to a tail-only capture); `npx tsc --noEmit`: exit 0; `npx biome check .`: exit 0; `swift test --package-path apps/side-mac`: exit 0. Real MiniLM latency and synthetic disk commands exited 0.

The measured synthetic paths are under their respective thresholds. No below-target result needs an issue link yet. The missing bundled measurements are the open P5-T5.4 gate in [approved tasks](../planning/06-tasks.md). `triggerAt` records when the scheduler begins the actual capture request, after its documented debounce and throttle. The ledger event time can estimate capture duration; a strict trigger-to-commit sample still needs a commit-time measurement on the running app. Keep P5-T5.4 unchecked.

## Initial live summary sample (2026-09-24)

The running `/Applications/Side.app` produced one completed 10-minute summary with model metadata `Xiaomi MiMo 2.6 Pro (Singapore Token Plan)/mimo-v2.6-pro`. A metadata-only query of Side's own ledger measured `created_at - window_to = 35,109 ms`, `updated_at - created_at = 549,608 ms`, and `updated_at - window_to = 584,717 ms`; `attempt_count = 2` and the recorded provider duration was about 80 seconds. This initial window overlapped onboarding and provider configuration, so it is not a normal-provider latency sample for the approved ≤3-minute budget. The 9.7-minute observed total is retained here rather than presented as a pass. No summary body, event text, title, URL, or Aside ledger row was read.
