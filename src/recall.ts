import type { ContextStore, SearchOptions, SearchResult, StoredSummary } from "./store"

export type Evidence = {
  readonly id: string
  readonly at: string
  readonly title: string
  readonly excerpt: string
  readonly url: string | null
  readonly app: string | null
  readonly untrusted: true
}

function fromEvent(event: SearchResult): Evidence {
  return {
    id: `e:${event.id}`,
    at: new Date(event.capturedAt).toISOString(),
    title: event.windowTitle,
    excerpt: event.text.slice(0, 300),
    url: event.url,
    app: event.appName,
    untrusted: true,
  }
}

function fromSummary(summary: StoredSummary): Evidence {
  return {
    id: `s:${summary.id}`,
    at: new Date(summary.windowFrom).toISOString(),
    title: summary.title,
    excerpt: summary.body.slice(0, 300),
    url: null,
    app: null,
    untrusted: true,
  }
}

export function historySearch(
  store: ContextStore,
  queries: readonly string[],
  options: SearchOptions = {},
): readonly Evidence[] {
  const seen = new Set<string>()
  const results: Evidence[] = []
  for (const query of queries.slice(0, 8)) {
    const perQueryOptions = { ...options, limit: 100, offset: 0 }
    const events = store.search(query, perQueryOptions).map(fromEvent)
    const summaries =
      options.app || options.domain
        ? []
        : store.searchSummaries(query, perQueryOptions).map(fromSummary)
    for (const item of [...events, ...summaries]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      results.push(item)
    }
  }
  return results.slice(
    options.offset ?? 0,
    (options.offset ?? 0) + Math.min(options.limit ?? 20, 100),
  )
}

export function historyRead(
  store: ContextStore,
  id: string,
  match?: string,
  contextLines = 10,
): unknown {
  const identifier = /^([es]):(\d+)$/u.exec(id)
  if (!identifier) throw new Error("Evidence ID must be e:<number> or s:<number>")
  const numericId = Number(identifier[2])
  const source = identifier[1] === "e" ? store.readEvent(numericId) : store.readSummary(numericId)
  if (!source) return null
  const text = "text" in source ? source.text : source.body
  const lines = text.split("\n")
  const found = match
    ? lines.findIndex((line) => line.toLowerCase().includes(match.toLowerCase()))
    : 0
  const center = Math.max(0, found)
  const start = Math.max(0, center - Math.min(contextLines, 100))
  const end = Math.min(lines.length, center + Math.min(contextLines, 100) + 1)
  const metadata =
    "text" in source
      ? {
          at: new Date(source.capturedAt).toISOString(),
          title: source.windowTitle,
          app: source.appName,
          url: source.url,
          kind: source.kind,
        }
      : {
          at: new Date(source.windowFrom).toISOString(),
          title: source.title,
          kind: source.kind,
          sourceIds: source.sourceIds,
        }
  return {
    id,
    untrusted: true,
    ...metadata,
    passage: lines.slice(start, end).join("\n"),
    passageStartLine: start + 1,
  }
}
