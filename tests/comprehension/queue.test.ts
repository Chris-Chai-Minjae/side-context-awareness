import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claimSummaryJobs,
  completeSummaryJob,
  enqueueSummaryJobs,
  failSummaryJob,
  markNonGlanceEvent,
  pruneSummaryMarkers,
  recordCommittedEventForSummary,
  requeueFailedSummaryJob,
} from "../../src/comprehension/queue"
import {
  MAX_ATTEMPTS,
  MS_PER_DAY,
  RETRY_DELAYS_MS,
  RUNNING_LEASE_MS,
  TEN_MINUTES_MS,
} from "../../src/constants"
import { openLedger } from "../../src/ledger/schema"
import { FakeClock } from "../mocks/fake-clock"

const start = new Date(2026, 8, 24, 10, 0).getTime()

function withLedger(run: (db: Database, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-queue-"))
  const path = join(directory, "ledger.db")
  const db = openLedger(path)
  try {
    run(db, path)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function insertEvent(db: Database, id: string, occurredAt: number): void {
  db.query(
    "INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload) VALUES (?, ?, 'test', 'content.snapshot', '{}')",
  ).run(id, occurredAt)
  recordCommittedEventForSummary(db, occurredAt)
}

function insertJob(
  db: Database,
  id: string,
  windowFrom: number,
  status = "pending",
  attemptCount = 0,
  leaseExpiresAt: number | null = null,
): void {
  db.query(`
    INSERT INTO context_awareness_summaries
      (id, kind, window_from, window_to, created_at, updated_at, status, attempt_count,
       available_at, lease_expires_at)
    VALUES (?, '10min', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    windowFrom,
    windowFrom + TEN_MINUTES_MS,
    start,
    start,
    status,
    attemptCount,
    start,
    leaseExpiresAt,
  )
}

type State = {
  readonly status: string
  readonly attempt_count: number
  readonly available_at: number
  readonly lease_expires_at: number | null
  readonly error: string | null
}

function state(db: Database, id: string): State {
  const row = db
    .query<State, [string]>(
      "SELECT status, attempt_count, available_at, lease_expires_at, error FROM context_awareness_summaries WHERE id = ?",
    )
    .get(id)
  if (!row) throw new Error("Synthetic summary row missing")
  return row
}

type WindowRow = {
  readonly kind: string
  readonly window_from: number
  readonly window_to: number
  readonly status: string
}

function windows(db: Database, kind: string): readonly WindowRow[] {
  return db
    .query<WindowRow, [string]>(`
      SELECT kind, window_from, window_to, status FROM context_awareness_summaries
      WHERE kind = ? ORDER BY window_from
    `)
    .all(kind)
}

describe("comprehension queue enqueue", () => {
  test("Given generation storage fails, when marking a non-glance event, then no orphan marker commits", () => {
    withLedger((db) => {
      insertEvent(db, "e-atomic-mark", start + 1)
      db.exec(`
        CREATE TRIGGER fail_summary_generation
        BEFORE UPDATE ON side_meta
        WHEN NEW.key LIKE 'summary_generation_10min:%'
        BEGIN SELECT RAISE(ABORT, 'synthetic generation failure'); END;
      `)

      expect(() => markNonGlanceEvent(db, "e-atomic-mark", start + 1)).toThrow()
      expect(
        db
          .query<{ value: string }, [string]>("SELECT value FROM side_meta WHERE key = ?")
          .get("summary_non_glance_event:e-atomic-mark"),
      ).toBeNull()
    })
  })

  test("Given cleared and retained events, when pruning metadata, then only orphan marks and generations are removed", () => {
    withLedger((db) => {
      insertEvent(db, "e-cleared-mark", start + 1)
      markNonGlanceEvent(db, "e-cleared-mark", start + 1)
      insertEvent(db, "e-retained-mark", start + TEN_MINUTES_MS + 1)
      markNonGlanceEvent(db, "e-retained-mark", start + TEN_MINUTES_MS + 1)
      db.query("DELETE FROM context_awareness_events WHERE id = 'e-cleared-mark'").run()

      pruneSummaryMarkers(db, start + 2 * TEN_MINUTES_MS, 1)

      const keys = db
        .query<{ key: string }, []>(`
        SELECT key FROM side_meta WHERE key LIKE 'summary_%' ORDER BY key
      `)
        .all()
        .map((row) => row.key)
      expect(keys).toEqual([
        `summary_generation_10min:${start + TEN_MINUTES_MS}`,
        "summary_non_glance_event:e-retained-mark",
      ])
    })
  })

  test("Given events across local ten-minute boundaries, when enqueue runs, then only closed active windows are queued", () => {
    withLedger((db) => {
      const localTen = new Date(2026, 8, 24, 10, 0).getTime()
      insertEvent(db, "e-first", localTen + 2 * 60_000)
      insertEvent(db, "e-second", localTen + 12 * 60_000)
      insertEvent(db, "e-open", localTen + 20 * 60_000)
      markNonGlanceEvent(db, "e-first", localTen + 2 * 60_000)
      markNonGlanceEvent(db, "e-second", localTen + 12 * 60_000)

      enqueueSummaryJobs(db, localTen + 21 * 60_000)

      expect(windows(db, "10min")).toEqual([
        {
          kind: "10min",
          window_from: localTen,
          window_to: localTen + TEN_MINUTES_MS,
          status: "pending",
        },
        {
          kind: "10min",
          window_from: localTen + TEN_MINUTES_MS,
          window_to: localTen + 2 * TEN_MINUTES_MS,
          status: "pending",
        },
      ])
    })
  })

  test("Given only a brief glance, when its window closes, then no summary job is created", () => {
    withLedger((db) => {
      insertEvent(db, "e-glance", start + 1)

      enqueueSummaryJobs(db, start + TEN_MINUTES_MS)

      expect(windows(db, "10min")).toEqual([])
    })
  })

  test("Given a digested window and a late event, when a new process rescans, then it becomes pending once", () => {
    withLedger((db, path) => {
      insertEvent(db, "e-original", start + 1)
      markNonGlanceEvent(db, "e-original", start + 1)
      const closedAt = start + TEN_MINUTES_MS
      enqueueSummaryJobs(db, closedAt)
      const [claim] = claimSummaryJobs(db, closedAt)
      if (!claim) throw new Error("Expected synthetic claim")
      db.query(`
        UPDATE context_awareness_summaries
        SET status = 'done', digested_at = ?, attempt_count = 2
        WHERE id = ?
      `).run(closedAt, claim.id)
      insertEvent(db, "e-late", start + 2)

      const reopened = openLedger(path)
      try {
        enqueueSummaryJobs(reopened, closedAt + 60_000)
        expect(state(reopened, claim.id)).toMatchObject({ status: "pending", attempt_count: 0 })
        enqueueSummaryJobs(reopened, closedAt + 2 * 60_000)
        expect(windows(reopened, "10min")).toHaveLength(1)
      } finally {
        reopened.close()
      }
    })
  })

  test("Given only a glance remains after clearing, when enqueue rescans, then a stale mark cannot recreate the job", () => {
    withLedger((db) => {
      insertEvent(db, "e-stay", start + 1)
      markNonGlanceEvent(db, "e-stay", start + 1)
      insertEvent(db, "e-glance", start + 2)
      db.query("DELETE FROM context_awareness_events WHERE id = 'e-stay'").run()

      enqueueSummaryJobs(db, start + TEN_MINUTES_MS)

      expect(windows(db, "10min")).toEqual([])
    })
  })

  test("Given 30 done and six failed children, when the local six-hour window closes, then a rollup is queued", () => {
    withLedger((db) => {
      const midnight = new Date(2026, 8, 24, 0, 0).getTime()
      const six = new Date(2026, 8, 24, 6, 0).getTime()
      const insert = db.query(`
        INSERT INTO context_awareness_summaries
          (id, kind, window_from, window_to, created_at, updated_at, status)
        VALUES (?, '10min', ?, ?, ?, ?, ?)
      `)
      for (let index = 0; index < 36; index += 1) {
        const from = midnight + index * TEN_MINUTES_MS
        insert.run(
          `s-child-${index}`,
          from,
          from + TEN_MINUTES_MS,
          start,
          start,
          index < 30 ? "done" : "failed",
        )
      }

      enqueueSummaryJobs(db, six + 1)

      expect(windows(db, "6h")).toEqual([
        { kind: "6h", window_from: midnight, window_to: six, status: "pending" },
      ])
    })
  })
})

describe("comprehension queue claim and retry", () => {
  test("Given only evidence older than retention in a boundary window, when manually requeued, then it stays failed", () => {
    withLedger((db) => {
      const from = start - MS_PER_DAY
      insertEvent(db, "e-expired-boundary", from + 2 * 60_000)
      markNonGlanceEvent(db, "e-expired-boundary", from + 2 * 60_000)
      insertJob(db, "s-expired-boundary", from, "failed", MAX_ATTEMPTS)

      const requeued = requeueFailedSummaryJob(db, "s-expired-boundary", start + 5 * 60_000, 1)

      expect(requeued).toBe(false)
      expect(state(db, "s-expired-boundary").status).toBe("failed")
    })
  })

  test("Given a reclaimed lease, when the old and current owners complete, then only the current result is stored", () => {
    withLedger((db) => {
      const clock = new FakeClock(start)
      insertEvent(db, "e-complete", start + 1)
      markNonGlanceEvent(db, "e-complete", start + 1)
      insertJob(db, "s-complete", start)
      const [oldClaim] = claimSummaryJobs(db, clock.now())
      if (!oldClaim) throw new Error("Expected original synthetic claim")
      clock.advanceBy(RUNNING_LEASE_MS + 1)
      const [currentClaim] = claimSummaryJobs(db, clock.now())
      if (!currentClaim) throw new Error("Expected reclaimed synthetic claim")
      const result = {
        title: "Synthetic work",
        description: ["One synthetic action"],
        body: "One synthetic action\n\nSynthetic memory",
        apps: ["TestApp"],
        domains: ["example.test"],
        citations: [{ ref: "e:synthetic" }],
        sourceIds: ["e:synthetic"],
        model: "test/model",
        inputTokens: 12,
        outputTokens: 8,
        durationMs: 45,
      }

      expect(completeSummaryJob(db, oldClaim, clock.now(), result)).toBe(false)
      expect(completeSummaryJob(db, currentClaim, clock.now(), result)).toBe(true)
      expect(
        db
          .query<
            {
              status: string
              title: string
              description: string
              body: string
              apps: string
              source_ids: string
              model: string
              input_tokens: number
              output_tokens: number
              duration_ms: number
              digested_at: number | null
            },
            [string]
          >(`
          SELECT status, title, description, body, apps, source_ids, model,
                 input_tokens, output_tokens, duration_ms, digested_at
          FROM context_awareness_summaries WHERE id = ?
        `)
          .get(currentClaim.id),
      ).toMatchObject({
        status: "done",
        title: result.title,
        description: JSON.stringify(result.description),
        body: result.body,
        apps: JSON.stringify(result.apps),
        source_ids: JSON.stringify(result.sourceIds),
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        duration_ms: result.durationMs,
        digested_at: null,
      })
    })
  })

  test("Given an old failed job, when manually requeued, then retention and surviving sources both gate it", () => {
    withLedger((db) => {
      const oldFrom = start - 2 * MS_PER_DAY
      insertEvent(db, "e-old", oldFrom + 1)
      markNonGlanceEvent(db, "e-old", oldFrom + 1)
      insertJob(db, "s-old", oldFrom, "failed", MAX_ATTEMPTS)

      expect(requeueFailedSummaryJob(db, "s-old", start, 1)).toBe(false)
      expect(state(db, "s-old").status).toBe("failed")
      expect(requeueFailedSummaryJob(db, "s-old", start, 3)).toBe(true)
      expect(state(db, "s-old")).toMatchObject({ status: "pending", attempt_count: 0 })

      db.query("UPDATE context_awareness_summaries SET status = 'failed' WHERE id = 's-old'").run()
      db.query("DELETE FROM context_awareness_events WHERE id = 'e-old'").run()
      expect(requeueFailedSummaryJob(db, "s-old", start, 3)).toBe(false)
      expect(state(db, "s-old").status).toBe("failed")
    })
  })

  test("Given a queued window whose evidence was cleared, when claiming, then it is skipped", () => {
    withLedger((db) => {
      insertJob(db, "s-cleared", start)

      const claims = claimSummaryJobs(db, start)

      expect(claims).toEqual([])
      expect(state(db, "s-cleared")).toMatchObject({
        status: "skipped",
        error: "sources were cleared before processing",
      })
    })
  })

  test("Given a third lease that expires, when claiming again, then no fourth attempt starts", () => {
    withLedger((db) => {
      insertEvent(db, "e-final-lease", start + 1)
      insertJob(db, "s-final-lease", start, "running", MAX_ATTEMPTS, start - 1)

      const claims = claimSummaryJobs(db, start)

      expect(claims).toEqual([])
      expect(state(db, "s-final-lease")).toMatchObject({
        status: "failed",
        attempt_count: MAX_ATTEMPTS,
      })
    })
  })

  test("Given an expired lease and a second connection, when claiming, then only one worker receives the job", () => {
    withLedger((db, path) => {
      const clock = new FakeClock(start)
      insertEvent(db, "e-lease", start + 1)
      markNonGlanceEvent(db, "e-lease", start + 1)
      insertJob(db, "s-lease", start, "running", 1, clock.now() - 1)
      const second = openLedger(path)
      try {
        const firstClaim = claimSummaryJobs(db, clock.now())
        const secondClaim = claimSummaryJobs(second, clock.now())

        expect(firstClaim.map((job) => job.id)).toEqual(["s-lease"])
        expect(secondClaim).toEqual([])
        expect(state(db, "s-lease")).toMatchObject({
          status: "running",
          attempt_count: 2,
          lease_expires_at: clock.now() + RUNNING_LEASE_MS,
        })
      } finally {
        second.close()
      }
    })
  })

  test("Given two failed attempts, when the third claim fails, then the job is failed at attempt three", () => {
    withLedger((db) => {
      const clock = new FakeClock(start)
      insertEvent(db, "e-retry", start + 1)
      markNonGlanceEvent(db, "e-retry", start + 1)
      insertJob(db, "s-retry", start)

      for (const delay of RETRY_DELAYS_MS) {
        const [claim] = claimSummaryJobs(db, clock.now())
        if (!claim) throw new Error("Expected synthetic claim")
        failSummaryJob(db, claim, clock.now(), "synthetic provider failure")
        expect(claimSummaryJobs(db, clock.now())).toEqual([])
        expect(state(db, claim.id)).toMatchObject({
          status: "pending",
          available_at: clock.now() + delay,
        })
        clock.advanceBy(delay)
      }

      const [thirdClaim] = claimSummaryJobs(db, clock.now())
      if (!thirdClaim) throw new Error("Expected third synthetic claim")
      failSummaryJob(db, thirdClaim, clock.now(), "synthetic final failure")

      expect(state(db, thirdClaim.id)).toMatchObject({
        status: "failed",
        attempt_count: MAX_ATTEMPTS,
        lease_expires_at: null,
        error: "synthetic final failure",
      })
      expect(claimSummaryJobs(db, clock.now())).toEqual([])
    })
  })
})
