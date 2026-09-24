import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sealColdBlobs } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { renderContextAwarenessDayPage } from "../../src/memory/render"

export function footprintBytes(sizes: readonly number[]): number {
  if (sizes.length === 0 || sizes.some((size) => size < 0)) {
    throw new RangeError("Invalid footprint sizes")
  }
  return sizes.reduce((sum, size) => sum + size, 0)
}

function size(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export async function measureEightHourDisk(): Promise<{
  readonly ledgerBytes: number
  readonly dayPageBytes: number
  readonly totalBytes: number
  readonly events: number
  readonly summaries: number
  readonly sealedBlobs: number
}> {
  const root = mkdtempSync(join(tmpdir(), "side-nfr-disk-"))
  const key = Buffer.alloc(32, 0x42)
  const day = "2026-09-20"
  const dayStart = new Date(2026, 8, 20, 9).getTime()
  try {
    const ledger = join(root, "ledger.db")
    const db = openLedger(ledger)
    try {
      for (let window = 0; window < 48; window++) {
        const windowFrom = dayStart + window * 600_000
        for (let capture = 0; capture < 2; capture++) {
          writeLedgerEvent(db, key, {
            occurredAt: windowFrom + capture * 60_000,
            source: "mac_ax",
            kind: "content.snapshot",
            appName: "Synthetic Browser",
            windowTitle: `Synthetic document ${window}`,
            content: `Fabricated reference ${window}-${capture}: ${"fictional research note ".repeat(40)}`,
          })
        }
        db.query(`
          INSERT INTO context_awareness_summaries
            (id, kind, window_from, window_to, created_at, updated_at,
             title, description, body, status)
          VALUES (?, '10min', ?, ?, ?, ?, ?, '[]', ?, 'done')
        `).run(
          `synthetic-${window}`,
          windowFrom,
          windowFrom + 600_000,
          windowFrom,
          windowFrom + 600_000,
          `Synthetic summary ${window}`,
          `Fabricated summary for fictional document ${window}.`,
        )
      }
      let sealedBlobs = 0
      for (let attempt = 0; attempt < 20; attempt++) {
        const sealed = sealColdBlobs(db, key, dayStart + 86_400_000)
        sealedBlobs += sealed
        if (sealed === 0) break
      }
      const rendered = await renderContextAwarenessDayPage(db, root, day, dayStart + 86_400_000)
      if (rendered.status !== "committed") throw new Error("Day page was not committed")
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      const ledgerBytes = footprintBytes([
        size(ledger),
        size(`${ledger}-wal`),
        size(`${ledger}-shm`),
      ])
      const dayPageBytes = size(join(root, "memory", "episodic", `context-awareness-${day}.md`))
      return {
        ledgerBytes,
        dayPageBytes,
        totalBytes: ledgerBytes + dayPageBytes,
        events: 96,
        summaries: 48,
        sealedBlobs,
      }
    } finally {
      db.close()
    }
  } finally {
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  console.log(
    JSON.stringify({
      scope:
        "synthetic 8-hour day; real ledger write, frame seal, and day-page render; no index.db",
      ...(await measureEightHourDisk()),
    }),
  )
}
