import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { CA_INDEX_VERSION, CA_MAX_EMBED_CHARS } from "../../src/constants"
import { chunkContextAwarenessDayPage } from "../../src/memory/chunk"

const path = "episodic/context-awareness-2026-09-24.md"
const prefix = `---
render: '3'
updated_at: 2026-09-24T09:41:00+09:00
---
# Context awareness — 2026-09-24

_Captured by Side from on-device activity._

`

test("Given a v3 day page, when chunked, then overview and windows have separate metadata and salted ids", () => {
  // Given
  const page = `${prefix}## Day overview
- Morning work — Reviewed two articles.  s:rollup-1

### 09:10 – 09:20 — Read SQLite docs  s:window-1
Read the extension guide.

Sources: [Guide](https://fixture.invalid/guide) — e:event-1

### 09:20 – 09:30 — Wrote notes  s:window-2
Saved a local note.

Sources: e:event-2
`

  // When
  const chunks = chunkContextAwarenessDayPage(path, page)

  // Then
  expect(chunks).toHaveLength(3)
  expect(
    chunks.map(({ heading, windowFrom, windowTo, summaryId }) => ({
      heading,
      windowFrom,
      windowTo,
      summaryId,
    })),
  ).toEqual([
    { heading: "## Day overview", windowFrom: "00:00", windowTo: "24:00", summaryId: null },
    {
      heading: "### 09:10 – 09:20 — Read SQLite docs  s:window-1",
      windowFrom: "09:10",
      windowTo: "09:20",
      summaryId: "window-1",
    },
    {
      heading: "### 09:20 – 09:30 — Wrote notes  s:window-2",
      windowFrom: "09:20",
      windowTo: "09:30",
      summaryId: "window-2",
    },
  ])
  for (const chunk of chunks) {
    expect(chunk.path).toBe(path)
    expect(chunk.day).toBe("2026-09-24")
    expect(chunk.text.startsWith(chunk.heading)).toBe(true)
    expect(chunk.id).toBe(
      createHash("sha256")
        .update(`${CA_INDEX_VERSION}${path}${chunk.heading}${chunk.text}`)
        .digest("hex")
        .slice(0, 32),
    )
  }
  expect(chunks[0]?.text).toContain("Morning work")
  expect(chunks[1]?.text).toContain("Sources: [Guide]")
})

test("Given an original space-delimited heading, when chunked, then its window and summary id are parsed", () => {
  // Given
  const heading = "### 09:10   09:20     Read SQLite docs    s:legacy-1"
  const page = `${prefix}${heading}\nLegacy body.\n\nSources: e:event-1\n`

  // When
  const chunks = chunkContextAwarenessDayPage(path, page)

  // Then
  expect(chunks).toHaveLength(1)
  expect(chunks[0]).toMatchObject({
    heading,
    windowFrom: "09:10",
    windowTo: "09:20",
    summaryId: "legacy-1",
  })
  expect(chunks[0]?.text).toContain("Legacy body.")
})

test("Given a 3000-character window body, when chunked, then paragraphs stay whole and every chunk fits the cap", () => {
  // Given
  const heading = "### 09:10 – 09:20 — Long work  s:long-1"
  const paragraphs = ["A".repeat(1000), "B".repeat(1000), "C".repeat(1000)]
  const page = `${prefix}${heading}\n${paragraphs.join("\n\n")}\n`

  // When
  const chunks = chunkContextAwarenessDayPage(path, page)

  // Then
  expect(chunks.length).toBeGreaterThanOrEqual(3)
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(Math.floor(CA_MAX_EMBED_CHARS))
    expect(chunk.text.startsWith(heading)).toBe(true)
  }
  for (const paragraph of paragraphs) {
    expect(chunks.filter((chunk) => chunk.text.includes(paragraph))).toHaveLength(1)
  }
})

test("Given an unbroken oversized paragraph, when chunked, then no content is lost or exceeds the cap", () => {
  // Given
  const heading = "### 09:10 – 09:20 — Long note  s:long-2"
  const body = "x".repeat(3000)

  // When
  const chunks = chunkContextAwarenessDayPage(path, `${prefix}${heading}\n${body}\n`)

  // Then
  expect(chunks.length).toBeGreaterThanOrEqual(3)
  expect(chunks.every((chunk) => chunk.text.length <= Math.floor(CA_MAX_EMBED_CHARS))).toBe(true)
  expect(chunks.map((chunk) => chunk.text.slice(heading.length + 1)).join("")).toBe(body)
})

test("Given a path outside episodic day pages, when chunked, then no chunks are emitted", () => {
  // Given
  const page = `${prefix}### 09:10 – 09:20 — Read docs  s:window-1\nBody.\n`

  // When
  const chunks = chunkContextAwarenessDayPage("episodic/other.md", page)

  // Then
  expect(chunks).toEqual([])
})

test("Given a heading longer than the embedding cap, when chunked, then it cannot emit an oversized chunk", () => {
  // Given
  const heading = `### 09:10 – 09:20 — ${"x".repeat(Math.floor(CA_MAX_EMBED_CHARS))}  s:too-long`

  // When / Then
  expect(() => chunkContextAwarenessDayPage(path, `${prefix}${heading}\n`)).toThrow(RangeError)
})
