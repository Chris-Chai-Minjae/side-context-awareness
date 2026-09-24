import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

const SearchResult = z.object({
  status: z.string(),
  dataset: z.object({ days: z.number(), events: z.number() }),
  routes: z.array(
    z.object({
      name: z.enum(["history_search", "memory_search"]),
      measuredCalls: z.number(),
      roundTripP95Ms: z.number(),
      mcpLogP95Ms: z.number(),
    }),
  ),
})

export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0 || fraction <= 0 || fraction > 1) {
    throw new RangeError("Invalid percentile input")
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0
}

export function summaryLagMs(windowTo: number, updatedAt: number): number {
  if (updatedAt < windowTo) throw new RangeError("Summary precedes window end")
  return updatedAt - windowTo
}

export function measureLedgerCommit(samples = 120): {
  readonly p95Ms: number
  readonly samples: number
} {
  const root = mkdtempSync(join(tmpdir(), "side-nfr-latency-"))
  const key = Buffer.alloc(32, 0x42)
  try {
    const db = openLedger(join(root, "ledger.db"))
    try {
      const timings: number[] = []
      for (let index = 0; index < samples; index++) {
        const started = performance.now()
        const result = writeLedgerEvent(db, key, {
          occurredAt: Date.now() + index,
          source: "mac_ax",
          kind: "content.snapshot",
          appName: "Synthetic Browser",
          windowTitle: `Synthetic window ${index}`,
          content: `Fabricated capture ${index} about a fictional document.`,
        })
        if (!db.query("SELECT 1 FROM context_awareness_events WHERE id = ?").get(result.id)) {
          throw new Error("Ledger commit not visible")
        }
        timings.push(performance.now() - started)
      }
      return { p95Ms: percentile(timings, 0.95), samples }
    } finally {
      db.close()
    }
  } finally {
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const capture = measureLedgerCommit()
  const realEmbedding = process.argv.includes("--real-embedding")
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dir, "../gates/g7b-benchmark.ts"),
      ...(realEmbedding ? ["--real-embedding"] : []),
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 8 },
  )
  if (result.status !== 0) throw new Error(`MCP benchmark failed: ${result.stderr.trim()}`)
  const search = SearchResult.parse(JSON.parse(result.stdout.trim()))
  console.log(
    JSON.stringify({
      scope: "synthetic data; real ledger commit and MCP search paths",
      captureCommitOnly: capture,
      captureTriggerToCommit: "unmeasured: no live AX/OCR helper or commit-time samples",
      captureOcr: "unmeasured: no AX/OCR helper",
      search: {
        dataset: search.dataset,
        embedding: realEmbedding ? "real MiniLM q8" : "deterministic synthetic vector",
        routes: search.routes,
      },
      summaryWindowToPage: "unmeasured: normal provider and bundled app required",
    }),
  )
}
