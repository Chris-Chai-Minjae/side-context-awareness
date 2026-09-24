import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { saveSettings } from "../../src/config/index"
import { SettingsSchema } from "../../src/contracts/settings"
import { deriveSubkey, open } from "../../src/crypto/index"
import { runDaemon } from "../../src/daemon/index"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { openIndexDb } from "../../src/memory/index-db"
import { renderContextAwarenessDayPage } from "../../src/memory/render"
import { syncMemoryIndex } from "../../src/memory/sync"
import { health, hello } from "../helper/fixture"

const oldKey = Buffer.alloc(32, 7)
const newKey = Buffer.alloc(32, 9)

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Synthetic daemon did not reach the expected state")
}

async function runScenario(rotation: "valid" | "invalid") {
  const directory = mkdtempSync(join(tmpdir(), "side-clear-rotation-"))
  const ledgerPath = join(directory, "context-awareness", "ledger.db")
  mkdirSync(join(directory, "context-awareness"))
  const day = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(Date.now() - 86_400_000)
  const at = Date.now() - 86_400_000
  const db = openLedger(ledgerPath)
  const previous = writeLedgerEvent(db, oldKey, {
    occurredAt: at,
    source: "mac_ax",
    kind: "content.snapshot",
    appName: "Synthetic Editor",
    bundleId: "com.example.Editor",
    windowTitle: "Synthetic old title",
    content: "Synthetic old evidence",
  })
  const oldCiphertext = db
    .query<{ window_title: string }, [string]>(
      "SELECT window_title FROM context_awareness_events WHERE id = ?",
    )
    .get(previous.id)?.window_title
  if (!oldCiphertext) throw new TypeError("Synthetic encrypted event is missing")
  db.query(`INSERT INTO context_awareness_summaries
    (id, kind, window_from, window_to, created_at, updated_at, title, description, body, status)
    VALUES ('old-summary', '10min', ?, ?, ?, ?, 'Synthetic', '[]', 'Synthetic old summary', 'done')`).run(
    at,
    at + 600_000,
    at,
    at,
  )
  await renderContextAwarenessDayPage(db, directory, day, Date.now())
  const page = join(directory, "memory", "episodic", `context-awareness-${day}.md`)
  const index = openIndexDb(join(directory, "index.db"))
  const embedder = { embed: async () => new Float32Array(384), close: async () => {} }
  await syncMemoryIndex({ ledgerDb: db, indexDb: index, dataDir: directory, embedder })
  expect(
    index.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()?.count,
  ).toBeGreaterThan(0)
  index.close()
  db.close()
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = createInterface({ input: output })
  const commands: string[] = []
  lines.on("line", (line) => {
    const command = JSON.parse(line)
    if (command.type !== "command") return
    commands.push(`${command.name}${command.args?.paused === true ? ":paused" : ""}`)
    const data =
      command.name === "keychain.rotate"
        ? rotation === "valid"
          ? { key: newKey.toString("base64") }
          : { key: "invalid" }
        : null
    input.write(`${JSON.stringify({ type: "result", id: command.id, ok: true, data })}\n`)
  })
  let running: Promise<void> | null = null
  try {
    await saveSettings(
      directory,
      SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
    )
    running = runDaemon({ directory, input, output, embeddingManager: embedder })
    input.write(`${JSON.stringify(hello)}\n`)
    input.write(`${JSON.stringify({ type: "health", health })}\n`)
    await waitFor(() => commands.includes("observer.configure"))
    const rpc = async (target: "all" | "today") => {
      const response = await fetch("http://localhost/rpc", {
        unix: join(directory, "run", "daemon.sock"),
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "clear", params: { target } }),
      })
      return response.json()
    }
    const result = await rpc("all")
    const after = openLedger(ledgerPath)
    const eventCount = () =>
      after
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
        .get()?.count
    const summaryCount = () =>
      after
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_summaries")
        .get()?.count
    const epoch = after
      .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
      .get()?.value
    const newIndex = openIndexDb(join(directory, "index.db"))
    const chunkCount = newIndex
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks")
      .get()?.count
    newIndex.close()
    const postClearEvent = {
      type: "event",
      event: {
        occurredAt: Date.now(),
        source: "mac_ax",
        kind: "window.changed",
        appName: "Synthetic Editor",
        bundleId: "com.example.Editor",
        windowTitle: "Synthetic new title",
      },
    }
    input.write(`${JSON.stringify(postClearEvent)}\n`)
    if (rotation === "valid") await waitFor(() => eventCount() === 1)
    else await Bun.sleep(30)
    const row = after
      .query<{ id: string; window_title: string }, []>(
        "SELECT id, window_title FROM context_awareness_events",
      )
      .get()
    const copied = {
      result,
      commands,
      previousId: previous.id,
      eventCount: eventCount(),
      summaryCount: summaryCount(),
      epoch,
      pageExists: existsSync(page),
      chunkCount,
      row,
      newTitle:
        rotation === "valid" && row && row.id !== previous.id
          ? open<string>(
              row.window_title,
              deriveSubkey(newKey, "evidence"),
              `context_awareness_events:window_title:${row.id}`,
            )
          : null,
    }
    after.close()
    return { ...copied, oldCiphertext }
  } finally {
    input.end()
    await running?.catch(() => {})
    lines.close()
    output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
}

test("Given old encrypted history, when daemon Clear all rotates through a fake helper, then old evidence and index disappear and new events use the new key", async () => {
  const result = await runScenario("valid")
  expect(result.result.result).toMatchObject({
    deleted_events: 1,
    deleted_summaries: 1,
    deletion_epoch: 1,
  })
  expect(result.commands).toContain("keychain.rotate")
  expect(result.commands.indexOf("observer.configure:paused")).toBeLessThan(
    result.commands.indexOf("keychain.rotate"),
  )
  expect(result.eventCount).toBe(1)
  expect(result.summaryCount).toBe(0)
  expect(result.pageExists).toBe(false)
  expect(result.chunkCount).toBe(0)
  expect(result.newTitle).toBe("Synthetic new title")
  expect(() =>
    open(
      result.row?.window_title ?? "",
      deriveSubkey(oldKey, "evidence"),
      `context_awareness_events:window_title:${result.row?.id}`,
    ),
  ).toThrow()
  expect(() =>
    open(
      result.oldCiphertext,
      deriveSubkey(newKey, "evidence"),
      `context_awareness_events:window_title:${result.previousId}`,
    ),
  ).toThrow()
})

test("Given an invalid rotation result, when daemon Clear all commits, then capture stays stopped", async () => {
  const result = await runScenario("invalid")
  expect(result.result.error?.code).toBe(-32603)
  expect(result.eventCount).toBe(0)
  expect(result.summaryCount).toBe(0)
  expect(result.epoch).toBe("1")
  expect(result.pageExists).toBe(false)
  expect(result.chunkCount).toBe(0)
  expect(result.commands.at(-1)).toBe("keychain.rotate")
})
