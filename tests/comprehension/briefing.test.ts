import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleBriefing } from "../../src/comprehension/briefing"
import { markNonGlanceEvent } from "../../src/comprehension/queue"
import {
  BRIEFING_CONTENT_BUDGET_BYTES,
  FRAME_COLD_AGE_MS,
  PAGE_INDEX_LINES_PER_SEGMENT,
  REVISIT_BYTES,
  SELECTION_BYTES,
  TYPED_RUN_BYTES,
} from "../../src/constants"
import { sealColdBlobs } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { type LedgerEventInput, writeLedgerEvent } from "../../src/ledger/write"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/briefing/scenario.json", import.meta.url), "utf8"),
) as { title: string; url: string; body: string; otherBody: string }
const key = Buffer.alloc(32, 0x42)
const from = new Date("2026-09-24T09:00:00+09:00").getTime()
const to = from + 600_000

function withLedger(run: (db: Database) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-briefing-"))
  const db = openLedger(join(directory, "ledger.db"))
  try {
    run(db)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function write(db: Database, offset: number, overrides: Partial<LedgerEventInput> = {}): string {
  const event: LedgerEventInput = {
    occurredAt: from + offset,
    source: "mac_ax",
    kind: "content.snapshot",
    appName: "Synthetic Browser",
    windowTitle: fixture.title,
    url: fixture.url,
    content: fixture.body,
    ...overrides,
  }
  return writeLedgerEvent(db, key, event).id
}

function lineValue(text: string, prefix: string): string {
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix))
  if (!line) throw new Error(`Missing synthetic ${prefix} line`)
  return line.slice(line.indexOf(": ") + 2)
}

function timeLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

test("Given dwell and a short visit, when assembled, then the visit is one glance line with cited refs", () => {
  withLedger((db) => {
    // Given a dwell, a three-second glance, and another dwell.
    const first = write(db, 0)
    write(db, 6_000, { kind: "window.changed", content: null })
    const glance = write(db, 12_000, {
      appName: "Synthetic Mail",
      windowTitle: "Inbox",
      url: null,
      content: fixture.otherBody,
    })
    const last = write(db, 15_000, {
      appName: "Synthetic Editor",
      windowTitle: "Draft",
      url: null,
      content: fixture.otherBody,
    })
    write(db, 23_000, {
      kind: "keyboard.text_input",
      appName: "Synthetic Editor",
      windowTitle: "Draft",
      url: null,
      content: "Synthetic sentence.",
    })

    // When decrypted ledger evidence is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the short visit is compressed, while both dwell segments retain citations.
    expect(briefing.text).toContain("Also glanced at:")
    expect(briefing.text).toContain(`e:${glance}`)
    expect(briefing.text).toContain(`e:${first}`)
    expect(briefing.text).toContain(`e:${last}`)
    expect(briefing.text).not.toContain(`Snapshot e:${glance}`)
    expect(briefing.apps).toEqual(
      new Set(["Synthetic Browser", "Synthetic Mail", "Synthetic Editor"]),
    )
    expect(briefing.domains).toEqual(new Set(["fixture.invalid"]))
    expect(briefing.evidenceIds).toEqual(
      new Set([...briefing.text.matchAll(/e:[0-9A-HJKMNP-TV-Z]{26}/g)].map(([ref]) => ref)),
    )
  })
})

test("Given duplicate snapshots and many headings, when assembled, then Jaccard deduplicates and caps the index", () => {
  withLedger((db) => {
    // Given three captures of the same page, with first and last nearly identical.
    const headingBody = [
      "# Orchard Plan",
      ...Array.from({ length: 15 }, (_, index) => `## Synthetic heading ${index}`),
      "Synthetic unique ending.",
    ].join("\n")
    const first = write(db, 0, { content: headingBody })
    const middle = write(db, 6_000, { content: "Unselected middle capture" })
    const last = write(db, 12_000, { content: `${headingBody}\nSynthetic tail.` })

    // When briefing chooses the first and last captures.
    const briefing = assembleBriefing(db, key, from, to)

    // Then similarity removes the last one and the middle never appears.
    expect(briefing.text.match(/^Snapshot e:/gm)).toHaveLength(1)
    expect(briefing.text).toContain(`Snapshot e:${first}`)
    expect(briefing.text).not.toContain(`Snapshot e:${middle}`)
    expect(briefing.text).not.toContain(`Snapshot e:${last}`)
    expect(briefing.text.match(/^Index e:/gm)).toHaveLength(PAGE_INDEX_LINES_PER_SEGMENT)
  })
})

test("Given long multibyte typed and selected text, when assembled, then each byte cap is enforced", () => {
  withLedger((db) => {
    // Given one dwell with long UTF-8 evidence in two typed events and one selection.
    write(db, 0)
    const typed = "🌱".repeat(1_500)
    write(db, 6_000, { kind: "keyboard.text_input", content: typed })
    write(db, 7_000, { kind: "keyboard.text_input", content: " synthetic tail sentence." })
    write(db, 8_000, { kind: "selection.changed", content: "🍎".repeat(200) })

    // When the text evidence is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the combined typed run and the selection obey byte limits.
    expect(Buffer.byteLength(lineValue(briefing.text, "Typed e:"), "utf8")).toBeLessThanOrEqual(
      TYPED_RUN_BYTES,
    )
    expect(Buffer.byteLength(lineValue(briefing.text, "Selection e:"), "utf8")).toBeLessThanOrEqual(
      SELECTION_BYTES,
    )
    expect(briefing.text).not.toContain("�")
  })
})

test("Given a prior same-URL visit, when assembled, then only its cited summary excerpt is included", () => {
  withLedger((db) => {
    // Given one prior visit with a completed summary and an unrelated summary.
    const prior = write(db, -3_600_000)
    const unrelated = write(db, -1_800_000, {
      url: "https://fixture.invalid/unrelated",
      content: "Unrelated synthetic visit",
    })
    db.query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, status, body, source_ids)
      VALUES (?, '10min', ?, ?, ?, ?, 'done', ?, ?)
    `).run(
      "synthetic-prior-summary",
      from - 3_600_000,
      from - 3_000_000,
      from - 3_000_000,
      from - 3_000_000,
      `Prior orchard result ${"🌿".repeat(2_000)}`,
      JSON.stringify([`e:${prior}`]),
    )
    db.query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, status, body, source_ids)
      VALUES (?, '10min', ?, ?, ?, ?, 'done', ?, ?)
    `).run(
      "synthetic-unrelated-summary",
      from - 1_800_000,
      from - 1_200_000,
      from - 1_200_000,
      from - 1_200_000,
      "UNRELATED_SYNTHETIC_SUMMARY",
      JSON.stringify([`e:${unrelated}`]),
    )
    write(db, 0)
    write(db, 6_000, { kind: "window.changed", content: null })

    // When the current window is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then it marks the revisit and caps the prior excerpt in UTF-8 bytes.
    expect(briefing.text).toContain("Revisit e:")
    expect(lineValue(briefing.text, "Revisit e:")).toContain("Prior orchard result")
    expect(briefing.text).not.toContain("UNRELATED_SYNTHETIC_SUMMARY")
    expect(Buffer.byteLength(lineValue(briefing.text, "Revisit e:"), "utf8")).toBeLessThanOrEqual(
      REVISIT_BYTES,
    )
  })
})

test("Given a visit lasting exactly five seconds, when assembled, then it is a dwell", () => {
  withLedger((db) => {
    // Given a five-second first page followed by a five-second second page.
    const first = write(db, 0)
    write(db, 5_000, { url: "https://fixture.invalid/second", content: fixture.otherBody })
    write(db, 10_000, { url: "https://fixture.invalid/second", content: null })

    // When the boundary duration is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the first page is a dwell and retains its snapshot.
    expect(briefing.text).not.toContain("Also glanced at:")
    expect(briefing.text).toContain(`Snapshot e:${first}`)
  })
})

test("Given one event with a verified five-second dwell, when assembled, then its snapshot is not reduced to a glance", () => {
  withLedger((db) => {
    // Given one capture whose foreground dwell was confirmed after five seconds.
    const snapshot = write(db, 0)
    markNonGlanceEvent(db, snapshot, from)

    // When a closed ten-minute window is assembled without another event.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the qualifying source keeps its snapshot and citation.
    expect(briefing.text).toContain(`Snapshot e:${snapshot}`)
    expect(briefing.text).not.toContain("Also glanced at:")
  })
})

test("Given a session boundary, when assembled, then dwell ends there and a new segment starts", () => {
  withLedger((db) => {
    // Given the same page on both sides of a session end and restart.
    const first = write(db, 0)
    write(db, 10_000, { kind: "session.ended", appName: "", url: null, content: null })
    write(db, 80_000, { kind: "session.started", appName: "", url: null, content: null })
    const second = write(db, 90_000)
    write(db, 96_000, { kind: "keyboard.text_input", content: "After restart." })

    // When the window is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then it has two cited dwell segments for the same page.
    expect(briefing.text.match(/refs: e:/g)).toHaveLength(2)
    expect(briefing.text).toContain(`[${timeLabel(from)}–${timeLabel(from + 10_000)}]`)
    expect(briefing.text).toContain(`[${timeLabel(from + 90_000)}–${timeLabel(from + 96_000)}]`)
    expect(briefing.text).toContain(`Snapshot e:${first}`)
    expect(briefing.text).toContain(`Snapshot e:${second}`)
    expect(briefing.text).not.toContain("Also glanced at:")
  })
})

test("Given an Aside snapshot without an app name, when assembled, then its bundle ID identifies the app", () => {
  withLedger((db) => {
    // Given a URL capture with only its source bundle ID.
    write(db, 0, { appName: "", bundleId: "fixture.aside.browser", windowTitle: "" })
    write(db, 6_000, {
      appName: "",
      bundleId: "fixture.aside.browser",
      windowTitle: "",
      kind: "window.changed",
      content: null,
    })

    // When the evidence is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the bundle ID and normalized URL remain available to prompt validation.
    expect(briefing.apps).toEqual(new Set(["fixture.aside.browser"]))
    expect(briefing.text).toContain("fixture.aside.browser")
    expect(briefing.text).toContain("https://fixture.invalid/orchard")
  })
})

test("Given a cold framed blob, when assembled, then its snapshot is read through the ledger frame reader", () => {
  withLedger((db) => {
    // Given a snapshot already moved into an encrypted frame.
    const snapshot = write(db, 0)
    write(db, 6_000, { kind: "window.changed", content: null })
    expect(sealColdBlobs(db, key, from + FRAME_COLD_AGE_MS + 1)).toBe(1)

    // When the briefing reads the window.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the original snapshot is cited and its synthetic content survives.
    expect(briefing.text).toContain(`Snapshot e:${snapshot}`)
    expect(briefing.text).toContain(fixture.body)
  })
})

test("Given click, shortcut, and submit events, when assembled, then one cited interaction list preserves them", () => {
  withLedger((db) => {
    // Given three interaction kinds after a page snapshot.
    write(db, 0)
    const click = write(db, 6_000, {
      kind: "mouse.click",
      content: null,
      target: { label: "Open orchard" },
    })
    const shortcut = write(db, 7_000, {
      kind: "keyboard.shortcut",
      content: null,
      payload: { chord: "⌘S" },
    })
    const submit = write(db, 8_000, {
      kind: "keyboard.submit",
      content: null,
      target: { label: "Send plan" },
    })

    // When the segment is assembled.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the actions share one compressed list with their own event refs.
    expect(briefing.text.match(/^Interactions:/gm)).toHaveLength(1)
    expect(briefing.text).toContain(`e:${click} click Open orchard`)
    expect(briefing.text).toContain(`e:${shortcut} shortcut ⌘S`)
    expect(briefing.text).toContain(`e:${submit} submit Send plan`)
  })
})

test("Given oversized interactions and headings, when budgeted, then typed and selection outlive them", () => {
  withLedger((db) => {
    // Given large lower-priority evidence and small input evidence in one dwell.
    const headings = Array.from(
      { length: 10 },
      (_, index) => `## Synthetic heading ${index} ${"orchard ".repeat(800)}`,
    ).join("\n")
    write(db, 0, { content: headings })
    write(db, 6_000, {
      kind: "mouse.click",
      content: null,
      target: { label: "click ".repeat(12_000) },
    })
    write(db, 7_000, { kind: "keyboard.text_input", content: "Typed priority survives." })
    write(db, 8_000, { kind: "selection.changed", content: "Selected priority survives." })

    // When the lower-priority material exceeds the briefing budget.
    const briefing = assembleBriefing(db, key, from, to)

    // Then the budget is met by shedding snapshots, interactions, and index first.
    expect(Buffer.byteLength(briefing.text, "utf8")).toBeLessThanOrEqual(
      BRIEFING_CONTENT_BUDGET_BYTES,
    )
    expect(briefing.text).not.toContain("Interactions:")
    expect(briefing.text.match(/^Index e:/gm)?.length ?? 0).toBeLessThan(10)
    expect(briefing.text).toContain("Typed priority survives.")
    expect(briefing.text).toContain("Selected priority survives.")
  })
})

test("Given over 100KB of distinct snapshots, when assembled, then head and tail survive inside the budget", () => {
  withLedger((db) => {
    // Given two long, distinct captures plus high-priority typed and selected evidence.
    const north = Array.from({ length: 8_000 }, (_, index) => `north-${index}`).join(" ")
    const south = Array.from({ length: 8_000 }, (_, index) => `south-${index}`).join(" ")
    expect(Buffer.byteLength(north + south, "utf8")).toBeGreaterThan(100_000)
    write(db, 0, { content: north })
    write(db, 6_000, { content: south })
    write(db, 7_000, { kind: "keyboard.text_input", content: "Synthetic priority sentence." })
    write(db, 8_000, { kind: "selection.changed", content: "Synthetic priority selection." })

    // When the briefing is assembled under the fixed content budget.
    const briefing = assembleBriefing(db, key, from, to)

    // Then both snapshot boundaries and higher-priority input evidence remain.
    expect(Buffer.byteLength(briefing.text, "utf8")).toBeLessThanOrEqual(
      BRIEFING_CONTENT_BUDGET_BYTES,
    )
    expect(briefing.text.match(/…\[truncated\]…/g)).toHaveLength(2)
    for (const token of ["north-0", "north-7999", "south-0", "south-7999"]) {
      expect(briefing.text).toContain(token)
    }
    expect(briefing.text).toContain("Synthetic priority sentence.")
    expect(briefing.text).toContain("Synthetic priority selection.")
  })
})
