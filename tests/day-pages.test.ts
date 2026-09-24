import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeAllDayPages, renderAllDayPages } from "../src/day-pages"
import { ContextStore } from "../src/store"

test("Given a local summary, when rendered and cleared, then its daily page follows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "context-page-"))
  const db = new Database(":memory:")
  const store = new ContextStore(db, Buffer.alloc(32, 7))
  const from = Date.UTC(2026, 8, 23, 1, 0)
  try {
    store.upsertSummary({
      kind: "10min",
      windowFrom: from,
      windowTo: from + 600_000,
      title: "Research",
      body: "Synthetic result",
      sourceIds: [1],
    })
    await renderAllDayPages(store, directory)
    const pages = join(directory, "memory", "episodic")
    const filename = join(
      pages,
      `context-awareness-${new Date(from).getFullYear()}-${String(new Date(from).getMonth() + 1).padStart(2, "0")}-${String(new Date(from).getDate()).padStart(2, "0")}.md`,
    )
    expect(await readFile(filename, "utf8")).toContain("Sources: e:1")
    store.clearAll()
    await removeAllDayPages(directory)
    expect(Bun.file(filename).exists()).resolves.toBe(false)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
