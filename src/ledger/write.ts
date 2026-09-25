import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import { recordCommittedEventForSummary } from "../comprehension/queue"
import { INLINE_TEXT_BYTES, TERM_SOURCE_CHARS } from "../constants"
import { deriveSubkey, keyedHash, seal } from "../crypto/index"
import { normalizePageUrl } from "../policy/url"
import { type RedactionRule, redact } from "../redact/index"
import { indexTerms } from "./terms"

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject
type JsonObject = { readonly [key: string]: JsonValue }

export type LedgerEventInput = {
  readonly occurredAt: number
  readonly source: "mac_ax" | "aside_dom"
  readonly kind:
    | "session.started"
    | "session.ended"
    | "window.changed"
    | "mouse.click"
    | "mouse.context_menu"
    | "mouse.drag"
    | "keyboard.shortcut"
    | "keyboard.submit"
    | "keyboard.text_input"
    | "selection.changed"
    | "content.snapshot"
    | "screen.ocr"
  readonly appName?: string
  readonly bundleId?: string
  readonly windowTitle?: string
  readonly url?: string | null
  readonly target?: JsonObject
  readonly payload?: {
    readonly trigger?: string
    readonly triggerAt?: number
    readonly shape?: string
    readonly inlineText?: string
    readonly redactedField?: string
    readonly chord?: string
    readonly reason?: string
  }
  readonly content?: string | null
  readonly fieldSuppressions?: number
  readonly sessionId?: string | null
}

export type LedgerWriteResult = { readonly id: string; readonly blobId: string | null }

export class LedgerWriteInputError extends Error {
  constructor() {
    super("Ledger event timestamp must be a nonnegative safe integer")
    this.name = "LedgerWriteInputError"
  }
}

function limitUtf8(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= INLINE_TEXT_BYTES) return value
  let bytes = 0
  let result = ""
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > INLINE_TEXT_BYTES) break
    result += character
    bytes += size
  }
  return result
}

function localDay(occurredAt: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(occurredAt)
}

export function writeLedgerEvent(
  db: Database,
  masterKey: Buffer,
  input: LedgerEventInput,
): LedgerWriteResult {
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new LedgerWriteInputError()
  }
  if (
    input.fieldSuppressions !== undefined &&
    (!Number.isSafeInteger(input.fieldSuppressions) || input.fieldSuppressions < 0)
  ) {
    throw new LedgerWriteInputError()
  }

  const evidenceKey = deriveSubkey(masterKey, "evidence")
  const termsKey = deriveSubkey(masterKey, "terms")
  const contentHashKey = deriveSubkey(masterKey, "content-hash")
  const maskCounts = new Map<RedactionRule, number>()
  const safeText = (value: string): string => {
    const result = redact(value)
    for (const mask of result.masks) {
      maskCounts.set(mask.rule, (maskCounts.get(mask.rule) ?? 0) + mask.count)
    }
    return result.text
  }
  const safeValue = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return safeText(value)
    if (Array.isArray(value)) return value.map(safeValue)
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)]))
    }
    return value
  }

  const id = ulid(input.occurredAt)
  const appName = safeText(input.appName ?? "")
  const bundleId = safeText(input.bundleId ?? "")
  const windowTitle = safeText(input.windowTitle ?? "")
  const normalizedUrl = input.url ? normalizePageUrl(input.url) : null
  const url = normalizedUrl === null ? null : safeText(normalizedUrl)
  const domain = url === null ? null : (URL.parse(url)?.hostname.toLowerCase() ?? null)
  const target = Object.fromEntries(
    Object.entries(input.target ?? {}).map(([key, value]) => [key, safeValue(value)]),
  )
  const payload: Record<string, JsonValue> = {}
  for (const key of [
    "trigger",
    "shape",
    "inlineText",
    "redactedField",
    "chord",
    "reason",
  ] as const) {
    const value = input.payload?.[key]
    if (value !== undefined) payload[key] = safeText(value)
  }
  if (input.payload?.triggerAt !== undefined) {
    if (!Number.isSafeInteger(input.payload.triggerAt) || input.payload.triggerAt < 0) {
      throw new LedgerWriteInputError()
    }
    payload["triggerAt"] = input.payload.triggerAt
  }
  if (typeof payload["inlineText"] === "string") {
    payload["inlineText"] = limitUtf8(payload["inlineText"])
  }
  const content = input.content == null ? "" : safeText(input.content)
  if (input.fieldSuppressions !== undefined && input.fieldSuppressions > 0) {
    maskCounts.set("field", input.fieldSuppressions)
  }
  const masks = [...maskCounts].map(([rule, count]) => ({ rule, count }))
  payload["masks"] = masks
  const maskTotal = masks.reduce((sum, mask) => sum + mask.count, 0)
  const terms = indexTerms(
    `${windowTitle} ${payload["inlineText"] ?? ""} ${content.slice(0, TERM_SOURCE_CHARS)}`,
  )

  return db.transaction(() => {
    let blobId: string | null = null
    let newBlobBytes = 0
    let newBlobs = 0
    if (content.length > 0) {
      const contentHash = keyedHash(content.normalize("NFKC"), contentHashKey)
      const existing = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM context_awareness_blobs WHERE content_hash = ?",
        )
        .get(contentHash)
      if (existing) {
        blobId = existing.id
        db.query(
          "UPDATE context_awareness_blobs SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?",
        ).run(input.occurredAt, blobId)
      } else {
        blobId = ulid(input.occurredAt)
        newBlobBytes = Buffer.byteLength(content, "utf8")
        newBlobs = 1
        const sealed = seal(content, evidenceKey, `context_awareness_blobs:content:${blobId}`)
        db.query(`
          INSERT INTO context_awareness_blobs
            (id, content_hash, content, redacted_bytes, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          blobId,
          contentHash,
          Buffer.from(sealed, "base64url"),
          newBlobBytes,
          input.occurredAt,
          input.occurredAt,
        )
      }
    }

    const eventAad = (column: string): string => `context_awareness_events:${column}:${id}`
    db.query(`
      INSERT INTO context_awareness_events
        (id, occurred_at, source, kind, app_name, bundle_id, window_title, url, domain,
         target, payload, blob_id, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.occurredAt,
      input.source,
      input.kind,
      appName,
      bundleId,
      windowTitle.length === 0 ? "" : seal(windowTitle, evidenceKey, eventAad("window_title")),
      url === null ? null : seal(url, evidenceKey, eventAad("url")),
      domain,
      Object.keys(target).length === 0 ? "{}" : seal(target, evidenceKey, eventAad("target")),
      seal(payload, evidenceKey, eventAad("payload")),
      blobId,
      input.sessionId ?? null,
    )

    const insertTerm = db.query("INSERT INTO side_terms (term_hash, event_id) VALUES (?, ?)")
    for (const term of terms) insertTerm.run(keyedHash(term, termsKey), id)

    db.query(`
      INSERT INTO side_day_counters (day, events, blobs, raw_bytes, suppressions, masks)
      VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        events = COALESCE(events, 0) + excluded.events,
        blobs = COALESCE(blobs, 0) + excluded.blobs,
        raw_bytes = COALESCE(raw_bytes, 0) + excluded.raw_bytes,
        suppressions = COALESCE(suppressions, 0) + excluded.suppressions,
        masks = COALESCE(masks, 0) + excluded.masks
    `).run(localDay(input.occurredAt), newBlobs, newBlobBytes, 0, maskTotal)

    recordCommittedEventForSummary(db, input.occurredAt)

    return { id, blobId }
  })()
}
