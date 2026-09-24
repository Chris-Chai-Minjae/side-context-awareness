import type { Database } from "bun:sqlite"
import {
  CA_HYBRID_ALPHA,
  CA_MEMORY_SEARCH_MAX_LIMIT,
  CA_SIBLING_ADJACENCY_MINUTES,
  CA_SIBLING_DEMOTION,
  CA_THREAD_HALFLIFE_DAYS,
  CA_WINDOW_HALFLIFE_DAYS,
  MS_PER_DAY,
  SNIPPET_CHARS,
} from "../constants"
import { selectPassages } from "../recall/passages"
import { searchNearest } from "./index-db"

export type MemorySearchRequest = {
  readonly query: string
  readonly limit?: number
  readonly from?: string | number
  readonly to?: string | number
}

export type MemorySearchContext = {
  readonly indexDb: Database
  readonly embedder: { readonly embed: (text: string) => Promise<Float32Array> }
  readonly now?: number
}

export type MemorySearchResult = {
  readonly chunkId: string
  readonly day: string
  readonly windowFrom: string | null
  readonly windowTo: string | null
  readonly heading: string
  readonly snippet: string
  readonly summaryId: string | null
  readonly score: number
}

type IndexedRow = {
  readonly id: string
  readonly path: string
  readonly day: string
  readonly windowFrom: number | null
  readonly windowTo: number | null
  readonly heading: string
  readonly text: string
  readonly summaryId: string | null
}

type ScoredRow = {
  readonly row: IndexedRow
  readonly score: number
}

export class MemorySearchInputError extends Error {
  readonly name = "MemorySearchInputError"
  constructor(message: string) {
    super(message)
  }
}

function timeBound(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new MemorySearchInputError("Memory search time must be ISO 8601 or epoch milliseconds")
  return parsed
}

function minuteLabel(value: number | null): string | null {
  if (value === null) return null
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
}

function adjacent(left: IndexedRow, right: IndexedRow): boolean {
  if (
    left.path !== right.path ||
    left.summaryId === null ||
    right.summaryId === null ||
    left.windowFrom === null ||
    left.windowTo === null ||
    right.windowFrom === null ||
    right.windowTo === null
  )
    return false
  return (
    left.windowFrom <= right.windowTo + CA_SIBLING_ADJACENCY_MINUTES &&
    right.windowFrom <= left.windowTo + CA_SIBLING_ADJACENCY_MINUTES
  )
}

export async function memorySearch(
  context: MemorySearchContext,
  request: MemorySearchRequest,
): Promise<readonly MemorySearchResult[]> {
  const query = request.query.normalize("NFKC").trim()
  if (query.length === 0) return []
  const limit = request.limit ?? CA_MEMORY_SEARCH_MAX_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CA_MEMORY_SEARCH_MAX_LIMIT)
    throw new MemorySearchInputError(
      `Memory search limit must be 1 to ${CA_MEMORY_SEARCH_MAX_LIMIT}`,
    )
  const from = timeBound(request.from)
  const to = timeBound(request.to)
  if (from !== undefined && to !== undefined && from > to)
    throw new MemorySearchInputError("Memory search from must not exceed to")

  const { indexDb } = context
  const count =
    indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()?.count ?? 0
  if (count === 0) return []
  const embedding = await context.embedder.embed(query)
  const distances = new Map(
    searchNearest(indexDb, embedding, count).map(({ id, distance }) => [id, distance]),
  )
  const matches = /[\p{L}\p{N}]{3,}/u.test(query)
    ? indexDb
        .query<{ id: string; rank: number }, [string]>(
          `SELECT c.id, bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ?`,
        )
        .all(`"${query.replaceAll('"', '""')}"`)
    : []
  const strongest = matches.reduce((best, match) => Math.max(best, -match.rank), 0)
  const lexical = new Map(
    matches.map(({ id, rank }) => [id, strongest === 0 ? 0 : Math.max(0, -rank) / strongest]),
  )
  const rows = indexDb
    .query<IndexedRow, []>(
      `SELECT id, path, day, window_from AS windowFrom, window_to AS windowTo,
        heading, text, summary_id AS summaryId FROM chunks`,
    )
    .all()
  const now = context.now ?? Date.now()
  const remaining: ScoredRow[] = []
  for (const row of rows) {
    const timestamp = new Date(`${row.day}T00:00:00`).getTime() + (row.windowFrom ?? 0) * 60_000
    if ((from !== undefined && timestamp < from) || (to !== undefined && timestamp > to)) continue
    const distance = distances.get(row.id)
    if (distance === undefined) continue
    const ageDays = Math.max(0, now - timestamp) / MS_PER_DAY
    const halfLife = row.summaryId === null ? CA_THREAD_HALFLIFE_DAYS : CA_WINDOW_HALFLIFE_DAYS
    const recency = 1 / (1 + ageDays / halfLife)
    const hybrid =
      CA_HYBRID_ALPHA * (1 - distance) + (1 - CA_HYBRID_ALPHA) * (lexical.get(row.id) ?? 0)
    remaining.push({ row, score: (hybrid * (1 + recency)) / 2 })
  }

  const selected: ScoredRow[] = []
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (const [index, candidate] of remaining.entries()) {
      const demoted = selected.some((prior) => adjacent(prior.row, candidate.row))
      const score = candidate.score * (demoted ? CA_SIBLING_DEMOTION : 1)
      const bestId = remaining[bestIndex]?.row.id ?? ""
      if (score > bestScore || (score === bestScore && candidate.row.id < bestId)) {
        bestIndex = index
        bestScore = score
      }
    }
    const [winner] = remaining.splice(bestIndex, 1)
    if (!winner) break
    selected.push({ row: winner.row, score: bestScore })
  }
  return selected.map(({ row, score }) => ({
    chunkId: row.id,
    day: row.day,
    windowFrom: minuteLabel(row.windowFrom),
    windowTo: minuteLabel(row.windowTo),
    heading: row.heading,
    snippet: selectPassages(row.text, [query])[0] ?? row.text.slice(0, SNIPPET_CHARS),
    summaryId: row.summaryId,
    score,
  }))
}
