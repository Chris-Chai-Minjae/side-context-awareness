import { expect, test } from "bun:test"
import { join } from "node:path"
import { EMBEDDING_DIMENSIONS, EMBEDDING_IDLE_MS } from "../../src/constants"
import { EmbeddingManager } from "../../src/memory/embed"
import { FakeClock } from "../mocks/fake-clock"

test("Given no search or sync, when the manager is created, then the local model remains unloaded", async () => {
  const clock = new FakeClock()
  let loads = 0
  const manager = new EmbeddingManager("/tmp/synthetic-side-data", {
    clock,
    load: async () => {
      loads++
      return { embed: async () => new Float32Array(EMBEDDING_DIMENSIONS), dispose: async () => {} }
    },
  })
  try {
    expect(loads).toBe(0)
    await manager.embed("synthetic text")
    expect(loads).toBe(1)
  } finally {
    await manager.close()
  }
})

test("Given a cached model, when idle for five minutes, then it is disposed and next use reloads it", async () => {
  const clock = new FakeClock()
  const paths: string[] = []
  let loads = 0
  let disposals = 0
  const manager = new EmbeddingManager("/tmp/synthetic-side-data", {
    clock,
    load: async (path) => {
      paths.push(path)
      loads++
      return {
        embed: async () => {
          const vector = new Float32Array(EMBEDDING_DIMENSIONS)
          vector[0] = 1
          return vector
        },
        dispose: async () => {
          disposals++
        },
      }
    },
  })
  try {
    expect((await manager.embed("첫 문장"))[0]).toBe(1)
    expect((await manager.embed("second sentence"))[0]).toBe(1)
    expect(loads).toBe(1)
    expect(paths).toEqual([join("/tmp/synthetic-side-data", "models")])
    clock.advanceBy(EMBEDDING_IDLE_MS - 1)
    expect(disposals).toBe(0)
    clock.advanceBy(1)
    await Bun.sleep(0)
    expect(disposals).toBe(1)
    await manager.embed("another sentence")
    expect(loads).toBe(2)
  } finally {
    await manager.close()
  }
  expect(disposals).toBe(2)
})

test("Given a model with wrong output dimensions, when embedding, then the malformed vector is rejected", async () => {
  const manager = new EmbeddingManager("/tmp/synthetic-side-data", {
    clock: new FakeClock(),
    load: async () => ({ embed: async () => new Float32Array(3), dispose: async () => {} }),
  })
  try {
    await expect(manager.embed("synthetic text")).rejects.toThrow("384")
  } finally {
    await manager.close()
  }
})
