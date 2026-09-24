import type { Database } from "bun:sqlite"
import { keyedHash, open, seal } from "./crypto"
import { normalizePageUrl } from "./policy"
import { redactSecrets } from "./redact"

export type Capture = {
  readonly capturedAt: number
  readonly bundleId: string
  readonly appName: string
  readonly windowTitle: string
  readonly url: string | null
  readonly kind: "window" | "ax" | "ocr" | "typed"
  readonly text: string
}

export type SearchResult = Capture & { readonly id: number }
export type Summary = {
  readonly kind: "10min" | "6h"
  readonly windowFrom: number
  readonly windowTo: number
  readonly title: string
  readonly body: string
  readonly sourceIds: readonly number[]
}
export type StoredSummary = Summary & { readonly id: number }
export type SearchOptions = {
  readonly from?: number
  readonly to?: number
  readonly app?: string
  readonly domain?: string
  readonly limit?: number
  readonly offset?: number
}

type RawEvent = { id: number; capturedAt: number; payload: string }
type RawSummary = { id: number; payload: string }

function tokens(input: string, limit = 32): string[] {
  return (
    input
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  ).slice(0, limit)
}

function indexTerms(input: string): string[] {
  const result = new Set<string>()
  for (const word of tokens(input.slice(0, 8_000), 1_000)) {
    result.add(word)
    if (word.length > 2) {
      for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2))
    }
    if (result.size >= 1_500) break
  }
  return [...result]
}

export class ContextStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("Encryption key must be 32 bytes")
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        captured_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(captured_at);
      CREATE TABLE IF NOT EXISTS event_terms (
        term_hash TEXT NOT NULL,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY(term_hash, event_id)
      );
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        window_from INTEGER NOT NULL,
        window_to INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(kind, window_from, window_to)
      );
      CREATE TABLE IF NOT EXISTS memory_vectors (
        summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        vector TEXT NOT NULL,
        PRIMARY KEY(summary_id, model)
      );
    `)
  }

  add(capture: Capture): number | null {
    const safe: Capture = {
      ...capture,
      appName: redactSecrets(capture.appName),
      windowTitle: redactSecrets(capture.windowTitle),
      url: capture.url ? normalizePageUrl(capture.url) : null,
      text: redactSecrets(capture.text),
    }
    const fingerprint = keyedHash(
      JSON.stringify([safe.bundleId, safe.windowTitle, safe.url, safe.kind, safe.text]),
      this.key,
    )
    const latest = this.db
      .query<{ fingerprint: string; capturedAt: number }, [string]>(
        "SELECT fingerprint, captured_at AS capturedAt FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(safe.kind)
    if (
      latest?.fingerprint === fingerprint &&
      safe.capturedAt >= latest.capturedAt &&
      safe.capturedAt - latest.capturedAt < 300_000
    )
      return null

    const insert = this.db.transaction(() => {
      const id = Number(
        this.db
          .query("INSERT INTO events (captured_at, kind, payload, fingerprint) VALUES (?, ?, ?, ?)")
          .run(safe.capturedAt, safe.kind, seal(safe, this.key), fingerprint).lastInsertRowid,
      )
      const statement = this.db.query("INSERT INTO event_terms (term_hash, event_id) VALUES (?, ?)")
      for (const term of indexTerms(`${safe.windowTitle} ${safe.text}`))
        statement.run(keyedHash(term, this.key), id)
      return id
    })
    return insert()
  }

  readEvent(id: number): SearchResult | null {
    const row = this.db
      .query<RawEvent, [number]>(
        "SELECT id, captured_at AS capturedAt, payload FROM events WHERE id = ?",
      )
      .get(id)
    return row ? { ...open<Capture>(row.payload, this.key), id: row.id } : null
  }

  search(query: string, options: SearchOptions = {}): readonly SearchResult[] {
    const words = tokens(query)
    if (words.length === 0) return []
    const hashes = [...new Set(words.flatMap(indexTerms).map((term) => keyedHash(term, this.key)))]
    const placeholders = hashes.map(() => "?").join(",")
    const rows = this.db
      .query<{ id: number }, string[]>(
        `SELECT event_id AS id FROM event_terms WHERE term_hash IN (${placeholders}) GROUP BY event_id ORDER BY count(*) DESC LIMIT 2000`,
      )
      .all(...hashes)
    const matched = rows.flatMap(({ id }) => {
      const event = this.readEvent(id)
      if (!event) return []
      if (options.from !== undefined && event.capturedAt < options.from) return []
      if (options.to !== undefined && event.capturedAt > options.to) return []
      if (options.app && event.bundleId !== options.app && event.appName !== options.app) return []
      if (options.domain && (!event.url || new URL(event.url).hostname !== options.domain))
        return []
      const haystack = `${event.windowTitle} ${event.text}`.normalize("NFKC").toLowerCase()
      const score = words.filter((word) => haystack.includes(word)).length
      return score ? [{ event, score }] : []
    })
    matched.sort(
      (left, right) => right.score - left.score || right.event.capturedAt - left.event.capturedAt,
    )
    return matched
      .slice(options.offset ?? 0, (options.offset ?? 0) + Math.min(options.limit ?? 20, 100))
      .map(({ event }) => event)
  }

  recent(limit = 20): readonly SearchResult[] {
    return this.db
      .query<RawEvent, [number]>(
        "SELECT id, captured_at AS capturedAt, payload FROM events ORDER BY captured_at DESC, id DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => ({ ...open<Capture>(row.payload, this.key), id: row.id }))
  }

  eventsBetween(from: number, to: number): readonly SearchResult[] {
    return this.db
      .query<RawEvent, [number, number]>(
        "SELECT id, captured_at AS capturedAt, payload FROM events WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at, id",
      )
      .all(from, to)
      .map((row) => ({ ...open<Capture>(row.payload, this.key), id: row.id }))
  }

  eventWindows(windowMs: number, before: number): readonly number[] {
    return this.db
      .query<{ windowFrom: number }, [number, number, number]>(
        "SELECT DISTINCT CAST(captured_at / ? AS INTEGER) * ? AS windowFrom FROM events WHERE captured_at < ? ORDER BY windowFrom",
      )
      .all(windowMs, windowMs, before)
      .map((row) => row.windowFrom)
  }

  hasSummary(kind: Summary["kind"], from: number, to: number): boolean {
    return !!this.db
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM summaries WHERE kind = ? AND window_from = ? AND window_to = ?",
      )
      .get(kind, from, to)
  }

  upsertSummary(summary: Summary): number {
    const payload = seal(summary, this.key)
    this.db
      .query(
        `INSERT INTO summaries (kind, window_from, window_to, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, window_from, window_to) DO UPDATE SET payload = excluded.payload`,
      )
      .run(summary.kind, summary.windowFrom, summary.windowTo, payload)
    const row = this.db
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM summaries WHERE kind = ? AND window_from = ? AND window_to = ?",
      )
      .get(summary.kind, summary.windowFrom, summary.windowTo)
    if (!row) throw new Error("Summary write failed")
    this.db.query("DELETE FROM memory_vectors WHERE summary_id = ?").run(row.id)
    return row.id
  }

  readSummary(id: number): StoredSummary | null {
    const row = this.db
      .query<RawSummary, [number]>("SELECT id, payload FROM summaries WHERE id = ?")
      .get(id)
    return row ? { ...open<Summary>(row.payload, this.key), id: row.id } : null
  }

  summariesBetween(from: number, to: number): readonly StoredSummary[] {
    return this.db
      .query<RawSummary, [number, number]>(
        "SELECT id, payload FROM summaries WHERE window_from >= ? AND window_from < ? ORDER BY window_from",
      )
      .all(from, to)
      .map((row) => ({ ...open<Summary>(row.payload, this.key), id: row.id }))
  }

  summaryStarts(): readonly number[] {
    return this.db
      .query<{ windowFrom: number }, []>(
        "SELECT window_from AS windowFrom FROM summaries WHERE kind = '10min' ORDER BY window_from",
      )
      .all()
      .map((row) => row.windowFrom)
  }

  summariesWithoutVectors(model: string, limit = 4): readonly StoredSummary[] {
    return this.db
      .query<RawSummary, [string, number]>(
        `SELECT s.id, s.payload FROM summaries s
       LEFT JOIN memory_vectors v ON v.summary_id = s.id AND v.model = ?
       WHERE v.summary_id IS NULL AND s.kind = '10min' ORDER BY s.window_from LIMIT ?`,
      )
      .all(model, limit)
      .map((row) => ({ ...open<Summary>(row.payload, this.key), id: row.id }))
  }

  putVector(summaryId: number, model: string, vector: readonly number[]): void {
    if (vector.length === 0 || vector.some((number) => !Number.isFinite(number)))
      throw new Error("Invalid embedding vector")
    this.db
      .query("INSERT OR REPLACE INTO memory_vectors (summary_id, model, vector) VALUES (?, ?, ?)")
      .run(summaryId, model, seal(vector, this.key))
  }

  vectors(model: string): readonly { summary: StoredSummary; vector: readonly number[] }[] {
    const rows = this.db
      .query<{ id: number; payload: string; vector: string }, [string]>(
        `SELECT s.id, s.payload, v.vector FROM memory_vectors v
       JOIN summaries s ON s.id = v.summary_id WHERE v.model = ?`,
      )
      .all(model)
    return rows.map((row) => ({
      summary: { ...open<Summary>(row.payload, this.key), id: row.id },
      vector: open<number[]>(row.vector, this.key),
    }))
  }

  searchSummaries(query: string, options: SearchOptions = {}): readonly StoredSummary[] {
    const words = tokens(query)
    if (words.length === 0) return []
    const rows = this.db
      .query<RawSummary, []>("SELECT id, payload FROM summaries ORDER BY window_from DESC")
      .all()
    return rows
      .flatMap((row) => {
        const summary = { ...open<Summary>(row.payload, this.key), id: row.id }
        if (options.from !== undefined && summary.windowTo < options.from) return []
        if (options.to !== undefined && summary.windowFrom > options.to) return []
        const haystack = `${summary.title} ${summary.body}`.normalize("NFKC").toLowerCase()
        return words.some((word) => haystack.includes(word)) ? [summary] : []
      })
      .slice(0, Math.min(options.limit ?? 20, 100))
  }

  prune(now: number, retentionDays: number): void {
    this.db.query("DELETE FROM events WHERE captured_at < ?").run(now - retentionDays * 86_400_000)
  }

  clearSince(from: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM events WHERE captured_at >= ?").run(from)
      this.db.exec("DELETE FROM summaries")
    })()
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM events; DELETE FROM summaries")
    })()
    this.db.exec("VACUUM")
  }
}
