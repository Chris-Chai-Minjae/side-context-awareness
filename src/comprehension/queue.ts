import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import {
  LATE_COMMIT_RESCAN_MS,
  MAX_ATTEMPTS,
  MAX_JOBS_PER_PASS,
  MS_PER_DAY,
  RETRY_DELAYS_MS,
  RUNNING_LEASE_MS,
  TEN_MINUTES_MS,
} from "../constants"

export type SummaryJob = {
  readonly id: string
  readonly kind: "10min" | "6h"
  readonly window_from: number
  readonly window_to: number
  readonly status: "running"
  readonly attempt_count: number
  readonly lease_expires_at: number
}

export type SummaryCompletion = {
  readonly title: string
  readonly description: readonly string[]
  readonly body: string
  readonly apps: readonly string[]
  readonly domains: readonly string[]
  readonly citations: readonly {
    readonly ref: string
    readonly title?: string
    readonly url?: string
  }[]
  readonly sourceIds: readonly string[]
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly durationMs: number
}

function tenMinuteStart(time: number): number {
  const offset = new Date(time).getTimezoneOffset() * 60_000
  return Math.floor((time - offset) / TEN_MINUTES_MS) * TEN_MINUTES_MS + offset
}

function sixHourStart(time: number): number {
  const date = new Date(time)
  date.setHours(Math.floor(date.getHours() / 6) * 6, 0, 0, 0)
  return date.getTime()
}

function sixHourEnd(from: number): number {
  const date = new Date(from)
  date.setHours(date.getHours() + 6)
  return date.getTime()
}

function generationKey(from: number): string {
  return `summary_generation_10min:${from}`
}

function bumpGeneration(db: Database, from: number): void {
  db.query(`
    INSERT INTO side_meta (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
  `).run(generationKey(from))
}

export function recordCommittedEventForSummary(db: Database, occurredAt: number): void {
  bumpGeneration(db, tenMinuteStart(occurredAt))
}

export function pruneSummaryMarkers(db: Database, now: number, retentionDays: number): void {
  const cutoff = now - retentionDays * MS_PER_DAY
  db.transaction(() => {
    const markPrefix = "summary_non_glance_event:"
    db.query(`
      DELETE FROM side_meta
      WHERE substr(key, 1, ?) = ?
        AND (CAST(value AS INTEGER) + ? < ? OR NOT EXISTS (
          SELECT 1 FROM context_awareness_events AS e WHERE key = ? || e.id
        ))
    `).run(markPrefix.length, markPrefix, TEN_MINUTES_MS, cutoff, markPrefix)

    const retainedWindows = new Set(
      db
        .query<{ value: string }, [number, string]>(`
        SELECT value FROM side_meta WHERE substr(key, 1, ?) = ?
      `)
        .all(markPrefix.length, markPrefix)
        .map((row) => row.value),
    )
    const keys = db
      .query<{ key: string }, []>(`
      SELECT key FROM side_meta
      WHERE substr(key, 1, 25) = 'summary_generation_10min:'
         OR substr(key, 1, 33) = 'summary_claimed_generation_10min:'
    `)
      .all()
    for (const { key } of keys) {
      const from = Number(key.slice(key.lastIndexOf(":") + 1))
      if (from + TEN_MINUTES_MS < cutoff || !retainedWindows.has(String(from))) {
        db.query("DELETE FROM side_meta WHERE key = ?").run(key)
      }
    }
  })()
}

export function markNonGlanceEvent(db: Database, eventId: string, occurredAt: number): void {
  const from = tenMinuteStart(occurredAt)
  db.transaction(() => {
    const inserted = db
      .query(`
        INSERT OR IGNORE INTO side_meta (key, value)
        SELECT ?, ? WHERE EXISTS (
          SELECT 1 FROM context_awareness_events WHERE id = ? AND occurred_at = ?
        )
      `)
      .run(`summary_non_glance_event:${eventId}`, String(from), eventId, occurredAt)
    if (inserted.changes > 0) bumpGeneration(db, from)
  })()
}

function generation(db: Database, from: number): number {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM side_meta WHERE key = ?")
    .get(generationKey(from))
  return Number(row?.value ?? 0)
}

function hasSource(
  db: Database,
  job: Pick<SummaryJob, "kind" | "window_from" | "window_to">,
  cutoff = 0,
): boolean {
  if (job.kind === "10min") {
    return Boolean(
      db
        .query<{ id: string }, [number, number]>(`
        SELECT e.id FROM context_awareness_events AS e
        JOIN side_meta AS mark ON mark.key = 'summary_non_glance_event:' || e.id
        WHERE e.occurred_at >= ? AND e.occurred_at < ? LIMIT 1
      `)
        .get(Math.max(job.window_from, cutoff), job.window_to),
    )
  }
  return Boolean(
    db
      .query<{ id: string }, [number, number, number]>(`
      SELECT id FROM context_awareness_summaries
      WHERE kind = '10min' AND status = 'done'
        AND window_from >= ? AND window_to <= ? AND window_to > ? LIMIT 1
    `)
      .get(job.window_from, job.window_to, cutoff),
  )
}

export function enqueueSummaryJobs(db: Database, now: number): void {
  const closedTo = tenMinuteStart(now)
  db.transaction(() => {
    const previous = db
      .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'last_enqueued_10min'")
      .get()?.value
    const previousTo = previous === undefined ? null : Number(previous)
    const scanFrom = previousTo === null ? 0 : Math.max(0, previousTo - LATE_COMMIT_RESCAN_MS)
    const events = db
      .query<{ id: string; occurred_at: number }, [number, number]>(`
        SELECT e.id, e.occurred_at FROM context_awareness_events AS e
        JOIN side_meta AS mark ON mark.key = 'summary_non_glance_event:' || e.id
        WHERE e.occurred_at >= ? AND e.occurred_at < ? ORDER BY e.occurred_at
      `)
      .all(scanFrom, closedTo)
    const insert = db.query(`
      INSERT OR IGNORE INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, available_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const seen = new Set<number>()
    for (const event of events) {
      const from = tenMinuteStart(event.occurred_at)
      if (seen.has(from)) continue
      seen.add(from)
      insert.run(ulid(now), "10min", from, from + TEN_MINUTES_MS, now, now, now)
      const claimedGeneration = Number(
        db
          .query<{ value: string }, [string]>("SELECT value FROM side_meta WHERE key = ?")
          .get(`summary_claimed_generation_10min:${from}`)?.value ?? 0,
      )
      if (generation(db, from) > claimedGeneration) {
        db.query(`
          UPDATE context_awareness_summaries
          SET status = 'pending', attempt_count = 0, available_at = ?, lease_expires_at = NULL,
              error = NULL, digested_at = NULL, updated_at = ?
          WHERE kind = '10min' AND window_from = ? AND window_to = ? AND status = 'done'
        `).run(now, now, from, from + TEN_MINUTES_MS)
      }
    }

    const children = db
      .query<{ window_from: number }, [number]>(`
        SELECT window_from FROM context_awareness_summaries
        WHERE kind = '10min' AND window_to <= ? ORDER BY window_from
      `)
      .all(now)
    const sixHourWindows = new Set<number>()
    for (const child of children) {
      const from = sixHourStart(child.window_from)
      const to = sixHourEnd(from)
      if (to > now || sixHourWindows.has(from)) continue
      sixHourWindows.add(from)
      const childStates = db
        .query<{ status: string }, [number, number]>(`
          SELECT status FROM context_awareness_summaries
          WHERE kind = '10min' AND window_from >= ? AND window_to <= ?
        `)
        .all(from, to)
      if (
        childStates.some((childState) => childState.status === "done") &&
        childStates.every((childState) => ["done", "failed", "skipped"].includes(childState.status))
      ) {
        insert.run(ulid(now), "6h", from, to, now, now, now)
      }
    }

    db.query(`
      INSERT INTO side_meta (key, value) VALUES ('last_enqueued_10min', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(Math.max(previousTo ?? 0, closedTo)))
  })()
}

export function claimSummaryJobs(db: Database, now: number): readonly SummaryJob[] {
  return db.transaction(() => {
    db.query(`
      UPDATE context_awareness_summaries
      SET status = 'failed', lease_expires_at = NULL,
          error = 'lease expired after final attempt', updated_at = ?
      WHERE status = 'running' AND lease_expires_at < ? AND attempt_count >= ?
    `).run(now, now, MAX_ATTEMPTS)

    const claimed = db
      .query<SummaryJob, [number, number, number, number]>(`
        UPDATE context_awareness_summaries
        SET status = 'running', lease_expires_at = ?, attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id IN (
          SELECT id FROM context_awareness_summaries
          WHERE ((status = 'pending' AND available_at <= ?)
              OR (status = 'running' AND lease_expires_at < ?))
            AND attempt_count < ${MAX_ATTEMPTS}
          ORDER BY kind = '6h', window_from
          LIMIT ${MAX_JOBS_PER_PASS}
        )
        RETURNING *
      `)
      .all(now + RUNNING_LEASE_MS, now, now, now)

    const ready: SummaryJob[] = []
    for (const job of claimed) {
      if (hasSource(db, job)) {
        if (job.kind === "10min") {
          db.query(`
            INSERT INTO side_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(
            `summary_claimed_generation_10min:${job.window_from}`,
            String(generation(db, job.window_from)),
          )
        }
        ready.push(job)
        continue
      }
      db.query(`
        UPDATE context_awareness_summaries
        SET status = 'skipped', lease_expires_at = NULL,
            error = 'sources were cleared before processing', updated_at = ?
        WHERE id = ? AND status = 'running' AND attempt_count = ?
      `).run(now, job.id, job.attempt_count)
    }
    return ready
  })()
}

export function requeueFailedSummaryJob(
  db: Database,
  id: string,
  now: number,
  retentionDays: number,
): boolean {
  return db.transaction(() => {
    const job = db
      .query<SummaryJob, [string]>(`
      SELECT kind, window_from, window_to FROM context_awareness_summaries
      WHERE id = ? AND status = 'failed'
    `)
      .get(id)
    const cutoff = now - retentionDays * MS_PER_DAY
    if (!job || job.window_to < cutoff || !hasSource(db, job, cutoff)) {
      return false
    }
    return (
      db
        .query(`
      UPDATE context_awareness_summaries
      SET status = 'pending', attempt_count = 0, available_at = ?, lease_expires_at = NULL,
          error = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `)
        .run(now, now, id).changes === 1
    )
  })()
}

export function failSummaryJob(db: Database, job: SummaryJob, now: number, error: string): void {
  const retryDelay = RETRY_DELAYS_MS[job.attempt_count - 1]
  const exhausted = job.attempt_count >= MAX_ATTEMPTS
  db.query(`
    UPDATE context_awareness_summaries
    SET status = ?, available_at = ?, lease_expires_at = NULL, error = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND attempt_count = ? AND lease_expires_at = ?
  `).run(
    exhausted ? "failed" : "pending",
    exhausted ? now : now + (retryDelay ?? 0),
    error,
    now,
    job.id,
    job.attempt_count,
    job.lease_expires_at,
  )
}

export function completeSummaryJob(
  db: Database,
  job: SummaryJob,
  now: number,
  result: SummaryCompletion,
): boolean {
  return (
    db
      .query(`
    UPDATE context_awareness_summaries
    SET status = 'done', title = ?, description = ?, body = ?, apps = ?, domains = ?,
        citations = ?, source_ids = ?, model = ?, input_tokens = ?, output_tokens = ?,
        duration_ms = ?, updated_at = ?, digested_at = NULL, lease_expires_at = NULL, error = NULL
    WHERE id = ? AND status = 'running' AND attempt_count = ? AND lease_expires_at = ?
  `)
      .run(
        result.title,
        JSON.stringify(result.description),
        result.body,
        JSON.stringify(result.apps),
        JSON.stringify(result.domains),
        JSON.stringify(result.citations),
        JSON.stringify(result.sourceIds),
        result.model,
        result.inputTokens,
        result.outputTokens,
        result.durationMs,
        now,
        job.id,
        job.attempt_count,
        job.lease_expires_at,
      ).changes === 1
  )
}
