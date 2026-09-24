import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import {
  FRAME_CACHE_MAX_BYTES,
  FRAME_COLD_AGE_MS,
  FRAME_IDLE_SEAL_MS,
  FRAME_MAX_MEMBERS,
  FRAME_MAX_RAW_BYTES,
  FRAME_ZSTD_LEVEL,
  SEAL_BATCH_BLOBS,
} from "../constants"
import { deriveSubkey, keyedHash, open, seal } from "../crypto/index"

type UnsealedBlob = {
  readonly id: string
  readonly content: Uint8Array
}
type FrameMember = { readonly id: string; readonly content: Buffer }
type FrameRow = { readonly content: Uint8Array; readonly member_count: number }

export class LedgerFrameFormatError extends Error {
  constructor() {
    super("Invalid encrypted ledger frame member offsets")
    this.name = "LedgerFrameFormatError"
  }
}

export class FrameReadCache {
  private readonly entries = new Map<string, Buffer>()
  private keyFingerprint: string | null = null
  private usedBytes = 0

  get byteLength(): number {
    return this.usedBytes
  }

  useKey(evidenceKey: Buffer): void {
    const fingerprint = keyedHash("frame-read-cache", evidenceKey)
    if (this.keyFingerprint !== null && this.keyFingerprint !== fingerprint) this.clear()
    this.keyFingerprint = fingerprint
  }

  get(frameId: string): Buffer | undefined {
    const value = this.entries.get(frameId)
    if (value) {
      this.entries.delete(frameId)
      this.entries.set(frameId, value)
    }
    return value
  }

  set(frameId: string, raw: Buffer): void {
    this.delete(frameId)
    if (raw.byteLength > FRAME_CACHE_MAX_BYTES) return
    while (this.usedBytes + raw.byteLength > FRAME_CACHE_MAX_BYTES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.entries.set(frameId, raw)
    this.usedBytes += raw.byteLength
  }

  delete(frameId: string): void {
    const value = this.entries.get(frameId)
    if (!value) return
    this.entries.delete(frameId)
    this.usedBytes -= value.byteLength
    value.fill(0)
  }

  clear(): void {
    for (const frameId of this.entries.keys()) this.delete(frameId)
  }
}

const defaultCaches = new WeakMap<Database, FrameReadCache>()

function cacheFor(db: Database): FrameReadCache {
  let cache = defaultCaches.get(db)
  if (!cache) {
    cache = new FrameReadCache()
    defaultCaches.set(db, cache)
  }
  return cache
}

export function clearFrameReadCache(db: Database): void {
  defaultCaches.get(db)?.clear()
}

function unpackMember(raw: Buffer, count: number, index: number): Buffer {
  const width = Uint32Array.BYTES_PER_ELEMENT
  const tableBytes = (count + 1) * width
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count ||
    raw.byteLength < tableBytes
  ) {
    throw new LedgerFrameFormatError()
  }
  const dataBytes = raw.byteLength - tableBytes
  const first = raw.readUInt32LE(0)
  const last = raw.readUInt32LE(count * width)
  const from = raw.readUInt32LE(index * width)
  const to = raw.readUInt32LE((index + 1) * width)
  if (first !== 0 || last !== dataBytes || from > to || to > dataBytes) {
    throw new LedgerFrameFormatError()
  }
  return raw.subarray(tableBytes + from, tableBytes + to)
}

function rawFrame(members: readonly FrameMember[]): Buffer {
  const width = Uint32Array.BYTES_PER_ELEMENT
  const offsets = Buffer.alloc((members.length + 1) * width)
  let offset = 0
  for (const [index, member] of members.entries()) {
    offsets.writeUInt32LE(offset, index * width)
    offset += member.content.byteLength
  }
  offsets.writeUInt32LE(offset, members.length * width)
  return Buffer.concat([offsets, ...members.map((member) => member.content)])
}

function insertFrame(
  db: Database,
  evidenceKey: Buffer,
  members: readonly FrameMember[],
  now: number,
): string {
  const id = ulid(now)
  const compressed = Bun.zstdCompressSync(rawFrame(members), { level: FRAME_ZSTD_LEVEL })
  const encrypted = Buffer.from(
    seal(compressed.toString("base64url"), evidenceKey, `context_awareness_frames:content:${id}`),
    "base64url",
  )
  db.query(`
    INSERT INTO context_awareness_frames (id, content, member_count, stored_bytes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, encrypted, members.length, encrypted.byteLength, now)
  const update = db.query(`
    UPDATE context_awareness_blobs SET content = ?, frame_id = ?, frame_index = ? WHERE id = ?
  `)
  for (const [index, member] of members.entries()) update.run(Buffer.alloc(0), id, index, member.id)
  return id
}

function readFrame(
  db: Database,
  evidenceKey: Buffer,
  frameId: string,
  cache: FrameReadCache,
): { raw: Buffer; count: number } {
  cache.useKey(evidenceKey)
  const row = db
    .query<FrameRow, [string]>(
      "SELECT content, member_count FROM context_awareness_frames WHERE id = ?",
    )
    .get(frameId)
  if (!row) throw new LedgerFrameFormatError()
  const cached = cache.get(frameId)
  if (cached) return { raw: cached, count: row.member_count }
  const ciphertext = Buffer.from(row.content).toString("base64url")
  const compressed = Buffer.from(
    open<string>(ciphertext, evidenceKey, `context_awareness_frames:content:${frameId}`),
    "base64url",
  )
  const raw = Bun.zstdDecompressSync(compressed)
  cache.set(frameId, raw)
  return { raw, count: row.member_count }
}

export function readBlobContent(
  db: Database,
  masterKey: Buffer,
  blobId: string,
  cache: FrameReadCache = cacheFor(db),
): string | null {
  const blob = db
    .query<{ content: Uint8Array; frame_id: string | null; frame_index: number | null }, [string]>(
      "SELECT content, frame_id, frame_index FROM context_awareness_blobs WHERE id = ?",
    )
    .get(blobId)
  if (!blob) return null
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  if (blob.frame_id === null) {
    const ciphertext = Buffer.from(blob.content).toString("base64url")
    return open<string>(ciphertext, evidenceKey, `context_awareness_blobs:content:${blobId}`)
  }
  if (blob.frame_index === null) throw new LedgerFrameFormatError()
  const frame = readFrame(db, evidenceKey, blob.frame_id, cache)
  return unpackMember(frame.raw, frame.count, blob.frame_index).toString("utf8")
}

export function sealColdBlobs(db: Database, masterKey: Buffer, now: number): number {
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  return db.transaction(() => {
    const candidates = db
      .query<UnsealedBlob, [number, number, number, number]>(`
        SELECT id, content FROM context_awareness_blobs
        WHERE frame_id IS NULL AND redacted_bytes <= ?
          AND (last_seen_at <= ? OR COALESCE(
            (SELECT MAX(occurred_at) FROM context_awareness_events),
            (SELECT MAX(last_seen_at) FROM context_awareness_blobs)
          ) <= ?)
        ORDER BY last_seen_at, id LIMIT ?
      `)
      .all(FRAME_MAX_RAW_BYTES, now - FRAME_COLD_AGE_MS, now - FRAME_IDLE_SEAL_MS, SEAL_BATCH_BLOBS)
    let group: FrameMember[] = []
    let groupBytes = 0
    let sealed = 0
    for (const blob of candidates) {
      const ciphertext = Buffer.from(blob.content).toString("base64url")
      const content = Buffer.from(
        open<string>(ciphertext, evidenceKey, `context_awareness_blobs:content:${blob.id}`),
        "utf8",
      )
      const offsetBytes = Uint32Array.BYTES_PER_ELEMENT
      // Each member adds one offset, and the table ends with a terminal offset.
      if (content.byteLength + 2 * offsetBytes > FRAME_MAX_RAW_BYTES) continue
      if (
        group.length >= FRAME_MAX_MEMBERS ||
        groupBytes + content.byteLength + (group.length + 2) * offsetBytes > FRAME_MAX_RAW_BYTES
      ) {
        insertFrame(db, evidenceKey, group, now)
        group = []
        groupBytes = 0
      }
      group.push({ id: blob.id, content })
      groupBytes += content.byteLength
      sealed++
    }
    if (group.length > 0) insertFrame(db, evidenceKey, group, now)
    return sealed
  })()
}

export function compactFrame(
  db: Database,
  masterKey: Buffer,
  frameId: string,
  now: number,
): boolean {
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  const frame = db
    .query<{ member_count: number }, [string]>(
      "SELECT member_count FROM context_awareness_frames WHERE id = ?",
    )
    .get(frameId)
  if (!frame) return false
  const live = db
    .query<{ id: string; frame_index: number }, [string]>(
      "SELECT id, frame_index FROM context_awareness_blobs WHERE frame_id = ? ORDER BY frame_index",
    )
    .all(frameId)
  if (live.length === frame.member_count) return false
  if (live.length > 0) {
    const source = readFrame(db, evidenceKey, frameId, cacheFor(db))
    const members = live.map((blob) => ({
      id: blob.id,
      content: Buffer.from(unpackMember(source.raw, source.count, blob.frame_index)),
    }))
    insertFrame(db, evidenceKey, members, now)
  }
  db.query("DELETE FROM context_awareness_frames WHERE id = ?").run(frameId)
  defaultCaches.get(db)?.delete(frameId)
  return true
}
