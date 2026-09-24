import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enqueueSummaryJobs, markNonGlanceEvent } from "../../src/comprehension/queue"
import { runSummaryPass } from "../../src/comprehension/run"
import { RETRY_DELAYS_MS, TEN_MINUTES_MS } from "../../src/constants"
import { SettingsSchema } from "../../src/contracts/settings"
import { clearLedger } from "../../src/ledger/delete"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

test("Given two closed activity windows, when a fake provider processes a pass, then one day page has two cited sections", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-phase2-day-"))
  const db = openLedger(join(root, "ledger.db"))
  const key = Buffer.alloc(32, 0x42)
  const from = new Date(2026, 8, 24, 9, 0).getTime()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as { messages: { role: string; content: string }[] }
      const user = payload.messages.find(({ role }) => role === "user")?.content ?? ""
      const ref = user.match(/e:[0-9A-HJKMNP-TV-Z]{26}/)?.[0]
      if (!ref) return Response.json({ error: "missing synthetic reference" }, { status: 400 })
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_summary",
                    arguments: JSON.stringify({
                      title: "Read SQLite docs",
                      description: ["Reviewed the extension guide."],
                      memorySummary: "The user checked SQLite extension loading.",
                      apps: ["Synthetic Browser"],
                      domains: ["fixture.invalid"],
                      citations: [{ ref, title: "Guide", url: "https://fixture.invalid/guide" }],
                      sourceIds: [ref],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      })
    },
  })
  try {
    for (const offset of [0, TEN_MINUTES_MS]) {
      const occurredAt = from + offset
      const id = writeLedgerEvent(db, key, {
        occurredAt,
        source: "mac_ax",
        kind: "content.snapshot",
        appName: "Synthetic Browser",
        windowTitle: "SQLite guide",
        url: "https://fixture.invalid/guide",
        content: "SQLite extension loading guide.",
      }).id
      markNonGlanceEvent(db, id, occurredAt)
    }
    const now = from + 2 * TEN_MINUTES_MS
    enqueueSummaryJobs(db, now)
    const settings = SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
      providers: [
        {
          id: "fake",
          baseUrl: `${server.url}v1`,
          models: ["fake"],
          allowEvidence: true,
        },
      ],
    })
    const result = await runSummaryPass({
      db,
      settings,
      dataDir: root,
      now,
      getMasterKey: () => Buffer.from(key),
    })
    expect(result).toEqual({ claimed: 2, completed: 2, failed: 0, digestedDays: 1 })
    const path = join(root, "memory", "episodic", "context-awareness-2026-09-24.md")
    expect(existsSync(path)).toBe(true)
    const page = readFileSync(path, "utf8")
    expect(page.match(/^### /gm)).toHaveLength(2)
    expect(page.match(/^Sources: .*e:/gm)).toHaveLength(2)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE status = 'done' AND digested_at IS NOT NULL",
        )
        .get()?.count,
    ).toBe(2)
  } finally {
    server.stop(true)
    db.close()
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given repeated invalid citations, when one repair per attempt fails three times, then the job settles failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-phase2-repair-"))
  const db = openLedger(join(root, "ledger.db"))
  const key = Buffer.alloc(32, 0x42)
  const from = new Date(2026, 8, 24, 9, 0).getTime()
  const now = from + TEN_MINUTES_MS
  const absent = `e:${"0".repeat(26)}`
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_summary",
                    arguments: JSON.stringify({
                      title: "Invalid citation",
                      description: ["Synthetic summary."],
                      memorySummary: "Synthetic memory.",
                      apps: ["Synthetic Browser"],
                      domains: ["fixture.invalid"],
                      citations: [{ ref: absent }],
                      sourceIds: [absent],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
    },
  })
  try {
    const id = writeLedgerEvent(db, key, {
      occurredAt: from,
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      windowTitle: "Synthetic page",
      url: "https://fixture.invalid/page",
      content: "Synthetic evidence with a valid source.",
    }).id
    markNonGlanceEvent(db, id, from)
    enqueueSummaryJobs(db, now)
    const settings = SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
      providers: [
        { id: "fake", baseUrl: `${server.url}v1`, models: ["fake"], allowEvidence: true },
      ],
    })
    const options = {
      db,
      settings,
      dataDir: root,
      getMasterKey: () => Buffer.from(key),
    }
    expect((await runSummaryPass({ ...options, now })).failed).toBe(1)
    expect((await runSummaryPass({ ...options, now: now + RETRY_DELAYS_MS[0] })).failed).toBe(1)
    expect(
      (
        await runSummaryPass({
          ...options,
          now: now + RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1],
        })
      ).failed,
    ).toBe(1)
    expect(calls).toBe(6)
    expect(
      db
        .query<{ status: string; attempt_count: number; error: string }, []>(
          "SELECT status, attempt_count, error FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .get(),
    ).toEqual({ status: "failed", attempt_count: 3, error: "record_summary contract violated" })
  } finally {
    server.stop(true)
    db.close()
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given a provider response in flight, when clear deletes its source, then the summary and page are discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-phase2-clear-race-"))
  const db = openLedger(join(root, "ledger.db"))
  const key = Buffer.alloc(32, 0x42)
  const from = new Date(2026, 8, 24, 9, 0).getTime()
  const now = from + TEN_MINUTES_MS
  let signalStarted: () => void = () => {}
  let releaseResponse: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const held = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as { messages: { role: string; content: string }[] }
      const ref = payload.messages
        .find(({ role }) => role === "user")
        ?.content.match(/e:[0-9A-HJKMNP-TV-Z]{26}/)?.[0]
      signalStarted()
      await held
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_summary",
                    arguments: JSON.stringify({
                      title: "Stale summary",
                      description: ["This evidence was cleared."],
                      memorySummary: "This must not persist.",
                      apps: ["Synthetic Browser"],
                      domains: ["fixture.invalid"],
                      citations: [{ ref }],
                      sourceIds: [ref],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
    },
  })
  try {
    const id = writeLedgerEvent(db, key, {
      occurredAt: from,
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      windowTitle: "Synthetic page",
      url: "https://fixture.invalid/page",
      content: "Synthetic evidence to clear.",
    }).id
    markNonGlanceEvent(db, id, from)
    enqueueSummaryJobs(db, now)
    const settings = SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
      providers: [
        { id: "fake", baseUrl: `${server.url}v1`, models: ["fake"], allowEvidence: true },
      ],
    })
    const processing = runSummaryPass({
      db,
      settings,
      dataDir: root,
      now,
      getMasterKey: () => Buffer.from(key),
    })
    await started
    await clearLedger(db, "lastHour", { now })
    releaseResponse()
    const result = await processing
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, digestedDays: 1 })
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_summaries")
        .get()?.count,
    ).toBe(0)
    expect(existsSync(join(root, "memory", "episodic", "context-awareness-2026-09-24.md"))).toBe(
      false,
    )
  } finally {
    releaseResponse()
    server.stop(true)
    db.close()
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
})
