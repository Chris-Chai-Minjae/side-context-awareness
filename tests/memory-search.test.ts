import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { embedLocal } from "../src/memory-search"
import { ContextStore } from "../src/store"

test("Given a local embedding response, when queried, then only loopback is used", async () => {
  const fakeFetch = async (url: string, init: RequestInit) => {
    expect(url).toBe("http://127.0.0.1:11434/api/embed")
    expect(JSON.parse(String(init.body)).input).toBe("synthetic query")
    return Response.json({ embeddings: [[1, 0, 0]] })
  }
  expect(await embedLocal("local-embedding", "synthetic query", fakeFetch)).toEqual([[1, 0, 0]])
})

test("Given a cleared summary, when the vector index is read, then its vector is gone", () => {
  const db = new Database(":memory:")
  const store = new ContextStore(db, Buffer.alloc(32, 7))
  const id = store.upsertSummary({
    kind: "10min",
    windowFrom: 100,
    windowTo: 200,
    title: "A",
    body: "Synthetic",
    sourceIds: [1],
  })
  store.putVector(id, "local-embedding", [1, 0, 0])
  expect(store.vectors("local-embedding")).toHaveLength(1)
  store.clearAll()
  expect(store.vectors("local-embedding")).toHaveLength(0)
  db.close()
})
