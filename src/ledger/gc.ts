import type { Database } from "bun:sqlite"
import { pruneSummaryMarkers } from "../comprehension/queue"
import { MS_PER_DAY, VACUUM_SLACK_MIN_BYTES } from "../constants"
import { compactFrame } from "./frames"

export type LedgerGcResult = {
  readonly deletedEvents: number
  readonly deletedBlobs: number
  readonly deletedFrames: number
  readonly compactedFrames: number
}

export class LedgerCheckpointBusyError extends Error {
  constructor() {
    super("WAL checkpoint could not truncate while a reader is active")
    this.name = "LedgerCheckpointBusyError"
  }
}

export function runLedgerGc(
  db: Database,
  masterKey: Buffer,
  options: { readonly now: number; readonly retentionDays: number },
): LedgerGcResult {
  const cutoff = options.now - options.retentionDays * MS_PER_DAY
  const deleted = db.transaction(() => {
    const changes = db.query<{ count: number }, []>("SELECT changes() AS count")
    db.query("DELETE FROM context_awareness_events WHERE occurred_at < ?").run(cutoff)
    const deletedEvents = changes.get()?.count ?? 0
    db.query(`
        DELETE FROM context_awareness_blobs
        WHERE NOT EXISTS (
          SELECT 1 FROM context_awareness_events
          WHERE context_awareness_events.blob_id = context_awareness_blobs.id
        )
      `).run()
    const deletedBlobs = changes.get()?.count ?? 0
    db.query(`
        DELETE FROM context_awareness_frames
        WHERE NOT EXISTS (
          SELECT 1 FROM context_awareness_blobs
          WHERE context_awareness_blobs.frame_id = context_awareness_frames.id
        )
      `).run()
    const deletedFrames = changes.get()?.count ?? 0
    const degraded = db
      .query<{ id: string }, []>(`
        SELECT frames.id
        FROM context_awareness_frames AS frames
        JOIN context_awareness_blobs AS blobs ON blobs.frame_id = frames.id
        GROUP BY frames.id
        HAVING COUNT(*) * 2 <= frames.member_count
      `)
      .all()
    let compactedFrames = 0
    for (const frame of degraded) {
      if (compactFrame(db, masterKey, frame.id, options.now)) compactedFrames++
    }
    pruneSummaryMarkers(db, options.now, options.retentionDays)
    return { deletedEvents, deletedBlobs, deletedFrames, compactedFrames }
  })()

  db.exec("PRAGMA incremental_vacuum")
  const freelist = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()
  if (!freelist || !pageSize) throw new Error("Ledger free page accounting is unavailable")
  if (freelist.freelist_count * pageSize.page_size >= VACUUM_SLACK_MIN_BYTES) db.exec("VACUUM")
  const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
  if (checkpoint?.busy !== 0) throw new LedgerCheckpointBusyError()
  return deleted
}
