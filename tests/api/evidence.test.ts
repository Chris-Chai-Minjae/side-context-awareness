import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEvidenceHandlers } from "../../src/api/resources/evidence"
import { handleRpcBody } from "../../src/api/rpc"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

function rpc(method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
}

test("P4-R6-T1: read wraps a captured event in an untrusted boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-evidence-"))
  const db = openLedger(join(directory, "ledger.db"))
  const key = Buffer.alloc(32, 0x41)
  try {
    const occurredAt = new Date(2026, 8, 24, 9, 0).getTime()
    const id = writeLedgerEvent(db, key, {
      occurredAt,
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      windowTitle: "SQLite guide",
      url: "https://fixture.invalid/sqlite",
      content: "Synthetic SQLite extension notes",
    }).id
    const handlers = createEvidenceHandlers({ db, getMasterKey: () => Buffer.from(key) })
    const response = await handleRpcBody(rpc("read", { id: `e:${id}` }), handlers)
    expect(response).toMatchObject({
      result: {
        id: `e:${id}`,
        occurred_at: occurredAt,
        app: "Synthetic Browser",
        title: "SQLite guide",
        url: "https://fixture.invalid/sqlite",
        expired: false,
      },
    })
    const text = (response as { result: { text: string } }).result.text
    expect(text).toContain("Synthetic SQLite extension notes")
    expect(text).toContain("untrusted-evidence")
  } finally {
    db.close()
    key.fill(0)
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R6-T1: search and events share the ledger but events never return captured body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-events-"))
  const db = openLedger(join(directory, "ledger.db"))
  const key = Buffer.alloc(32, 0x42)
  try {
    const occurredAt = new Date(2026, 8, 24, 9, 0).getTime()
    const id = writeLedgerEvent(db, key, {
      occurredAt,
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      bundleId: "fixture.invalid.browser",
      windowTitle: "SQLite extension notes",
      url: "https://fixture.invalid/sqlite",
      content: "Synthetic SQLite private body",
    }).id
    const handlers = createEvidenceHandlers({ db, getMasterKey: () => Buffer.from(key) })
    const search = await handleRpcBody(rpc("search", { queries: ["SQLite"] }), handlers)
    expect(search).toMatchObject({ result: [{ ref: `e:${id}`, title: "SQLite extension notes" }] })
    const events = await handleRpcBody(
      rpc("events", { from: occurredAt, to: occurredAt, limit: 10, offset: 0 }),
      handlers,
    )
    expect(events).toMatchObject({
      result: [
        {
          id,
          occurred_at: occurredAt,
          app_name: "Synthetic Browser",
          window_title: "SQLite extension notes",
          url: "https://fixture.invalid/sqlite",
        },
      ],
    })
    expect(JSON.stringify(events)).not.toContain("Synthetic SQLite private body")
  } finally {
    db.close()
    key.fill(0)
    rmSync(directory, { recursive: true, force: true })
  }
})
