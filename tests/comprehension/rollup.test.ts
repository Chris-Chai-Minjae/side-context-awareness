import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { enqueueSummaryJobs } from "../../src/comprehension/queue"
import { assembleRollupBriefing } from "../../src/comprehension/rollup"
import { CHILD_BODY_BYTES, TEN_MINUTES_MS } from "../../src/constants"
import { openLedger } from "../../src/ledger/schema"

test("Given 30 done and 6 failed children, when the six-hour window closes, then only done summaries enter the rollup briefing", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-rollup-"))
  const db = openLedger(join(directory, "ledger.db"))
  const from = new Date(2026, 8, 24, 0, 0).getTime()
  const to = new Date(2026, 8, 24, 6, 0).getTime()
  const doneIds: string[] = []
  try {
    for (let index = 0; index < 36; index++) {
      const id = ulid(from + index)
      const done = index < 30
      if (done) doneIds.push(id)
      db.query(`
        INSERT INTO context_awareness_summaries
          (id, kind, window_from, window_to, created_at, updated_at, status,
           title, description, body, apps, domains)
        VALUES (?, '10min', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        from + index * TEN_MINUTES_MS,
        from + (index + 1) * TEN_MINUTES_MS,
        from,
        from,
        done ? "done" : "failed",
        done ? `Done ${index}` : `Failed ${index}`,
        JSON.stringify([`Description ${index}`]),
        index === 0 ? "🌱".repeat(1_000) : `Body ${index}`,
        JSON.stringify(["Synthetic Browser"]),
        JSON.stringify(["fixture.invalid"]),
      )
    }

    enqueueSummaryJobs(db, to)
    expect(
      db
        .query<{ status: string }, []>(
          "SELECT status FROM context_awareness_summaries WHERE kind = '6h'",
        )
        .all(),
    ).toEqual([{ status: "pending" }])

    const briefing = assembleRollupBriefing(db, from, to)
    expect(briefing.evidenceIds).toEqual(new Set(doneIds.map((id) => `s:${id}`)))
    expect(briefing.text).toContain(`s:${doneIds[0]}`)
    expect(briefing.text).toContain("Done 29")
    expect(briefing.text).not.toContain("Failed 30")
    expect(briefing.text.indexOf("Done 0")).toBeLessThan(briefing.text.indexOf("Done 29"))
    expect(briefing.apps).toEqual(new Set(["Synthetic Browser"]))
    expect(briefing.domains).toEqual(new Set(["fixture.invalid"]))
    const firstBody = briefing.text.match(/Body: ([^\n]*)/)?.[1]
    expect(firstBody).toBeDefined()
    expect(Buffer.byteLength(firstBody ?? "", "utf8")).toBeLessThanOrEqual(CHILD_BODY_BYTES)
    expect(firstBody).not.toContain("�")
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
