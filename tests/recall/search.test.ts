import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RECALL_CANDIDATE_LIMIT,
  RECALL_MAX_TERMS,
  RECALL_RECENCY_BONUS,
  RECALL_RECENCY_WINDOW_MS,
  RECALL_TOTAL_MATCH_WEIGHT,
  SNIPPET_CHARS,
} from "../../src/constants"
import { deriveSubkey, keyedHash, seal } from "../../src/crypto/index"
import { clearLedger } from "../../src/ledger/delete"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { selectPassages } from "../../src/recall/passages"
import { HistorySearchEpochChangedError, historySearch } from "../../src/recall/search"
import { recallTerms } from "../../src/recall/terms"

const masterKey = Buffer.alloc(32, 0x42)
const now = new Date("2026-09-24T12:00:00+09:00").getTime()

async function withLedger(
  run: (db: ReturnType<typeof openLedger>) => Promise<void> | void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "side-recall-search-"))
  const db = openLedger(join(directory, "ledger.db"))
  try {
    await run(db)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function event(
  db: ReturnType<typeof openLedger>,
  at: number,
  url: string,
  content = "Synthetic aurora navigation notes",
  appName = "Synthetic Browser",
): string {
  return writeLedgerEvent(db, masterKey, {
    occurredAt: at,
    source: "mac_ax",
    kind: "content.snapshot",
    appName,
    bundleId: "invalid.fixture.browser",
    windowTitle: "Synthetic Aurora",
    url,
    payload: { inlineText: "Synthetic aurora link" },
    content,
  }).id
}

describe("recall terms and passages", () => {
  test("Given Korean and English request words, when tokenized, then content terms are normalized and deduplicated", () => {
    // Given mixed-script queries with request and stop words.
    const queries = ["Find THE Ａｕｒｏｒａ of Seoul", "그 이 저 것 좀 찾아줘 기억 서울 자료"]

    // When terms are recalled.
    const terms = recallTerms(queries)

    // Then only content terms remain.
    expect(terms).toEqual(["aurora", "seoul", "서울", "자료"])
  })

  test("Given many distinct words, when tokenized, then recall terms stop at the approved cap", () => {
    // Given more searchable words than the bound.
    const queries = [
      Array.from({ length: RECALL_MAX_TERMS + 1 }, (_, index) => `term${index}`).join(" "),
    ]

    // When terms are recalled.
    const terms = recallTerms(queries)

    // Then the input order is retained within the bound.
    expect(terms).toHaveLength(RECALL_MAX_TERMS)
    expect(terms[0]).toBe("term0")
    expect(terms.at(-1)).toBe(`term${RECALL_MAX_TERMS - 1}`)
  })

  test("Given matches in distant sentences, when passages are selected, then each bounded window contains a match", () => {
    // Given two distant matching spans.
    const text = `Start. Aurora first. ${"Quiet background. ".repeat(50)} Nebula last.`

    // When passages are selected.
    const passages = selectPassages(text, ["aurora", "nebula"])

    // Then both spans have a readable bounded window.
    expect(passages).toHaveLength(2)
    expect(passages[0]?.toLowerCase()).toContain("aurora")
    expect(passages[1]?.toLowerCase()).toContain("nebula")
    expect(passages.every((passage) => passage.length <= SNIPPET_CHARS)).toBe(true)
  })
})

describe("history search", () => {
  test("Given five captures of one URL, when searched, then the newest event represents that URL", async () => {
    await withLedger(async (db) => {
      // Given five searchable captures at the same normalized URL.
      const ids = Array.from({ length: 5 }, (_, index) =>
        event(
          db,
          now - (5 - index) * 1_000,
          "https://fixture.invalid/aurora?private=discard",
          index === 0 ? "Aurora ".repeat(10) : "Aurora",
        ),
      )

      // When lexical search runs.
      const results = await historySearch({ db, masterKey, now }, { queries: ["find aurora"] })

      // Then the latest capture is the single representative.
      expect(results).toHaveLength(1)
      expect(results[0]?.ref).toBe(`e:${ids.at(-1)}`)
      expect(results[0]?.url).toBe("https://fixture.invalid/aurora")
    })
  })

  test("Given a query that matches an indexed bigram, when searched, then the longer source token is found", async () => {
    await withLedger(async (db) => {
      // Given an indexed source token longer than the query.
      const id = event(db, now, "https://fixture.invalid/bigram", "Synthetic aurorascape document")

      // When a partial lexical query runs.
      const results = await historySearch({ db, masterKey, now }, { queries: ["aurora"] })

      // Then term hashes for bigrams find the event.
      expect(results.map((result) => result.ref)).toEqual([`e:${id}`])
    })
  })

  test("Given app, domain, and time filters, when searched, then only matching evidence remains", async () => {
    await withLedger(async (db) => {
      // Given captures with different app, domain, and age.
      const kept = event(db, now, "https://keep.invalid/aurora", undefined, "Synthetic Browser")
      event(db, now, "https://other.invalid/aurora", undefined, "Synthetic Browser")
      event(
        db,
        now - RECALL_RECENCY_WINDOW_MS,
        "https://keep.invalid/old",
        undefined,
        "Synthetic Browser",
      )
      event(db, now, "https://keep.invalid/editor", undefined, "Synthetic Editor")

      // When every filter is applied.
      const results = await historySearch(
        { db, masterKey, now },
        {
          queries: ["aurora"],
          from: new Date(now - 1_000).toISOString(),
          to: now,
          app: "Synthetic Browser",
          domain: "keep.invalid",
        },
      )

      // Then the capture satisfying all filters is returned.
      expect(results.map((result) => result.ref)).toEqual([`e:${kept}`])
    })
  })

  test("Given matching summary text, when searched, then the summary has an s ref and bounded snippet", async () => {
    await withLedger(async (db) => {
      // Given a completed synthetic summary.
      db.query(`
        INSERT INTO context_awareness_summaries
          (id, kind, window_from, window_to, created_at, updated_at, title, description, body, status)
        VALUES ('summary-aurora', '10min', ?, ?, ?, ?, 'Synthetic Aurora', 'navigation', ?, 'done')
      `).run(now - 1_000, now, now, now, `Aurora ${"long body ".repeat(80)}`)

      // When the summary is searched.
      const results = await historySearch({ db, masterKey, now }, { queries: ["aurora"] })

      // Then a readable summary result is returned.
      expect(results.map((result) => result.ref)).toEqual(["s:summary-aurora"])
      expect(results[0]?.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    })
  })

  test("Given captured and browser URLs, when merged, then captured URLs suppress browser duplicates", async () => {
    await withLedger(async (db) => {
      // Given one captured URL and two browser history rows.
      const id = event(db, now, "https://fixture.invalid/aurora")
      const browserHistory = async () => [
        {
          browser: "chrome",
          id: "same",
          occurredAt: now,
          app: "Chrome",
          title: "Aurora duplicate",
          url: "https://fixture.invalid/aurora?tracking=discard",
          domain: "fixture.invalid",
        },
        {
          browser: "chrome",
          id: "other",
          occurredAt: now,
          app: "Chrome",
          title: "Other page",
          url: "https://other.invalid/aurora",
          domain: "other.invalid",
        },
      ]

      // When both sources are searched.
      const results = await historySearch(
        { db, masterKey, now, browserHistory },
        { queries: ["aurora"] },
      )

      // Then browser-only history remains with a required h ref.
      expect(results.map((result) => result.ref).sort()).toEqual(
        [`e:${id}`, "h:chrome:other"].sort(),
      )
      expect(results.find((result) => result.ref === "h:chrome:other")?.url).toBe(
        "https://other.invalid/aurora",
      )
    })
  })

  test("Given an old and recent match, when scored, then the approved age formula ranks the recent one first", async () => {
    await withLedger(async (db) => {
      // Given the same one-term text at two different ages and URLs.
      const old = event(db, now - RECALL_RECENCY_WINDOW_MS, "https://fixture.invalid/old", "Aurora")
      const recent = event(db, now, "https://fixture.invalid/recent", "Aurora")

      // When the results are scored.
      const results = await historySearch({ db, masterKey, now }, { queries: ["aurora"] })

      // Then the recent match has the larger recency contribution.
      expect(results.map((result) => result.ref)).toEqual([`e:${recent}`, `e:${old}`])
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Number.POSITIVE_INFINITY)
      expect(results[0]?.score).toBeCloseTo(
        1 + 3 * RECALL_TOTAL_MATCH_WEIGHT + RECALL_RECENCY_BONUS,
      )
      expect(results[1]?.score).toBeCloseTo(
        1 + 3 * RECALL_TOTAL_MATCH_WEIGHT + RECALL_RECENCY_BONUS / 2,
      )
    })
  })

  test("Given clear during provider lookup, when searched, then a retry omits deleted captures", async () => {
    await withLedger(async (db) => {
      // Given an event and a provider that clears it after the first candidate pass.
      event(db, now, "https://fixture.invalid/aurora")
      let calls = 0
      const browserHistory = async () => {
        calls++
        if (calls === 1) await clearLedger(db, "last10m", { now })
        return []
      }

      // When lexical search crosses the deletion epoch.
      const results = await historySearch(
        { db, masterKey, now, browserHistory },
        { queries: ["aurora"] },
      )

      // Then the second pass sees the cleared ledger and publishes no stale event.
      expect(calls).toBe(2)
      expect(results).toEqual([])
    })
  })

  test("Given two epoch changes, when searched, then stale results fail closed after one retry", async () => {
    await withLedger(async (db) => {
      // Given a provider that changes the epoch on each pass.
      event(db, now, "https://fixture.invalid/aurora")
      let calls = 0
      const browserHistory = async () => {
        calls++
        db.query(`
          INSERT INTO side_meta (key, value) VALUES ('deletion_epoch', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        `).run()
        return []
      }

      // When search exhausts its retry.
      const operation = historySearch(
        { db, masterKey, now, browserHistory },
        { queries: ["aurora"] },
      )

      // Then it cannot return any result from a stale epoch.
      await expect(operation).rejects.toBeInstanceOf(HistorySearchEpochChangedError)
      expect(calls).toBe(2)
    })
  })

  test("Given more than the candidate cap, when searched, then lower-hit rows are not decrypted", async () => {
    await withLedger(async (db) => {
      // Given high-hit synthetic rows filling the cap and one lower-hit real capture.
      const termsKey = deriveSubkey(masterKey, "terms")
      const evidenceKey = deriveSubkey(masterKey, "evidence")
      const alpha = keyedHash("alpha", termsKey)
      const beta = keyedHash("beta", termsKey)
      db.transaction(() => {
        const insertEvent = db.query(`
          INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload)
          VALUES (?, ?, 'mac_ax', 'content.snapshot', ?)
        `)
        const insertTerm = db.query("INSERT INTO side_terms (term_hash, event_id) VALUES (?, ?)")
        for (let index = 0; index < RECALL_CANDIDATE_LIMIT; index++) {
          const id = `synthetic-${index}`
          insertEvent.run(id, now, seal({}, evidenceKey, `context_awareness_events:payload:${id}`))
          insertTerm.run(alpha, id)
          insertTerm.run(beta, id)
        }
      })()
      const lowerHit = "synthetic-lower-hit"
      db.query(`
        INSERT INTO context_awareness_events
          (id, occurred_at, source, kind, window_title, payload)
        VALUES (?, ?, 'mac_ax', 'content.snapshot', ?, ?)
      `).run(
        lowerHit,
        now,
        seal("Alpha", evidenceKey, `context_awareness_events:window_title:${lowerHit}`),
        seal({}, evidenceKey, `context_awareness_events:payload:${lowerHit}`),
      )
      db.query("INSERT INTO side_terms (term_hash, event_id) VALUES (?, ?)").run(alpha, lowerHit)

      // When the candidate search is bounded by term hits.
      const results = await historySearch({ db, masterKey, now }, { queries: ["alpha beta"] })

      // Then the lower-hit row is excluded before evidence decryption.
      expect(results.find((result) => result.ref === `e:${lowerHit}`)).toBeUndefined()
    })
  })
})
