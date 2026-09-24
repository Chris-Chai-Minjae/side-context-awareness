import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { saveSettings } from "../../src/config/index"
import { BROWSER_URL_POLL_MS, CAPTURE_DEBOUNCE_MS } from "../../src/constants"
import { type AppToDaemonMessage, DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { SettingsSchema } from "../../src/contracts/settings"
import { deriveSubkey, open } from "../../src/crypto/index"
import { runDaemon } from "../../src/daemon/index"
import { readBlobContent } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { type Command, health, hello } from "../helper/fixture"
import { FakeClock } from "../mocks/fake-clock"

type EventRow = {
  readonly id: string
  readonly kind: string
  readonly app_name: string
  readonly bundle_id: string
  readonly window_title: string
  readonly url: string | null
  readonly domain: string | null
  readonly target: string
  readonly payload: string
  readonly blob_id: string | null
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Synthetic helper did not reach the expected state")
}

test("Given synthetic browser, editor, password and denylist scenarios, when the fake helper drives runDaemon, then only safe expected events persist", async () => {
  // Given: isolated storage and a producer that emits no denied-app events.
  const directory = mkdtempSync(join(tmpdir(), "side-phase1-integration-"))
  const ledgerPath = join(directory, "context-awareness", "ledger.db")
  const clock = new FakeClock(Date.now())
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: Command[] = []
  const lines = createInterface({ input: output })
  const key = Buffer.alloc(32, 7)
  const tokenCanary = `sk_live_${"A".repeat(24)}`
  const titleCanary = "password: hunter2"
  const queryCanary = "synthetic-query-canary"
  const passwordCanary = "synthetic-password-field-canary"
  const deniedBundleId = "invalid.fixture.denied"
  const deniedDomain = "deny.example"
  let running: Promise<void> | null = null
  const send = (message: AppToDaemonMessage): void => {
    input.write(`${JSON.stringify(message)}\n`)
  }
  try {
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: {
          enabled: true,
          rules: [
            { scope: "app", behavior: "do_not_observe", bundleId: deniedBundleId },
            { scope: "url", behavior: "do_not_observe", urlDomain: deniedDomain },
          ],
        },
      }),
    )
    lines.on("line", (line) => {
      const message = DaemonToAppMessageSchema.parse(JSON.parse(line))
      if (message.type !== "command") return
      commands.push(message)
      if (message.name === "capture.request") return
      send({
        type: "result",
        id: message.id,
        ok: true,
        data: message.name === "browser.url" ? `https://${deniedDomain}/private` : null,
      })
    })
    running = runDaemon({ directory, input, output, clock })
    send(hello)
    send({ type: "health", health })
    await waitFor(() =>
      commands.some(
        (command) => command.name === "observer.configure" && command.args.paused === false,
      ),
    )

    // When: browser, editor and secure input JSON-lines drive capture and URL polling.
    const browser = {
      occurredAt: clock.now(),
      source: "mac_ax",
      bundleId: "com.google.Chrome",
      appName: "Synthetic Browser",
      windowId: 10,
      url: `https://public.example/article?token=${queryCanary}`,
    }
    send({ type: "event", event: { ...browser, kind: "window.changed", windowTitle: titleCanary } })
    const db = openLedger(ledgerPath)
    try {
      const eventCount = db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM context_awareness_events",
      )
      await waitFor(() => eventCount.get()?.count === 1)
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() => commands.some((command) => command.name === "capture.request"))
      const capture = commands.find((command) => command.name === "capture.request")
      if (!capture) throw new Error("Synthetic browser capture was not requested")
      send({
        type: "result",
        id: capture.id,
        ok: true,
        data: {
          ...browser,
          occurredAt: clock.now(),
          kind: "content.snapshot",
          content: `Reference ${tokenCanary}`,
        },
      })
      await waitFor(() => eventCount.get()?.count === 2)
      clock.advanceBy(BROWSER_URL_POLL_MS)
      await waitFor(
        () =>
          db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
            ?.count === 1,
      )
    } finally {
      db.close()
    }
    send({
      type: "event",
      event: {
        occurredAt: clock.now() + 1,
        source: "mac_ax",
        kind: "keyboard.text_input",
        bundleId: "invalid.fixture.editor",
        role: "AXTextArea",
        label: "Draft",
        text: `Draft ${tokenCanary}`,
      },
    })
    send({ type: "health", health: { ...health, secureInput: true } })
    send({
      type: "event",
      event: {
        occurredAt: clock.now() + 2,
        source: "mac_ax",
        kind: "keyboard.text_input",
        bundleId: "invalid.fixture.editor",
        role: "AXSecureTextField",
        label: "Password",
        text: passwordCanary,
      },
    })
    send({ type: "health", health })
    input.end()
    await running

    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "observer.configure",
        args: expect.objectContaining({
          deniedBundleIds: expect.arrayContaining([deniedBundleId]),
        }),
      }),
    )
    expect(commands.filter((command) => command.name === "capture.request")).toHaveLength(1)
    const browserPolls = commands.filter((command) => command.name === "browser.url")
    expect(browserPolls).toHaveLength(1)
    expect(browserPolls[0]?.args).toEqual({ bundleId: "com.google.Chrome" })
    const persisted = openLedger(ledgerPath)
    try {
      const rows = persisted
        .query<EventRow, []>(`
        SELECT id, kind, app_name, bundle_id, window_title, url, domain, target, payload, blob_id
        FROM context_awareness_events ORDER BY occurred_at, id
      `)
        .all()
      expect(rows.map((row) => row.kind)).toEqual([
        "window.changed",
        "content.snapshot",
        "keyboard.text_input",
      ])
      expect(rows).toHaveLength(3)
      expect(rows.filter((row) => row.bundle_id === deniedBundleId)).toHaveLength(0)
      expect(rows.filter((row) => row.domain === deniedDomain)).toHaveLength(0)
      const urlSuppression = persisted
        .query<{ count: number }, []>(
          "SELECT COALESCE(SUM(count), 0) AS count FROM side_suppressions WHERE scope = 'url'",
        )
        .get()
      expect(urlSuppression?.count).toBe(1)
      const evidenceKey = deriveSubkey(key, "evidence")
      const decrypted = rows.map((row) => ({
        appName: row.app_name,
        bundleId: row.bundle_id,
        title:
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
        target:
          row.target === "{}"
            ? {}
            : open<unknown>(row.target, evidenceKey, `context_awareness_events:target:${row.id}`),
        payload: open<unknown>(
          row.payload,
          evidenceKey,
          `context_awareness_events:payload:${row.id}`,
        ),
        content: row.blob_id === null ? null : readBlobContent(persisted, key, row.blob_id),
      }))
      expect(decrypted[0]?.url).toBe("https://public.example/article")
      expect(decrypted[1]?.content).toContain("[redacted:capture]")
      expect(decrypted[2]?.content).toContain("[redacted:capture]")
      for (const canary of [tokenCanary, titleCanary, queryCanary, passwordCanary]) {
        expect(JSON.stringify(decrypted)).not.toContain(canary)
      }
    } finally {
      persisted.close()
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${ledgerPath}${suffix}`
      if (!existsSync(path)) continue
      const bytes = readFileSync(path)
      for (const canary of [tokenCanary, titleCanary, queryCanary, passwordCanary]) {
        expect(bytes.includes(Buffer.from(canary))).toBe(false)
      }
    }
  } finally {
    input.end()
    if (running !== null) await running.catch(() => {})
    lines.close()
    input.destroy()
    output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})
