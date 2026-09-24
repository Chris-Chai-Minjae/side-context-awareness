import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { type Capture, ContextStore } from "../src/store"

const now = Date.UTC(2026, 8, 23)
const key = Buffer.alloc(32, 7)
const page: Capture = {
  capturedAt: now,
  bundleId: "at.studio.AsideBrowser",
  appName: "Aside",
  windowTitle: "Research notes",
  url: "https://example.com/research",
  kind: "ocr",
  text: "A local context memory design",
}

describe("local context store", () => {
  test("Given two observations, when searching, then only matching local evidence is returned", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    store.add(page)
    store.add({ ...page, appName: "Notes", bundleId: "app.notes", text: "Dinner plan" })

    expect(store.search("context").map((result) => result.text)).toEqual([page.text])
    db.close()
  })

  test("Given a repeat on the same day, when captured, then one observation remains", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    store.add(page)
    store.add(page)

    expect(store.recent()).toHaveLength(1)
    db.close()
  })

  test("Given a return to an earlier app, when captured, then the timeline records the return", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    store.add(page)
    store.add({ ...page, bundleId: "app.notes", appName: "Notes", text: "Dinner plan" })
    store.add({ ...page, capturedAt: now + 120_000 })

    expect(store.recent().map((result) => result.appName)).toEqual(["Aside", "Notes", "Aside"])
    db.close()
  })

  test("Given expired and fresh evidence, when pruned, then only fresh evidence remains", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    store.add({ ...page, capturedAt: now - 15 * 86_400_000, text: "expired" })
    store.add(page)

    store.prune(now, 14)

    expect(store.recent().map((result) => result.text)).toEqual([page.text])
    db.close()
  })

  test("Given local evidence, when persisted, then content and URL query are absent from SQLite", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    const id = store.add({
      ...page,
      url: "https://example.com/research?token=secret",
      text: "api_key=synthetic-secret 로컬 문맥 기억",
    })
    const payload =
      db.query<{ payload: string }, []>("SELECT payload FROM events").get()?.payload ?? ""

    expect(payload).not.toContain("synthetic-secret")
    expect(payload).not.toContain("로컬 문맥 기억")
    expect(store.readEvent(id ?? 0)?.url).toBe("https://example.com/research")
    expect(store.readEvent(id ?? 0)?.text).toContain("[redacted:capture]")
    expect(store.search("문맥")).toHaveLength(1)
    db.close()
  })

  test("Given a summary derived from evidence, when recent history is cleared, then the summary also disappears", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    const source = store.add(page)
    const summary = store.upsertSummary({
      kind: "10min",
      windowFrom: now,
      windowTo: now + 600_000,
      title: "Research",
      body: "Synthetic activity",
      sourceIds: [source ?? 0],
    })
    store.clearSince(now)

    expect(store.readEvent(source ?? 0)).toBeNull()
    expect(store.readSummary(summary)).toBeNull()
    db.close()
  })

  test("Given a long page, when searching for a later word, then it remains indexed", () => {
    const db = new Database(":memory:")
    const store = new ContextStore(db, key)
    store.add({ ...page, text: `${"ordinary ".repeat(40)}latekeyword` })
    expect(store.search("latekeyword")).toHaveLength(1)
    db.close()
  })
})
