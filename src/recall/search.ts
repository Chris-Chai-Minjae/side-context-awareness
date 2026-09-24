import type { Database } from "bun:sqlite"
import {
  RECALL_DEFAULT_LIMIT,
  RECALL_EPOCH_RETRY_LIMIT,
  RECALL_MAX_LIMIT,
  RECALL_MAX_QUERIES,
  TERM_SOURCE_CHARS,
} from "../constants"
import { deriveSubkey, open } from "../crypto/index"
import { readBlobContent } from "../ledger/frames"
import { normalizePageUrl } from "../policy"
import { selectPassages } from "./passages"
import {
  type EventCandidate,
  eventCandidates,
  filtersFor,
  HistorySearchInputError,
  type HistorySearchRequest,
  inTime,
  matchScore,
  type RecallFilters,
  recallTerms,
  type SummaryCandidate,
  summaryCandidates,
} from "./terms"

export type { HistorySearchRequest } from "./terms"
export { HistorySearchInputError } from "./terms"

export type BrowserHistoryEntry = {
  readonly browser: string
  readonly id: string
  readonly occurredAt: number
  readonly app: string
  readonly title: string
  readonly url: string
  readonly domain: string
}

export type HistorySearchContext = {
  readonly db: Database
  readonly masterKey: Buffer
  readonly now?: number
  readonly browserHistory?: (request: {
    readonly terms: readonly string[]
    readonly from?: number
    readonly to?: number
  }) => Promise<readonly BrowserHistoryEntry[]>
}

export type HistorySearchResult = {
  readonly ref: string
  readonly occurredAt: number
  readonly app: string | null
  readonly title: string
  readonly url: string | null
  readonly domain: string | null
  readonly snippet: string
  readonly score: number
}

export class HistorySearchEpochChangedError extends Error {
  readonly name = "HistorySearchEpochChangedError"
  constructor() {
    super("History changed during search")
  }
}

function eventResult(
  context: HistorySearchContext,
  row: EventCandidate,
  terms: readonly string[],
  filters: RecallFilters,
  now: number,
): HistorySearchResult | null {
  if (!inTime(row.occurred_at, filters)) return null
  if (
    filters.app &&
    !row.app_name.toLowerCase().includes(filters.app) &&
    !row.bundle_id.toLowerCase().includes(filters.app)
  )
    return null
  if (filters.domain && row.domain?.toLowerCase() !== filters.domain) return null
  const key = deriveSubkey(context.masterKey, "evidence")
  const title =
    row.window_title === ""
      ? ""
      : open<string>(row.window_title, key, `context_awareness_events:window_title:${row.id}`)
  const url =
    row.url === null ? null : open<string>(row.url, key, `context_awareness_events:url:${row.id}`)
  const payload = open<{ readonly inlineText?: string }>(
    row.payload,
    key,
    `context_awareness_events:payload:${row.id}`,
  )
  const body =
    row.blob_id === null ? "" : (readBlobContent(context.db, context.masterKey, row.blob_id) ?? "")
  const text = [title, payload.inlineText ?? "", body.slice(0, TERM_SOURCE_CHARS)]
    .filter(Boolean)
    .join("\n")
  const score = matchScore(text, terms, row.occurred_at, now)
  if (score === 0) return null
  return {
    ref: `e:${row.id}`,
    occurredAt: row.occurred_at,
    app: row.app_name,
    title,
    url,
    domain: row.domain,
    snippet: selectPassages(text, terms)[0] ?? "",
    score,
  }
}

function jsonStrings(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json)
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : []
}

function summaryResult(
  row: SummaryCandidate,
  terms: readonly string[],
  filters: RecallFilters,
  now: number,
): HistorySearchResult | null {
  const apps = jsonStrings(row.apps)
  const domains = jsonStrings(row.domains)
  if (filters.app && !apps.some((app) => app.toLowerCase().includes(filters.app ?? ""))) return null
  if (filters.domain && !domains.some((domain) => domain.toLowerCase() === filters.domain))
    return null
  const text = [row.title, row.description, row.body ?? ""].filter(Boolean).join("\n")
  const score = matchScore(text, terms, row.window_from, now)
  if (score === 0) return null
  return {
    ref: `s:${row.id}`,
    occurredAt: row.window_from,
    app: apps[0] ?? null,
    title: row.title,
    url: null,
    domain: domains[0] ?? null,
    snippet: selectPassages(text, terms)[0] ?? "",
    score,
  }
}

function browserResult(
  row: BrowserHistoryEntry,
  terms: readonly string[],
  filters: RecallFilters,
  now: number,
): HistorySearchResult | null {
  if (!inTime(row.occurredAt, filters)) return null
  if (filters.app && !row.app.toLowerCase().includes(filters.app)) return null
  const url = normalizePageUrl(row.url)
  if (url === null) return null
  const domain = new URL(url).hostname.toLowerCase()
  if (filters.domain && domain !== filters.domain) return null
  const text = `${row.title}\n${url}`
  const score = matchScore(text, terms, row.occurredAt, now)
  if (score === 0) return null
  return {
    ref: `h:${row.browser}:${row.id}`,
    occurredAt: row.occurredAt,
    app: row.app,
    title: row.title,
    url,
    domain,
    snippet: selectPassages(text, terms)[0] ?? "",
    score,
  }
}

function newestByUrl(results: readonly HistorySearchResult[]): readonly HistorySearchResult[] {
  const byUrl = new Map<string, HistorySearchResult>()
  const withoutUrl: HistorySearchResult[] = []
  for (const result of results) {
    if (result.url === null) {
      withoutUrl.push(result)
      continue
    }
    const previous = byUrl.get(result.url)
    if (!previous || result.occurredAt > previous.occurredAt) byUrl.set(result.url, result)
  }
  return [...withoutUrl, ...byUrl.values()]
}

function deletionEpoch(db: Database): string {
  return (
    db
      .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
      .get()?.value ?? "0"
  )
}

export async function historySearch(
  context: HistorySearchContext,
  request: HistorySearchRequest,
): Promise<readonly HistorySearchResult[]> {
  if (request.queries.length < 1 || request.queries.length > RECALL_MAX_QUERIES)
    throw new HistorySearchInputError(`History search requires 1 to ${RECALL_MAX_QUERIES} queries`)
  const limit = request.limit ?? RECALL_DEFAULT_LIMIT
  const offset = request.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0)
    throw new HistorySearchInputError(
      "History search limit must be positive and offset nonnegative",
    )
  const filters = filtersFor(request)
  const terms = recallTerms(request.queries)
  if (terms.length === 0) return []
  const now = context.now ?? Date.now()
  for (let attempt = 0; attempt <= RECALL_EPOCH_RETRY_LIMIT; attempt++) {
    const started = deletionEpoch(context.db)
    const captures = newestByUrl(
      eventCandidates(context.db, context.masterKey, terms)
        .map((row) => eventResult(context, row, terms, filters, now))
        .filter((result): result is HistorySearchResult => result !== null),
    )
    const summaries = summaryCandidates(context.db, terms, filters)
      .map((row) => summaryResult(row, terms, filters, now))
      .filter((result): result is HistorySearchResult => result !== null)
    const browserRows =
      (await context.browserHistory?.({
        terms,
        ...(filters.from === undefined ? {} : { from: filters.from }),
        ...(filters.to === undefined ? {} : { to: filters.to }),
      })) ?? []
    const capturedUrls = new Set(captures.flatMap((capture) => (capture.url ? [capture.url] : [])))
    const browsing = newestByUrl(
      browserRows
        .map((row) => browserResult(row, terms, filters, now))
        .filter((result): result is HistorySearchResult => result !== null),
    ).filter((result) => result.url === null || !capturedUrls.has(result.url))
    if (started !== deletionEpoch(context.db)) continue
    return [...captures, ...summaries, ...browsing]
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.occurredAt - left.occurredAt ||
          left.ref.localeCompare(right.ref),
      )
      .slice(offset, offset + Math.min(limit, RECALL_MAX_LIMIT))
  }
  throw new HistorySearchEpochChangedError()
}
