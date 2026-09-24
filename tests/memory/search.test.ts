import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CA_INDEX_VERSION, EMBEDDING_DIMENSIONS } from "../../src/constants"
import { type IndexedChunk, openIndexDb, putIndexedChunk } from "../../src/memory/index-db"
import { memorySearch } from "../../src/memory/search"

const queryVector = new Float32Array(EMBEDDING_DIMENSIONS)
queryVector[0] = 1
const embedder = { embed: async (_text: string) => queryVector }

async function withIndex(run: (db: Database) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "side-memory-search-"))
  const db = openIndexDb(join(directory, "index.db"))
  try {
    await run(db)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function addChunk(
  db: Database,
  id: string,
  overrides: Partial<Omit<IndexedChunk, "id">> = {},
  embedding: Float32Array = queryVector,
): void {
  const day = overrides.day ?? "2026-09-24"
  putIndexedChunk(
    db,
    {
      id,
      path: `episodic/context-awareness-${day}.md`,
      day,
      windowFrom: 550,
      windowTo: 560,
      heading: "Window",
      text: "Synthetic note",
      summaryId: `summary-${id}`,
      indexVersion: CA_INDEX_VERSION,
      embeddedModel: "synthetic-model",
      ...overrides,
    },
    embedding,
  )
}

function at(day: string, minute: number): number {
  return new Date(`${day}T00:00:00`).getTime() + minute * 60_000
}

test("Given equal cosine matches, when one also matches FTS5, then normalized BM25 adds 20 percent", async () => {
  await withIndex(async (db) => {
    addChunk(db, "lexical", { text: "sqlite extension guide" })
    addChunk(db, "semantic", {
      windowFrom: 660,
      windowTo: 670,
      text: "database extension guide",
    })

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 550) },
      { query: "sqlite" },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["lexical", "semantic"])
    expect(results[0]?.score).toBeCloseTo(1)
    expect(results[1]?.score).toBeCloseTo(0.8)
    expect(results[0]).toEqual(
      expect.objectContaining({
        day: "2026-09-24",
        windowFrom: "09:10",
        windowTo: "09:20",
        heading: "Window",
        snippet: expect.stringContaining("sqlite"),
        summaryId: "summary-lexical",
      }),
    )
  })
})

test("Given a vector match and a lexical-only match, when searched, then the vector receives 80 percent weight", async () => {
  await withIndex(async (db) => {
    const unrelatedVector = new Float32Array(EMBEDDING_DIMENSIONS)
    unrelatedVector[1] = 1
    addChunk(db, "vector", { text: "database guide" })
    addChunk(
      db,
      "lexical",
      { windowFrom: 660, windowTo: 670, text: "sqlite guide" },
      unrelatedVector,
    )

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 550) },
      { query: "sqlite" },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["vector", "lexical"])
    expect(results[0]?.score).toBeCloseTo(0.8)
    expect(results[1]?.score).toBeCloseTo(0.2)
  })
})

test("Given equal-topic chunks one and thirty days old, when searched, then the one-day chunk ranks first", async () => {
  await withIndex(async (db) => {
    addChunk(db, "old", { day: "2026-08-25", text: "sqlite notes" })
    addChunk(db, "recent", { day: "2026-09-23", text: "sqlite notes" })

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 550) },
      { query: "sqlite" },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["recent", "old"])
    expect(results[0]?.score).toBeCloseTo(0.5 + 0.5 / (1 + 1 / 7))
    expect(results[1]?.score).toBeCloseTo(0.5 + 0.5 / (1 + 30 / 7))
  })
})

test("Given a seven-day-old window and overview, when searched, then overview uses the 21-day half-life", async () => {
  await withIndex(async (db) => {
    addChunk(db, "window", {
      day: "2026-09-17",
      windowFrom: 0,
      windowTo: 10,
      heading: "Same",
      text: "sqlite notes",
    })
    addChunk(db, "overview", {
      day: "2026-09-17",
      windowFrom: 0,
      windowTo: 1440,
      heading: "Same",
      text: "sqlite notes",
      summaryId: null,
    })

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 0) },
      { query: "sqlite" },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["overview", "window"])
    expect(results[0]?.score).toBeCloseTo(0.5 + 0.5 / (1 + 7 / 21))
    expect(results[1]?.score).toBeCloseTo(0.5 + 0.5 / (1 + 7 / 7))
  })
})

test("Given adjacent same-day windows and a distant window, when searched, then the adjacent sibling is demoted", async () => {
  await withIndex(async (db) => {
    addChunk(db, "a", { windowFrom: 550, windowTo: 560 })
    addChunk(db, "b", { windowFrom: 560, windowTo: 570 })
    addChunk(db, "c", { windowFrom: 660, windowTo: 670 })

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 0) },
      { query: "semantic" },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["a", "c", "b"])
    expect(results[0]?.score).toBeCloseTo(0.8)
    expect(results[1]?.score).toBeCloseTo(0.8)
    expect(results[2]?.score).toBeCloseTo(0.8 * 0.85)
  })
})

test("Given date bounds and a result limit, when searched, then only the bounded top result is returned", async () => {
  await withIndex(async (db) => {
    addChunk(db, "old", { day: "2026-08-25" })
    addChunk(db, "recent", { day: "2026-09-23" })
    addChunk(db, "today")

    const results = await memorySearch(
      { indexDb: db, embedder, now: at("2026-09-24", 550) },
      { query: "semantic", from: at("2026-09-23", 0), to: at("2026-09-24", 0), limit: 1 },
    )

    expect(results.map(({ chunkId }) => chunkId)).toEqual(["recent"])
  })
})

test("Given a limit above twenty, when searched, then the request is rejected", async () => {
  await withIndex(async (db) => {
    await expect(
      memorySearch({ indexDb: db, embedder }, { query: "sqlite", limit: 21 }),
    ).rejects.toThrow("Memory search limit must be 1 to 20")
  })
})
