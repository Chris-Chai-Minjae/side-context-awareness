import type { Database } from "bun:sqlite"
import {
  RECALL_CANDIDATE_LIMIT,
  RECALL_MAX_QUERIES,
  RECALL_MAX_TERMS,
  RECALL_RECENCY_BONUS,
  RECALL_RECENCY_WINDOW_MS,
  RECALL_REQUEST_WORDS,
  RECALL_STOP_WORDS,
  RECALL_SUMMARY_LIMIT,
  RECALL_TOTAL_MATCH_WEIGHT,
} from "../constants"
import { deriveSubkey, keyedHash } from "../crypto/index"
import { indexTerms } from "../ledger/terms"

const stopWords = new Set<string>(RECALL_STOP_WORDS)
const requestWords = new Set<string>(RECALL_REQUEST_WORDS)

export type HistorySearchRequest = {
  readonly queries: readonly string[]
  readonly from?: string | number
  readonly to?: string | number
  readonly app?: string
  readonly domain?: string
  readonly limit?: number
  readonly offset?: number
}

export type RecallFilters = {
  readonly from?: number
  readonly to?: number
  readonly app?: string
  readonly domain?: string
}

export class HistorySearchInputError extends Error {
  readonly name = "HistorySearchInputError"
  constructor(message: string) {
    super(message)
  }
}

function bound(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new HistorySearchInputError("History search time must be ISO 8601 or epoch milliseconds")
  return parsed
}

export function filtersFor(request: HistorySearchRequest): RecallFilters {
  const from = bound(request.from)
  const to = bound(request.to)
  if (from !== undefined && to !== undefined && from > to)
    throw new HistorySearchInputError("History search from must not exceed to")
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(request.app ? { app: request.app.normalize("NFKC").toLowerCase() } : {}),
    ...(request.domain ? { domain: request.domain.toLowerCase() } : {}),
  }
}

export function inTime(occurredAt: number, filters: RecallFilters): boolean {
  return (
    (filters.from === undefined || occurredAt >= filters.from) &&
    (filters.to === undefined || occurredAt <= filters.to)
  )
}

export function recallTerms(queries: readonly string[]): readonly string[] {
  const terms = new Set<string>()
  for (const query of queries.slice(0, RECALL_MAX_QUERIES)) {
    const tokens =
      query
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? []
    for (const token of tokens) {
      if (stopWords.has(token) || requestWords.has(token)) continue
      terms.add(token)
      if (terms.size === RECALL_MAX_TERMS) return [...terms]
    }
  }
  return [...terms]
}

export type EventCandidate = {
  readonly id: string
  readonly occurred_at: number
  readonly app_name: string
  readonly bundle_id: string
  readonly window_title: string
  readonly url: string | null
  readonly domain: string | null
  readonly payload: string
  readonly blob_id: string | null
}

export type SummaryCandidate = {
  readonly id: string
  readonly window_from: number
  readonly window_to: number
  readonly title: string
  readonly description: string
  readonly body: string | null
  readonly apps: string
  readonly domains: string
}

export function matchScore(
  text: string,
  terms: readonly string[],
  occurredAt: number,
  now: number,
): number {
  const haystack = text.normalize("NFKC").toLowerCase()
  let unique = 0
  let total = 0
  for (const term of terms) {
    let index = haystack.indexOf(term)
    if (index === -1) continue
    unique++
    while (index !== -1) {
      total++
      index = haystack.indexOf(term, index + term.length)
    }
  }
  if (unique === 0) return 0
  const age = Math.max(0, now - occurredAt)
  return (
    unique +
    RECALL_TOTAL_MATCH_WEIGHT * total +
    RECALL_RECENCY_BONUS / (1 + age / RECALL_RECENCY_WINDOW_MS)
  )
}

export function eventCandidates(
  db: Database,
  masterKey: Buffer,
  terms: readonly string[],
): readonly EventCandidate[] {
  const termsKey = deriveSubkey(masterKey, "terms")
  const hashes = indexTerms(terms.join(" ")).map((term) => keyedHash(term, termsKey))
  if (hashes.length === 0) return []
  return db
    .query<EventCandidate, [string, number]>(`
    SELECT e.id, e.occurred_at, e.app_name, e.bundle_id, e.window_title,
      e.url, e.domain, e.payload, e.blob_id
    FROM side_terms t JOIN context_awareness_events e ON e.id = t.event_id
    WHERE t.term_hash IN (SELECT value FROM json_each(?))
    GROUP BY e.id ORDER BY COUNT(*) DESC, e.occurred_at DESC
    LIMIT ?
  `)
    .all(JSON.stringify(hashes), RECALL_CANDIDATE_LIMIT)
}

export function summaryCandidates(
  db: Database,
  terms: readonly string[],
  bounds: { readonly from?: number; readonly to?: number },
): readonly SummaryCandidate[] {
  const matches = terms.map(
    () => "(title LIKE ? OR description LIKE ? OR COALESCE(body, '') LIKE ?)",
  )
  const bindings: (string | number)[] = terms.flatMap((term) => [
    `%${term}%`,
    `%${term}%`,
    `%${term}%`,
  ])
  let sql = `SELECT id, window_from, window_to, title, description, body, apps, domains
    FROM context_awareness_summaries WHERE status = 'done' AND (${matches.join(" OR ")})`
  if (bounds.from !== undefined) {
    sql += " AND window_to >= ?"
    bindings.push(bounds.from)
  }
  if (bounds.to !== undefined) {
    sql += " AND window_from <= ?"
    bindings.push(bounds.to)
  }
  sql += " ORDER BY window_from DESC LIMIT ?"
  bindings.push(RECALL_SUMMARY_LIMIT)
  return db.query<SummaryCandidate, (string | number)[]>(sql).all(...bindings)
}
