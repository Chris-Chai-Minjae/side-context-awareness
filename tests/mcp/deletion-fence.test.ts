import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { createMemorySearchHandler } from "../../src/api/resources/memory"
import { handleRpcBody } from "../../src/api/rpc"
import { CA_INDEX_VERSION, EMBEDDING_DIMENSIONS } from "../../src/constants"
import { clearLedger } from "../../src/ledger/delete"
import { openLedger } from "../../src/ledger/schema"
import { chunkContextAwarenessDayPage } from "../../src/memory/chunk"
import { EMBEDDING_MODEL_ID } from "../../src/memory/embed"
import { openIndexDb, putIndexedChunk } from "../../src/memory/index-db"
import { renderContextAwarenessDayPage } from "../../src/memory/render"

test("P3-T3.8: memorySearch hides a cleared summary before and after delayed index sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-mcp-clear-test-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  const day = "2026-09-24"
  const from = new Date(2026, 8, 24, 9, 10).getTime()
  const to = new Date(2026, 8, 24, 9, 20).getTime()
  const now = new Date(2026, 8, 24, 11, 0).getTime()
  const summaryId = ulid(from)
  const vector = new Float32Array(EMBEDDING_DIMENSIONS)
  let duringEmbed: (() => Promise<void>) | null = null
  vector[0] = 1
  try {
    ledgerDb
      .query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, title,
         description, body, citations, source_ids, status)
      VALUES (?, '10min', ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'done')
    `)
      .run(
        summaryId,
        from,
        to,
        from,
        from,
        "Synthetic SQLite notes",
        '["Synthetic description"]',
        "Synthetic SQLite private summary",
      )
    expect(await renderContextAwarenessDayPage(ledgerDb, root, day, now)).toMatchObject({
      status: "committed",
    })
    const path = `episodic/context-awareness-${day}.md`
    const filename = join(root, "memory", path)
    const chunk = chunkContextAwarenessDayPage(path, readFileSync(filename, "utf8"))[0]
    if (!chunk) throw new Error("Synthetic page had no chunk")
    putIndexedChunk(
      indexDb,
      {
        ...chunk,
        windowFrom: 550,
        windowTo: 560,
        indexVersion: CA_INDEX_VERSION,
        embeddedModel: EMBEDDING_MODEL_ID,
      },
      vector,
    )
    const handler = createMemorySearchHandler({
      ledgerDb,
      getIndexDb: () => indexDb,
      embedder: {
        embed: async () => {
          const action = duringEmbed
          duringEmbed = null
          await action?.()
          return vector
        },
      },
      dataDir: root,
      now: () => now,
    })
    const call = () =>
      handleRpcBody(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "memorySearch",
          params: { query: "SQLite" },
        }),
        { memorySearch: handler },
      )
    expect(await call()).toMatchObject({ result: [{ chunkId: chunk.id }] })

    duringEmbed = async () => {
      const unrelatedClear = await clearLedger(ledgerDb, "last10m", { now })
      expect(unrelatedClear.dirtyDays).toEqual([])
    }
    expect(await call()).toEqual({ jsonrpc: "2.0", id: 1, result: [] })
    expect(existsSync(filename)).toBe(true)

    const cleared = await clearLedger(ledgerDb, "today", { now })
    expect(cleared.dirtyDays).toContain(day)
    expect(existsSync(filename)).toBe(true)
    expect(await call()).toEqual({ jsonrpc: "2.0", id: 1, result: [] })

    expect(await renderContextAwarenessDayPage(ledgerDb, root, day, now + 1)).toMatchObject({
      status: "committed",
    })
    expect(existsSync(filename)).toBe(false)
    expect(
      indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()?.count,
    ).toBe(1)
    expect(await call()).toEqual({ jsonrpc: "2.0", id: 1, result: [] })
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})
