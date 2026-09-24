import type { Database } from "bun:sqlite"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { FOOTPRINT_TTL_MS } from "../constants"

export type DayCounters = {
  readonly events: number
  readonly blobs: number
  readonly rawBytes: number
  readonly suppressions: number
  readonly masks: number
  readonly sessions: number
  readonly lastEventAt?: number
}

export type LedgerStatsSnapshot = {
  readonly events: number
  readonly blobs: number
  readonly storeBytes: number
  readonly rawBytes: number
  readonly frames: number
  readonly sessions: number
  readonly lastEventAt?: number
  readonly suppressions: number
  readonly today: DayCounters
}

type EventTotals = {
  readonly events: number
  readonly sessions: number
  readonly lastEventAt: number | null
}

type BlobTotals = { readonly blobs: number; readonly rawBytes: number }
type TodayTotals = {
  readonly events: number
  readonly blobs: number
  readonly rawBytes: number
  readonly suppressions: number
  readonly masks: number
}

export class LedgerStats {
  // This mutable value is the five-minute footprint cache.
  private cachedFootprint: { readonly measuredAt: number; readonly bytes: number } | null = null

  constructor(
    private readonly db: Database,
    private readonly directory: string,
  ) {}

  invalidateFootprint(): void {
    this.cachedFootprint = null
  }

  footprint(now: number): number {
    const cached = this.cachedFootprint
    if (cached && now >= cached.measuredAt && now - cached.measuredAt < FOOTPRINT_TTL_MS)
      return cached.bytes

    const pageCount = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()
    const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()
    if (!pageCount || !pageSize) throw new Error("Ledger page accounting is unavailable")
    let bytes = pageCount.page_count * pageSize.page_size
    bytes += statSync(join(this.directory, "index.db"), { throwIfNoEntry: false })?.size ?? 0

    const pageDirectory = join(this.directory, "memory", "episodic")
    let entries: string[]
    try {
      entries = readdirSync(pageDirectory)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") entries = []
      else throw error
    }
    for (const entry of entries) {
      if (!/^context-awareness-\d{4}-\d{2}-\d{2}\.md$/u.test(entry)) continue
      bytes += statSync(join(pageDirectory, entry), { throwIfNoEntry: false })?.size ?? 0
    }

    this.cachedFootprint = { measuredAt: now, bytes }
    return bytes
  }

  snapshot(now: number): LedgerStatsSnapshot {
    const events = this.db
      .query<EventTotals, []>(`
        SELECT COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
               MAX(occurred_at) AS lastEventAt
        FROM context_awareness_events
      `)
      .get()
    const blobs = this.db
      .query<BlobTotals, []>(`
        SELECT COUNT(*) AS blobs, COALESCE(SUM(redacted_bytes), 0) AS rawBytes
        FROM context_awareness_blobs
      `)
      .get()
    const frames = this.db
      .query<{ frames: number }, []>("SELECT COUNT(*) AS frames FROM context_awareness_frames")
      .get()
    const suppressions = this.db
      .query<{ suppressions: number }, []>(
        "SELECT COALESCE(SUM(suppressions), 0) AS suppressions FROM side_day_counters",
      )
      .get()
    if (!events || !blobs || !frames || !suppressions)
      throw new Error("Ledger statistics are unavailable")

    const day = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now)
    const today = this.db
      .query<TodayTotals, [string]>(`
        SELECT COALESCE(events, 0) AS events, COALESCE(blobs, 0) AS blobs,
               COALESCE(raw_bytes, 0) AS rawBytes,
               COALESCE(suppressions, 0) AS suppressions, COALESCE(masks, 0) AS masks
        FROM side_day_counters WHERE day = ?
      `)
      .get(day)
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    const nextMidnight = new Date(midnight)
    nextMidnight.setDate(nextMidnight.getDate() + 1)
    const todayEvents = this.db
      .query<Pick<EventTotals, "sessions" | "lastEventAt">, [number, number]>(`
        SELECT COUNT(DISTINCT session_id) AS sessions, MAX(occurred_at) AS lastEventAt
        FROM context_awareness_events WHERE occurred_at >= ? AND occurred_at < ?
      `)
      .get(midnight.getTime(), nextMidnight.getTime())
    if (!todayEvents) throw new Error("Ledger day statistics are unavailable")

    return {
      events: events.events,
      blobs: blobs.blobs,
      storeBytes: this.footprint(now),
      rawBytes: blobs.rawBytes,
      frames: frames.frames,
      sessions: events.sessions,
      ...(events.lastEventAt === null ? {} : { lastEventAt: events.lastEventAt }),
      suppressions: suppressions.suppressions,
      today: {
        events: today?.events ?? 0,
        blobs: today?.blobs ?? 0,
        rawBytes: today?.rawBytes ?? 0,
        suppressions: today?.suppressions ?? 0,
        masks: today?.masks ?? 0,
        sessions: todayEvents.sessions,
        ...(todayEvents.lastEventAt === null ? {} : { lastEventAt: todayEvents.lastEventAt }),
      },
    }
  }
}
