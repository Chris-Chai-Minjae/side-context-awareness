import type { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { RpcMethods } from "../../contracts/rpc"
import { chunkContextAwarenessDayPage } from "../../memory/chunk"
import { memorySearch } from "../../memory/search"
import type { RpcHandler } from "../rpc"

type MemorySearchDependencies = {
  readonly ledgerDb: Database
  readonly getIndexDb: () => Database
  readonly embedder: { readonly embed: (text: string) => Promise<Float32Array> }
  readonly dataDir: string
  readonly now: () => number
}

type DeletionState = { readonly epoch: string; readonly dirty: boolean }

function deletionState(db: Database): DeletionState {
  const rows = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM side_meta WHERE key = 'deletion_epoch' OR key LIKE 'dirty_day:%'",
    )
    .all()
  return {
    epoch: rows.find((row) => row.key === "deletion_epoch")?.value ?? "0",
    dirty: rows.some((row) => row.key.startsWith("dirty_day:")),
  }
}

async function currentChunkIds(dataDir: string, day: string): Promise<ReadonlySet<string>> {
  const path = `episodic/context-awareness-${day}.md`
  let page: string
  try {
    page = await readFile(join(dataDir, "memory", path), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set()
    throw error
  }
  return new Set(chunkContextAwarenessDayPage(path, page).map((chunk) => chunk.id))
}

export function createMemorySearchHandler(dependencies: MemorySearchDependencies): RpcHandler {
  return async (value) => {
    const request = RpcMethods.memorySearch.input.parse(value)
    const start = deletionState(dependencies.ledgerDb)
    if (start.dirty) return []
    const found = await memorySearch(
      {
        indexDb: dependencies.getIndexDb(),
        embedder: dependencies.embedder,
        now: dependencies.now(),
      },
      {
        query: request.query,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.from === undefined ? {} : { from: request.from }),
        ...(request.to === undefined ? {} : { to: request.to }),
      },
    )
    const results = RpcMethods.memorySearch.output.parse(found)
    const pages = new Map<string, ReadonlySet<string>>()
    for (const hit of results) {
      let ids = pages.get(hit.day)
      if (ids === undefined) {
        ids = await currentChunkIds(dependencies.dataDir, hit.day)
        pages.set(hit.day, ids)
      }
      if (!ids.has(hit.chunkId)) return []
      if (
        hit.summaryId !== null &&
        dependencies.ledgerDb
          .query<{ id: string }, [string]>(
            "SELECT id FROM context_awareness_summaries WHERE id = ? AND status = 'done'",
          )
          .get(hit.summaryId) === null
      )
        return []
    }
    const end = deletionState(dependencies.ledgerDb)
    if (end.dirty || end.epoch !== start.epoch) return []
    return results
  }
}
