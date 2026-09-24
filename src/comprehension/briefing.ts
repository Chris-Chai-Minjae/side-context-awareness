import type { Database } from "bun:sqlite"
import { z } from "zod"
import {
  BRIEFING_CONTENT_BUDGET_BYTES,
  BRIEFING_JACCARD_DUPLICATE_THRESHOLD,
  BRIEFING_SNAPSHOT_HEAD_FRACTION,
  GLANCE_MS,
  MS_PER_DAY,
  PAGE_INDEX_LINES_PER_SEGMENT,
  REVISIT_BYTES,
  SELECTION_BYTES,
  SNAPSHOTS_PER_SEGMENT,
  TYPED_RUN_BYTES,
} from "../constants"
import { deriveSubkey, open } from "../crypto/index"
import { readBlobContent } from "../ledger/frames"
import type { LedgerEventInput } from "../ledger/write"

export type Briefing = {
  readonly text: string
  readonly evidenceIds: ReadonlySet<string>
  readonly apps: ReadonlySet<string>
  readonly domains: ReadonlySet<string>
}

type EventRow = {
  readonly id: string
  readonly occurred_at: number
  readonly kind: LedgerEventInput["kind"]
  readonly app_name: string
  readonly bundle_id: string
  readonly window_title: string
  readonly url: string | null
  readonly domain: string | null
  readonly target: string
  readonly payload: string
  readonly blob_id: string | null
  readonly non_glance: number
}
type Event = {
  readonly id: string
  readonly at: number
  readonly kind: LedgerEventInput["kind"]
  readonly app: string
  readonly title: string
  readonly url: string | null
  readonly domain: string | null
  readonly label: string
  readonly chord: string
  readonly content: string
  readonly nonGlance: boolean
}
type Segment = { readonly events: Event[]; readonly first: Event; end: number }
type EntryKind =
  | "header"
  | "glance"
  | "snapshot"
  | "index"
  | "typed"
  | "selection"
  | "interaction"
  | "revisit"
type Entry = {
  readonly kind: EntryKind
  readonly prefix: string
  value: string
  readonly refs: readonly string[]
  readonly apps: readonly string[]
  readonly domains: readonly string[]
}

const PayloadSchema = z.object({ inlineText: z.string().optional(), chord: z.string().optional() })
const TargetSchema = z.object({ label: z.string().optional() })
const SourceIdsSchema = z.array(z.string())
const truncationMarker = "…[truncated]…"

function utf8Head(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > maxBytes) break
    output += character
    bytes += size
  }
  return output
}

function utf8Tail(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const character of Array.from(value).reverse()) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > maxBytes) break
    output = character + output
    bytes += size
  }
  return output
}

function headTail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const markerBytes = Buffer.byteLength(truncationMarker, "utf8")
  if (maxBytes <= markerBytes) return utf8Head(value, maxBytes)
  const available = maxBytes - markerBytes
  const headBytes = Math.ceil(available * BRIEFING_SNAPSHOT_HEAD_FRACTION)
  return `${utf8Head(value, headBytes)}${truncationMarker}${utf8Tail(value, available - headBytes)}`
}

function displayText(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

function ref(id: string): string {
  return `e:${id}`
}

function atTime(value: number): string {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function entry(kind: EntryKind, prefix: string, value: string, events: readonly Event[]): Entry {
  return {
    kind,
    prefix,
    value,
    refs: events.map((event) => ref(event.id)),
    apps: [...new Set(events.map((event) => event.app).filter(Boolean))],
    domains: [...new Set(events.map((event) => event.domain).filter((domain) => domain !== null))],
  }
}

function readEvents(db: Database, masterKey: Buffer, from: number, to: number): Event[] {
  const rows = db
    .query<EventRow, [number, number]>(`
    SELECT e.id, e.occurred_at, e.kind, e.app_name, e.bundle_id, e.window_title,
           e.url, e.domain, e.target, e.payload, e.blob_id,
           CASE WHEN qualified.key IS NULL THEN 0 ELSE 1 END AS non_glance
    FROM context_awareness_events AS e
    LEFT JOIN side_meta AS qualified ON qualified.key = 'summary_non_glance_event:' || e.id
    WHERE e.occurred_at >= ? AND e.occurred_at < ?
    ORDER BY e.occurred_at, e.id
  `)
    .all(from, to)
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  return rows.map((row) => {
    const aad = (column: string): string => `context_awareness_events:${column}:${row.id}`
    const title =
      row.window_title === ""
        ? ""
        : z.string().parse(open<unknown>(row.window_title, evidenceKey, aad("window_title")))
    const url =
      row.url === null ? null : z.string().parse(open<unknown>(row.url, evidenceKey, aad("url")))
    const target =
      row.target === "{}"
        ? {}
        : TargetSchema.parse(open<unknown>(row.target, evidenceKey, aad("target")))
    const payload = PayloadSchema.parse(open<unknown>(row.payload, evidenceKey, aad("payload")))
    const content = row.blob_id === null ? "" : (readBlobContent(db, masterKey, row.blob_id) ?? "")
    return {
      id: row.id,
      at: row.occurred_at,
      kind: row.kind,
      app: row.app_name || row.bundle_id,
      title: title || url || "",
      url,
      domain: row.domain,
      label: target.label ?? "",
      chord: payload.chord ?? "",
      content: content || payload.inlineText || "",
      nonGlance: row.non_glance === 1,
    }
  })
}

function segments(events: readonly Event[]): Segment[] {
  const result: Segment[] = []
  let sessionBoundary = false
  for (const event of events) {
    const previous = result.at(-1)
    if (event.kind === "session.started" || event.kind === "session.ended") {
      if (previous && !sessionBoundary) previous.end = event.at
      sessionBoundary = true
      continue
    }
    if (
      previous &&
      !sessionBoundary &&
      previous.first.app === event.app &&
      (previous.first.url ?? previous.first.title) === (event.url ?? event.title)
    ) {
      previous.events.push(event)
      previous.end = event.at
      continue
    }
    if (previous && !sessionBoundary) previous.end = event.at
    result.push({ events: [event], first: event, end: event.at })
    sessionBoundary = false
  }
  return result
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu) ?? [])
}

function similar(first: string, last: string): boolean {
  const left = words(first)
  const right = words(last)
  if (left.size === 0 && right.size === 0) return true
  let overlap = 0
  for (const word of left) if (right.has(word)) overlap++
  return overlap / (left.size + right.size - overlap) >= BRIEFING_JACCARD_DUPLICATE_THRESHOLD
}

function selectedSnapshots(segment: Segment): Event[] {
  const snapshots = segment.events.filter(
    (event) =>
      (event.kind === "content.snapshot" || event.kind === "screen.ocr") &&
      event.content.length > 0,
  )
  const first = snapshots[0]
  const last = snapshots.at(-1)
  if (!first) return []
  if (!last || first === last || similar(first.content, last.content)) return [first]
  return [first, last].slice(0, SNAPSHOTS_PER_SEGMENT)
}

function priorExcerpt(
  db: Database,
  evidenceKey: Buffer,
  segment: Segment,
  windowFrom: number,
): string | null {
  const { url, domain } = segment.first
  if (!url || !domain) return null
  const prior = db
    .query<{ id: string; url: string }, [number, number, string]>(`
    SELECT id, url FROM context_awareness_events
    WHERE occurred_at >= ? AND occurred_at < ? AND domain = ? AND url IS NOT NULL
    ORDER BY occurred_at DESC, id DESC
  `)
    .all(windowFrom - MS_PER_DAY, windowFrom, domain)
  const summaries = db
    .query<{ body: string | null; source_ids: string }, [number, number]>(`
    SELECT body, source_ids FROM context_awareness_summaries
    WHERE kind = '10min' AND status = 'done' AND window_to > ? AND window_to <= ?
    ORDER BY window_to DESC
  `)
    .all(windowFrom - MS_PER_DAY, windowFrom)
  let visited = false
  for (const old of prior) {
    const oldUrl = z
      .string()
      .parse(open<unknown>(old.url, evidenceKey, `context_awareness_events:url:${old.id}`))
    if (oldUrl !== url) continue
    visited = true
    const sourceId = ref(old.id)
    for (const summary of summaries) {
      if (
        SourceIdsSchema.parse(JSON.parse(summary.source_ids)).includes(sourceId) &&
        summary.body
      ) {
        return utf8Head(displayText(summary.body), REVISIT_BYTES)
      }
    }
  }
  return visited ? "seen earlier" : null
}

function buildEntries(
  db: Database,
  masterKey: Buffer,
  groups: readonly Segment[],
  from: number,
): Entry[] {
  const result: Entry[] = []
  const glances: Segment[] = []
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  for (const segment of groups) {
    const first = segment.first
    const glance =
      segment.end - first.at < GLANCE_MS && !segment.events.some((event) => event.nonGlance)
    if (glance) glances.push(segment)
    else {
      const domain = first.domain ? ` (${first.domain})` : ""
      result.push(
        entry(
          "header",
          `[${atTime(first.at)}–${atTime(segment.end)}] ${first.app} — ${first.title}${domain}  refs: ${ref(first.id)}`,
          "",
          [first],
        ),
      )
      const snapshots = selectedSnapshots(segment)
      const seenHeadings = new Set<string>()
      let indexLines = 0
      for (const snapshot of snapshots) {
        result.push(
          entry("snapshot", `Snapshot ${ref(snapshot.id)}: `, snapshot.content, [snapshot]),
        )
        for (const line of snapshot.content.split(/\r?\n/u)) {
          const heading = displayText(line)
          if (
            !/^(?:#{1,6}\s+|(?:heading|title)\s*[:：])/iu.test(heading) ||
            seenHeadings.has(heading)
          )
            continue
          if (indexLines >= PAGE_INDEX_LINES_PER_SEGMENT) break
          seenHeadings.add(heading)
          result.push(entry("index", `Index ${ref(snapshot.id)}: `, heading, [snapshot]))
          indexLines++
        }
      }
      const revisit = priorExcerpt(db, evidenceKey, segment, from)
      if (revisit !== null)
        result.push(entry("revisit", `Revisit ${ref(first.id)}: `, revisit, [first]))
    }

    let typed = ""
    const typedEvents: Event[] = []
    for (const event of segment.events) {
      if (event.kind !== "keyboard.text_input" || !event.content) continue
      const separator = typed ? " " : ""
      const addition = utf8Head(
        displayText(event.content),
        TYPED_RUN_BYTES - Buffer.byteLength(typed + separator, "utf8"),
      )
      if (!addition) continue
      typed += separator + addition
      typedEvents.push(event)
    }
    if (typedEvents.length > 0)
      result.push(
        entry(
          "typed",
          `Typed ${typedEvents.map((event) => ref(event.id)).join(", ")}: `,
          typed,
          typedEvents,
        ),
      )
    for (const event of segment.events) {
      if (event.kind !== "selection.changed" || !event.content) continue
      result.push(
        entry(
          "selection",
          `Selection ${ref(event.id)}: `,
          utf8Head(displayText(event.content), SELECTION_BYTES),
          [event],
        ),
      )
    }
    if (!glance) {
      const interactions = segment.events.filter(
        (event) =>
          event.kind === "mouse.click" ||
          event.kind === "keyboard.shortcut" ||
          event.kind === "keyboard.submit",
      )
      if (interactions.length > 0) {
        const labels = interactions.map((event) => {
          const action =
            event.kind === "mouse.click"
              ? "click"
              : event.kind === "keyboard.shortcut"
                ? "shortcut"
                : "submit"
          return `${ref(event.id)} ${action} ${displayText(event.kind === "keyboard.shortcut" ? event.chord : event.label)}`
        })
        result.push(entry("interaction", "Interactions: ", labels.join("; "), interactions))
      }
    }
  }
  if (glances.length > 0) {
    const firstEvents = glances.map((segment) => segment.first)
    const descriptions = firstEvents.map(
      (event) =>
        `${ref(event.id)} ${event.app} — ${event.title}${event.domain ? ` (${event.domain})` : ""}`,
    )
    result.unshift(entry("glance", "Also glanced at: ", descriptions.join("; "), firstEvents))
  }
  return result
}

function byteLength(entries: readonly Entry[]): number {
  return Buffer.byteLength(entries.map((item) => item.prefix + item.value).join("\n"), "utf8")
}

function fitBudget(entries: Entry[]): Entry[] {
  const snapshots = entries.filter((item) => item.kind === "snapshot")
  const otherBytes =
    byteLength(entries) -
    snapshots.reduce((sum, item) => sum + Buffer.byteLength(item.value, "utf8"), 0)
  const available = Math.max(0, BRIEFING_CONTENT_BUDGET_BYTES - otherBytes)
  if (snapshots.length > 0) {
    let low = 0
    let high = Math.max(...snapshots.map((item) => Buffer.byteLength(item.value, "utf8")))
    while (low < high) {
      const cap = Math.ceil((low + high) / 2)
      const size = snapshots.reduce(
        (sum, item) => sum + Buffer.byteLength(headTail(item.value, cap), "utf8"),
        0,
      )
      if (size <= available) low = cap
      else high = cap - 1
    }
    for (const item of snapshots) item.value = headTail(item.value, low)
  }
  for (const kind of [
    "snapshot",
    "interaction",
    "index",
    "revisit",
    "glance",
    "header",
    "typed",
    "selection",
  ] as const) {
    for (
      let index = entries.length - 1;
      index >= 0 && byteLength(entries) > BRIEFING_CONTENT_BUDGET_BYTES;
      index--
    ) {
      if (entries[index]?.kind === kind && (kind !== "snapshot" || entries[index]?.value === ""))
        entries.splice(index, 1)
    }
  }
  return entries
}

export function assembleBriefing(
  db: Database,
  masterKey: Buffer,
  windowFrom: number,
  windowTo: number,
): Briefing {
  const groups = segments(readEvents(db, masterKey, windowFrom, windowTo))
  const entries = fitBudget(buildEntries(db, masterKey, groups, windowFrom))
  return {
    text: entries.map((item) => item.prefix + item.value).join("\n"),
    evidenceIds: new Set(entries.flatMap((item) => item.refs)),
    apps: new Set(entries.flatMap((item) => item.apps)),
    domains: new Set(entries.flatMap((item) => item.domains)),
  }
}
