import type { Database } from "bun:sqlite"
import { renderContextAwarenessDayPage } from "./render"

export type DigestResult = {
  readonly days: number
  readonly summaries: number
  readonly failed: number
}

function localDay(at: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

export async function digestContextAwareness(
  db: Database,
  dataDir: string,
  now = Date.now(),
): Promise<DigestResult> {
  const stale = db
    .query<{ window_from: number }, []>(`
      SELECT DISTINCT window_from FROM context_awareness_summaries
      WHERE status = 'done' AND kind IN ('10min', '6h')
        AND (digested_at IS NULL OR updated_at > digested_at)
    `)
    .all()
  const dirty = db
    .query<{ key: string }, []>("SELECT key FROM side_meta WHERE key LIKE 'dirty_day:%'")
    .all()
  const days = new Set([
    ...stale.map(({ window_from }) => localDay(window_from)),
    ...dirty.map(({ key }) => key.slice("dirty_day:".length)),
  ])
  let rendered = 0
  let summaries = 0
  let failed = 0
  for (const day of [...days].sort()) {
    try {
      const result = await renderContextAwarenessDayPage(db, dataDir, day, now)
      if (result.status !== "committed") continue
      rendered++
      summaries += result.value.summaries
    } catch {
      failed++
    }
  }
  return { days: rendered, summaries, failed }
}
