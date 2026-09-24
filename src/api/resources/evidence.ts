import type { Database } from "bun:sqlite"
import { RpcMethods } from "../../contracts/rpc"
import { deriveSubkey, open } from "../../crypto/index"
import { HelperUnavailableError } from "../../helper/client"
import { historyRead } from "../../recall/read"
import { type HistorySearchContext, historySearch } from "../../recall/search"
import type { RpcHandlers } from "../rpc"

type EvidenceDependencies = {
  readonly db: Database
  readonly getMasterKey: () => Buffer | null
  readonly browserHistory?: HistorySearchContext["browserHistory"]
}

type EventRow = {
  readonly id: string
  readonly occurred_at: number
  readonly source: string
  readonly kind: string
  readonly app_name: string
  readonly bundle_id: string
  readonly window_title: string
  readonly url: string | null
  readonly domain: string | null
  readonly session_id: string | null
}

async function withKey<T>(
  getMasterKey: () => Buffer | null,
  use: (key: Buffer) => T | Promise<T>,
): Promise<T> {
  const key = getMasterKey()
  if (key === null) throw new HelperUnavailableError()
  try {
    return await use(key)
  } finally {
    key.fill(0)
  }
}

export function createEvidenceHandlers(
  dependencies: EvidenceDependencies,
): Pick<RpcHandlers, "read" | "search" | "events"> {
  return {
    read(value) {
      const request = RpcMethods.read.input.parse(value)
      return withKey(dependencies.getMasterKey, (masterKey) =>
        historyRead({ db: dependencies.db, masterKey }, request),
      )
    },
    search(value) {
      const request = RpcMethods.search.input.parse(value)
      return withKey(dependencies.getMasterKey, async (masterKey) => {
        const found = await historySearch(
          {
            db: dependencies.db,
            masterKey,
            ...(dependencies.browserHistory ? { browserHistory: dependencies.browserHistory } : {}),
          },
          {
            queries: request.queries,
            ...(request.from === undefined ? {} : { from: request.from }),
            ...(request.to === undefined ? {} : { to: request.to }),
            ...(request.app === undefined ? {} : { app: request.app }),
            ...(request.domain === undefined ? {} : { domain: request.domain }),
            ...(request.limit === undefined ? {} : { limit: request.limit }),
            ...(request.offset === undefined ? {} : { offset: request.offset }),
          },
        )
        return found.map((result) => ({ ...result, app: result.app ?? "" }))
      })
    },
    events(value) {
      const { from, to, limit, offset } = RpcMethods.events.input.parse(value)
      if (from > to) throw new RangeError("Event range is reversed")
      return withKey(dependencies.getMasterKey, (masterKey) => {
        const evidenceKey = deriveSubkey(masterKey, "evidence")
        try {
          const rows = dependencies.db
            .query<EventRow, [number, number, number, number]>(`
              SELECT id, occurred_at, source, kind, app_name, bundle_id, window_title,
                url, domain, session_id FROM context_awareness_events
              WHERE occurred_at BETWEEN ? AND ?
              ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
            `)
            .all(from, to, limit, offset)
          return rows.map((row) => ({
            id: row.id,
            occurred_at: row.occurred_at,
            source: row.source,
            kind: row.kind,
            app_name: row.app_name,
            bundle_id: row.bundle_id,
            window_title:
              row.window_title === ""
                ? ""
                : open<string>(
                    row.window_title,
                    evidenceKey,
                    `context_awareness_events:window_title:${row.id}`,
                  ),
            url:
              row.url === null
                ? null
                : open<string>(row.url, evidenceKey, `context_awareness_events:url:${row.id}`),
            domain: row.domain,
            session_id: row.session_id,
          }))
        } finally {
          evidenceKey.fill(0)
        }
      })
    },
  }
}
