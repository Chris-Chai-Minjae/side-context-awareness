import { createHash } from "node:crypto"
import { CA_INDEX_VERSION, CA_MAX_EMBED_CHARS } from "../constants"

const DAY_PATH = /^episodic\/context-awareness-(\d{4}-\d{2}-\d{2})\.md$/
const WINDOW_HEADING =
  /^### (\d{2}:\d{2})(?:[ \t]+–[ \t]+|[ \t]+)(\d{2}:\d{2})(?:[ \t]+—[ \t]+|[ \t]+).+?[ \t]+s:([^ \t]+)[ \t]*$/

export type ContextAwarenessChunk = {
  readonly id: string
  readonly path: string
  readonly day: string
  readonly windowFrom: string
  readonly windowTo: string
  readonly heading: string
  readonly text: string
  readonly summaryId: string | null
}

type Section = Pick<ContextAwarenessChunk, "heading" | "windowFrom" | "windowTo" | "summaryId">

function sectionTexts(heading: string, body: string): string[] {
  const limit = Math.floor(CA_MAX_EMBED_CHARS)
  const capacity = limit - heading.length - 1
  if (heading.length > limit) throw new RangeError("Day page heading exceeds embedding limit")
  if (body.length === 0) return [heading]
  if (capacity < 1) throw new RangeError("Day page heading exceeds embedding limit")

  const texts: string[] = []
  let piece = ""
  for (const paragraph of body.split(/\n[ \t]*\n/)) {
    let remaining = paragraph
    while (remaining.length > 0) {
      const separator = piece ? "\n\n" : ""
      const room = capacity - piece.length - separator.length
      if (remaining.length <= room) {
        piece += `${separator}${remaining}`
        break
      }
      if (piece) {
        texts.push(`${heading}\n${piece}`)
        piece = ""
        continue
      }
      let end = capacity
      const code = remaining.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
      if (end === 0) throw new RangeError("Paragraph character exceeds embedding limit")
      texts.push(`${heading}\n${remaining.slice(0, end)}`)
      remaining = remaining.slice(end)
    }
  }
  if (piece) texts.push(`${heading}\n${piece}`)
  return texts
}

export function chunkContextAwarenessDayPage(
  path: string,
  page: string,
): readonly ContextAwarenessChunk[] {
  const day = DAY_PATH.exec(path)?.[1]
  if (!day) return []

  const chunks: ContextAwarenessChunk[] = []
  let section: Section | null = null
  let bodyLines: string[] = []
  const flush = () => {
    if (!section) return
    const body = bodyLines.join("\n").trim()
    for (const text of sectionTexts(section.heading, body)) {
      const id = createHash("sha256")
        .update(`${CA_INDEX_VERSION}${path}${section.heading}${text}`)
        .digest("hex")
        .slice(0, 32)
      chunks.push({ id, path, day, ...section, text })
    }
    bodyLines = []
  }

  for (const line of page.split(/\r?\n/)) {
    const overview = line === "## Day overview"
    const match = WINDOW_HEADING.exec(line)
    if (!overview && !match) {
      if (section) bodyLines.push(line)
      continue
    }
    flush()
    if (overview) {
      section = { heading: line, windowFrom: "00:00", windowTo: "24:00", summaryId: null }
      continue
    }
    const windowFrom = match?.[1]
    const windowTo = match?.[2]
    const summaryId = match?.[3]
    if (windowFrom && windowTo && summaryId)
      section = { heading: line, windowFrom, windowTo, summaryId }
  }
  flush()
  return chunks
}
