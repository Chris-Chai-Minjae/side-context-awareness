import type { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EMBEDDING_DIMENSIONS, MS_PER_DAY } from "../../src/constants"
import { writeLedgerEvent } from "../../src/ledger/write"
import { syncMemoryIndex } from "../../src/memory/sync"

export const BENCHMARK_DAYS = 14
export const WINDOWS_PER_DAY = 48
export const CAPTURES_PER_WINDOW = 2

const FIRST_DAY = Date.UTC(2026, 8, 10)
export const SYNTHETIC_TOPICS = ["sqlite", "vector", "browser", "scheduler"] as const

export type FixtureSize = {
  readonly firstDay: string
  readonly lastDay: string
  readonly days: number
  readonly events: number
  readonly summaries: number
  readonly chunks: number
  readonly termRows: number
  readonly dayPagesBytes: number
}

type FixtureOptions = {
  readonly root: string
  readonly ledgerDb: Database
  readonly indexDb: Database
  readonly masterKey: Buffer
  readonly embedder: { readonly embed: (text: string) => Promise<Float32Array> }
}

function clockLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
}

// The default benchmark isolates MCP, SQL, FTS, and vec0 latency from model inference.
export const syntheticEmbedder = {
  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(EMBEDDING_DIMENSIONS)
    const topic = SYNTHETIC_TOPICS.find((candidate) => text.toLowerCase().includes(candidate))
    vector[topic === undefined ? SYNTHETIC_TOPICS.length : SYNTHETIC_TOPICS.indexOf(topic)] = 1
    return vector
  },
}

export async function createSyntheticFixture({
  root,
  ledgerDb,
  indexDb,
  masterKey,
  embedder,
}: FixtureOptions): Promise<FixtureSize> {
  const pages = join(root, "memory", "episodic")
  mkdirSync(pages, { recursive: true })
  const insertSummary = ledgerDb.query(`
    INSERT INTO context_awareness_summaries
      (id, kind, window_from, window_to, created_at, updated_at,
       title, description, body, apps, domains, status)
    VALUES (?, 'window', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')
  `)
  let dayPagesBytes = 0

  for (let dayOffset = 0; dayOffset < BENCHMARK_DAYS; dayOffset++) {
    const day = new Date(FIRST_DAY + dayOffset * MS_PER_DAY).toISOString().slice(0, 10)
    const dayStart = Date.parse(`${day}T09:00:00+09:00`)
    const lines = [`# Context awareness — ${day}`, ""]
    for (let window = 0; window < WINDOWS_PER_DAY; window++) {
      const topic =
        SYNTHETIC_TOPICS[(dayOffset * WINDOWS_PER_DAY + window) % SYNTHETIC_TOPICS.length]
      if (topic === undefined) throw new RangeError("Missing synthetic topic")
      const summaryId = `synthetic-summary-${dayOffset}-${window}`
      const fromMinute = 9 * 60 + window * 10
      const windowStart = dayStart + window * 10 * 60_000
      const title = `Synthetic ${topic} reference ${dayOffset}-${window}`
      const description = `${topic} reference notes for a fictional project.`
      lines.push(
        `### ${clockLabel(fromMinute)} – ${clockLabel(fromMinute + 10)} — ${title}  s:${summaryId}`,
        `${description} The team compared a guide, an example, and a test case.`,
        "",
      )
      insertSummary.run(
        summaryId,
        windowStart,
        windowStart + 10 * 60_000,
        windowStart,
        windowStart,
        title,
        description,
        `${topic} reference analysis from a fully synthetic example.`,
        '["Synthetic Browser"]',
        '["fixture.invalid"]',
      )
      for (let capture = 0; capture < CAPTURES_PER_WINDOW; capture++) {
        writeLedgerEvent(ledgerDb, masterKey, {
          occurredAt: windowStart + capture * 60_000,
          source: "mac_ax",
          kind: "content.snapshot",
          appName: "Synthetic Browser",
          bundleId: "invalid.fixture.browser",
          windowTitle: title,
          url: `https://fixture.invalid/${day}/${window}/${capture}`,
          content: `${description} Capture ${capture} contains only fabricated documentation.`,
        })
      }
    }
    const page = `${lines.join("\n")}\n`
    dayPagesBytes += Buffer.byteLength(page)
    writeFileSync(join(pages, `context-awareness-${day}.md`), page)
  }

  const indexed = await syncMemoryIndex({
    ledgerDb,
    indexDb,
    dataDir: root,
    embedder,
  })
  if (indexed.status !== "committed") throw new Error("Synthetic index sync was discarded")
  const count = (db: Database, table: string): number => {
    const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
    if (row === null) throw new Error(`Synthetic ${table} count is missing`)
    return row.count
  }
  const events = count(ledgerDb, "context_awareness_events")
  const summaries = count(ledgerDb, "context_awareness_summaries")
  const chunks = count(indexDb, "chunks")
  const vectors = count(indexDb, "chunks_vec")
  if (
    events !== BENCHMARK_DAYS * WINDOWS_PER_DAY * CAPTURES_PER_WINDOW ||
    summaries !== BENCHMARK_DAYS * WINDOWS_PER_DAY ||
    chunks !== BENCHMARK_DAYS * WINDOWS_PER_DAY ||
    vectors !== chunks
  )
    throw new Error("Synthetic dataset size does not match its generation plan")
  return {
    firstDay: new Date(FIRST_DAY).toISOString().slice(0, 10),
    lastDay: new Date(FIRST_DAY + (BENCHMARK_DAYS - 1) * MS_PER_DAY).toISOString().slice(0, 10),
    days: BENCHMARK_DAYS,
    events,
    summaries,
    chunks,
    termRows: count(ledgerDb, "side_terms"),
    dayPagesBytes,
  }
}
