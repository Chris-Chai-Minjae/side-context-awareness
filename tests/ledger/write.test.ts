import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TEN_MINUTES_MS, TERM_SOURCE_CHARS } from "../../src/constants"
import { deriveSubkey, keyedHash, open } from "../../src/crypto/index"
import { openLedger } from "../../src/ledger/schema"
import type { LedgerEventInput } from "../../src/ledger/write"
import { writeLedgerEvent } from "../../src/ledger/write"

const masterKey = Buffer.alloc(32, 0x42)
const firstTime = new Date("2026-09-24T10:00:00+09:00").getTime()
const secondTime = firstTime + 60_000
const title = "Synthetic Aurora Title"
const url = "https://fixture.invalid/synthetic-aurora-path?private=discard-me#fragment"
const body = "Synthetic shared body with searchable nebula"

function withLedger(run: (db: ReturnType<typeof openLedger>, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-ledger-write-"))
  const path = join(directory, "ledger.db")
  const db = openLedger(path)
  try {
    run(db, path)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function event(occurredAt: number, overrides: Partial<LedgerEventInput> = {}): LedgerEventInput {
  return {
    occurredAt,
    source: "mac_ax",
    kind: "content.snapshot",
    appName: "Synthetic Browser",
    bundleId: "invalid.fixture.browser",
    windowTitle: title,
    url,
    target: { role: "link", label: "Synthetic target" },
    payload: { trigger: "interaction", shape: "ax", inlineText: "Synthetic inline starlight" },
    content: body,
    ...overrides,
  }
}

describe("ledger write", () => {
  test("Given two identical bodies, when written, then both events share one blob and update last_seen_at", () => {
    withLedger((db) => {
      const first = writeLedgerEvent(db, masterKey, event(firstTime))
      const second = writeLedgerEvent(db, masterKey, event(secondTime))
      expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(second.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(first.id).not.toBe(second.id)
      expect(first.blobId).toBe(second.blobId)
      expect(
        db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM context_awareness_blobs")
          .get()?.count,
      ).toBe(1)
      expect(
        db
          .query<{ count: number }, []>("SELECT count(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(2)
      expect(
        db
          .query<{ last_seen_at: number }, []>("SELECT last_seen_at FROM context_awareness_blobs")
          .get()?.last_seen_at,
      ).toBe(secondTime)

      const counter = db
        .query<{ events: number; blobs: number; raw_bytes: number }, []>(
          "SELECT events, blobs, raw_bytes FROM side_day_counters",
        )
        .get()
      expect(counter).toEqual({ events: 2, blobs: 1, raw_bytes: Buffer.byteLength(body) })
    })
  })

  test("Given text fields, when written, then each sealed column has its own AAD and URL query is discarded", () => {
    withLedger((db) => {
      const written = writeLedgerEvent(db, masterKey, event(firstTime))
      const row = db
        .query<
          {
            window_title: string
            url: string
            domain: string
            target: string
            payload: string
            content: Uint8Array
          },
          [string]
        >(`
        SELECT e.window_title, e.url, e.domain, e.target, e.payload, b.content
        FROM context_awareness_events e JOIN context_awareness_blobs b ON b.id = e.blob_id
        WHERE e.id = ?
      `)
        .get(written.id)
      if (!row || !written.blobId) throw new Error("Synthetic write row missing")

      const evidenceKey = deriveSubkey(masterKey, "evidence")
      expect(
        open<string>(
          row.window_title,
          evidenceKey,
          `context_awareness_events:window_title:${written.id}`,
        ),
      ).toBe(title)
      expect(open<string>(row.url, evidenceKey, `context_awareness_events:url:${written.id}`)).toBe(
        "https://fixture.invalid/synthetic-aurora-path",
      )
      expect(row.domain).toBe("fixture.invalid")
      expect(
        open<{ role: string; label: string }>(
          row.target,
          evidenceKey,
          `context_awareness_events:target:${written.id}`,
        ),
      ).toEqual({ role: "link", label: "Synthetic target" })
      expect(
        open<{ trigger: string; shape: string; inlineText: string; masks: readonly unknown[] }>(
          row.payload,
          evidenceKey,
          `context_awareness_events:payload:${written.id}`,
        ),
      ).toEqual({
        trigger: "interaction",
        shape: "ax",
        inlineText: "Synthetic inline starlight",
        masks: [],
      })
      expect(
        open<string>(
          Buffer.from(row.content).toString("base64url"),
          evidenceKey,
          `context_awareness_blobs:content:${written.blobId}`,
        ),
      ).toBe(body)
      expect(() =>
        open(row.window_title, evidenceKey, `context_awareness_events:url:${written.id}`),
      ).toThrow()
    })
  })

  test("Given title, inline text, and body, when written, then terms are keyed hashes of all sources", () => {
    withLedger((db) => {
      const written = writeLedgerEvent(
        db,
        masterKey,
        event(firstTime, { content: `${body} ${"x".repeat(TERM_SOURCE_CHARS)} afterlimitword` }),
      )
      const termsKey = deriveSubkey(masterKey, "terms")
      const terms = db
        .query<{ term_hash: string }, [string]>(
          "SELECT term_hash FROM side_terms WHERE event_id = ?",
        )
        .all(written.id)
        .map((row) => row.term_hash)
      for (const term of ["aurora", "starlight", "nebula"]) {
        expect(terms).toContain(keyedHash(term, termsKey))
      }
      expect(terms).not.toContain("aurora")
      expect(terms).not.toContain(keyedHash("afterlimitword", termsKey))
    })
  })

  test("Given synthetic secrets in captured fields, when written, then redaction precedes sealing and counts masks", () => {
    withLedger((db) => {
      const written = writeLedgerEvent(
        db,
        masterKey,
        event(firstTime, {
          windowTitle: "AKIAABCDEFGHIJKLMNOP",
          target: { label: "password: hunter2" },
          payload: { inlineText: "4111111111111111" },
          content: "eyJabcdefgh.abcdefgh.abcdefgh",
        }),
      )
      const row = db
        .query<
          { window_title: string; target: string; payload: string; content: Uint8Array },
          [string]
        >(`
          SELECT e.window_title, e.target, e.payload, b.content
          FROM context_awareness_events e JOIN context_awareness_blobs b ON b.id = e.blob_id
          WHERE e.id = ?
        `)
        .get(written.id)
      if (!row || !written.blobId) throw new Error("Synthetic write row missing")
      const key = deriveSubkey(masterKey, "evidence")
      expect(
        open<string>(row.window_title, key, `context_awareness_events:window_title:${written.id}`),
      ).toBe("[redacted:capture]")
      expect(
        open<{ label: string }>(row.target, key, `context_awareness_events:target:${written.id}`),
      ).toEqual({ label: "[redacted:capture]" })
      const payload = open<{
        inlineText: string
        masks: readonly { rule: string; count: number }[]
      }>(row.payload, key, `context_awareness_events:payload:${written.id}`)
      expect(payload.inlineText).toBe("[redacted:capture]")
      expect(payload.masks).toHaveLength(4)
      expect(
        open<string>(
          Buffer.from(row.content).toString("base64url"),
          key,
          `context_awareness_blobs:content:${written.blobId}`,
        ),
      ).toBe("[redacted:capture]")
      expect(
        db
          .query<{ masks: number; suppressions: number }, []>(
            "SELECT masks, suppressions FROM side_day_counters",
          )
          .get(),
      ).toEqual({ masks: 4, suppressions: 4 })
    })
  })

  test("Given synthetic canaries, when written, then ledger database bytes contain no title, URL, or canary plaintext", () => {
    withLedger((db, path) => {
      const canaries = [
        "AKIAABCDEFGHIJKLMNOP",
        "eyJabcdefgh.abcdefgh.abcdefgh",
        "4111111111111111",
        "password: hunter2",
        "900101-1234567",
      ] as const
      writeLedgerEvent(
        db,
        masterKey,
        event(firstTime, {
          windowTitle: `${title} ${canaries[0]}`,
          target: { label: canaries[1] },
          payload: { inlineText: `${canaries[2]} ${canaries[3]}` },
          content: `${body} ${canaries[4]}`,
        }),
      )
      const bytes = [path, `${path}-wal`, `${path}-shm`]
        .filter((candidate) => existsSync(candidate))
        .map((candidate) => readFileSync(candidate).toString("utf8"))
        .join("")
      for (const sentinel of [title, "synthetic-aurora-path", ...canaries]) {
        expect(bytes).not.toContain(sentinel)
      }
    })
  })

  test("Given a term insert failure, when written, then blob, event, and counter changes roll back together", () => {
    withLedger((db) => {
      db.exec(`CREATE TRIGGER fail_synthetic_term BEFORE INSERT ON side_terms
        BEGIN SELECT RAISE(FAIL, 'synthetic term failure'); END`)
      expect(() => writeLedgerEvent(db, masterKey, event(firstTime))).toThrow(
        "synthetic term failure",
      )
      for (const table of [
        "context_awareness_blobs",
        "context_awareness_events",
        "side_day_counters",
      ]) {
        const count = db
          .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
          .get()?.count
        expect(count).toBe(0)
      }
    })
  })

  test("Given committed events in two local windows, when written, then durable summary generations advance in the same windows", () => {
    withLedger((db) => {
      // Given two events in the first window and one in the next.
      writeLedgerEvent(db, masterKey, event(firstTime))
      writeLedgerEvent(db, masterKey, event(secondTime))
      writeLedgerEvent(db, masterKey, event(firstTime + TEN_MINUTES_MS))

      // When the summary queue reads its persistent generations.
      const generations = db
        .query<{ key: string; value: string }, []>(`
          SELECT key, value FROM side_meta
          WHERE key LIKE 'summary_generation_10min:%' ORDER BY key
        `)
        .all()

      // Then it sees both windows and the first reflects both commits.
      expect(generations).toEqual([
        { key: `summary_generation_10min:${firstTime}`, value: "2" },
        { key: `summary_generation_10min:${firstTime + TEN_MINUTES_MS}`, value: "1" },
      ])
    })
  })

  test("Given summary generation persistence fails, when an event is written, then the whole ledger write rolls back", () => {
    withLedger((db) => {
      // Given an injected failure at the durable generation insert.
      db.exec(`CREATE TRIGGER fail_synthetic_generation BEFORE INSERT ON side_meta
        WHEN NEW.key LIKE 'summary_generation_10min:%'
        BEGIN SELECT RAISE(FAIL, 'synthetic generation failure'); END`)

      // When the writer tries to commit an event.
      expect(() => writeLedgerEvent(db, masterKey, event(firstTime))).toThrow(
        "synthetic generation failure",
      )

      // Then no event, blob, or counter survives the failed transaction.
      for (const table of [
        "context_awareness_events",
        "context_awareness_blobs",
        "side_day_counters",
      ]) {
        expect(
          db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
        ).toBe(0)
      }
    })
  })
})
