import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import {
  FRAME_CACHE_MAX_BYTES,
  FRAME_COLD_AGE_MS,
  FRAME_IDLE_SEAL_MS,
  FRAME_MAX_MEMBERS,
  FRAME_MAX_RAW_BYTES,
  SEAL_BATCH_BLOBS,
} from "../../src/constants"
import { deriveSubkey, keyedHash, open, seal } from "../../src/crypto/index"
import {
  compactFrame,
  FrameReadCache,
  readBlobContent,
  sealColdBlobs,
} from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

const masterKey = Buffer.alloc(32, 0x51)
const start = Date.parse("2026-09-24T10:00:00+09:00")

function withLedger(run: (db: Database, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-ledger-frames-"))
  const path = join(directory, "ledger.db")
  const db = openLedger(path)
  try {
    run(db, path)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function insertBlob(db: Database, content: string, at = start): string {
  const id = ulid(at)
  const evidenceKey = deriveSubkey(masterKey, "evidence")
  const hashKey = deriveSubkey(masterKey, "content-hash")
  db.query(`
    INSERT INTO context_awareness_blobs
      (id, content_hash, content, redacted_bytes, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    keyedHash(content, hashKey),
    Buffer.from(seal(content, evidenceKey, `context_awareness_blobs:content:${id}`), "base64url"),
    Buffer.byteLength(content),
    at,
    at,
  )
  return id
}

type FrameRow = {
  readonly id: string
  readonly content: Uint8Array
  readonly member_count: number
}

function frames(db: Database): FrameRow[] {
  return db
    .query<FrameRow, []>(
      "SELECT id, content, member_count FROM context_awareness_frames ORDER BY id",
    )
    .all()
}

describe("ledger frames", () => {
  test("Given 100 synthetic blobs, when fake clock advances 11m, then at least four sealed frames read exactly", () => {
    withLedger((db, path) => {
      const originals = new Map<string, string>()
      const large = "x".repeat(
        Math.floor((FRAME_MAX_RAW_BYTES - 3 * Uint32Array.BYTES_PER_ELEMENT) / 2) + 1,
      )
      for (let index = 0; index < 100; index++) {
        const content = index < 2 ? `${large}${index}` : `Synthetic frame body ${index}`
        const result = writeLedgerEvent(db, masterKey, {
          occurredAt: index < 2 ? start : start + 1,
          source: "mac_ax",
          kind: "content.snapshot",
          content,
        })
        if (!result.blobId) throw new Error("Synthetic blob was not written")
        originals.set(result.blobId, content)
      }

      expect(sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS - 1)).toBe(0)
      expect(sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 60_000)).toBe(100)

      const rows = frames(db)
      expect(rows.length).toBeGreaterThanOrEqual(4)
      for (const row of rows) {
        expect(row.member_count).toBeLessThanOrEqual(FRAME_MAX_MEMBERS)
        const sealed = Buffer.from(row.content).toString("base64url")
        const compressed = Buffer.from(
          open<string>(
            sealed,
            deriveSubkey(masterKey, "evidence"),
            `context_awareness_frames:content:${row.id}`,
          ),
          "base64url",
        )
        const raw = Bun.zstdDecompressSync(compressed)
        expect(raw.byteLength).toBeLessThanOrEqual(FRAME_MAX_RAW_BYTES)
      }

      const blobs = db
        .query<{ id: string; content: Uint8Array; frame_id: string; frame_index: number }, []>(
          "SELECT id, content, frame_id, frame_index FROM context_awareness_blobs",
        )
        .all()
      expect(blobs).toHaveLength(100)
      for (const blob of blobs) {
        const expected = originals.get(blob.id)
        if (expected === undefined) throw new Error("Synthetic blob lookup failed")
        expect(blob.content.byteLength).toBe(0)
        expect(blob.frame_index).toBeGreaterThanOrEqual(0)
        expect(readBlobContent(db, masterKey, blob.id)).toBe(expected)
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      expect(readFileSync(path).includes(Buffer.from("Synthetic frame body"))).toBe(false)
    })
  })

  test("Given an idle ledger, when the 20m idle threshold arrives, then an otherwise recent blob seals", () => {
    withLedger((db) => {
      writeLedgerEvent(db, masterKey, {
        occurredAt: start,
        source: "mac_ax",
        kind: "window.changed",
      })
      const id = insertBlob(db, "Synthetic idle fixture")
      db.query("UPDATE context_awareness_blobs SET last_seen_at = ? WHERE id = ?").run(
        start + FRAME_IDLE_SEAL_MS - 1,
        id,
      )
      expect(sealColdBlobs(db, masterKey, start + FRAME_IDLE_SEAL_MS - 1)).toBe(0)
      expect(sealColdBlobs(db, masterKey, start + FRAME_IDLE_SEAL_MS)).toBe(1)
      expect(readBlobContent(db, masterKey, id)).toBe("Synthetic idle fixture")
    })
  })

  test("Given more than one batch and large members, when sealing, then batch and raw byte limits hold", () => {
    withLedger((db) => {
      const large = "x".repeat(Math.floor(FRAME_MAX_RAW_BYTES / 2) + 1)
      const largeIds = [insertBlob(db, `${large}a`), insertBlob(db, `${large}b`)]
      for (let index = 0; index < SEAL_BATCH_BLOBS - largeIds.length + 1; index++) {
        insertBlob(db, `Synthetic batch fixture ${index}`)
      }
      expect(sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 1)).toBe(SEAL_BATCH_BLOBS)
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM context_awareness_blobs WHERE frame_id IS NULL",
          )
          .get()?.count,
      ).toBe(1)
      expect(frames(db).length).toBeGreaterThanOrEqual(2)
      for (const id of largeIds)
        expect(readBlobContent(db, masterKey, id)).toBe(`${large}${id === largeIds[0] ? "a" : "b"}`)
    })
  })

  test("Given three cached frames, when the oldest is touched before adding another, then LRU evicts the other", () => {
    const cache = new FrameReadCache()
    const half = Math.floor(FRAME_CACHE_MAX_BYTES / 2)
    cache.set("first", Buffer.alloc(half))
    cache.set("second", Buffer.alloc(half))
    expect(cache.get("first")).toBeDefined()
    cache.set("third", Buffer.alloc(half))
    expect(cache.get("first")).toBeDefined()
    expect(cache.get("second")).toBeUndefined()
    expect(cache.get("third")).toBeDefined()
    expect(cache.byteLength).toBeLessThanOrEqual(FRAME_CACHE_MAX_BYTES)
  })

  test("Given a cached sealed frame, when a different key reads it, then authentication still fails", () => {
    withLedger((db) => {
      const id = insertBlob(db, "Synthetic key boundary")
      const cache = new FrameReadCache()
      sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 1)
      expect(readBlobContent(db, masterKey, id, cache)).toBe("Synthetic key boundary")
      expect(() => readBlobContent(db, Buffer.alloc(32, 0x52), id, cache)).toThrow()
      expect(cache.byteLength).toBe(0)
    })
  })

  test("Given frames with different IDs, when sealed content is swapped, then frame AAD rejects the read", () => {
    withLedger((db) => {
      for (let index = 0; index <= FRAME_MAX_MEMBERS; index++) {
        insertBlob(db, `Synthetic AAD member ${index}`)
      }
      sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 1)
      const [first, second] = frames(db)
      if (!first || !second) throw new Error("Synthetic AAD frames missing")
      db.query("UPDATE context_awareness_frames SET content = ? WHERE id = ?").run(
        second.content,
        first.id,
      )
      const member = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM context_awareness_blobs WHERE frame_id = ? LIMIT 1",
        )
        .get(first.id)
      if (!member) throw new Error("Synthetic AAD member missing")
      expect(() => readBlobContent(db, masterKey, member.id)).toThrow()
    })
  })

  test("Given a blob that exceeds four MiB after its offset table, when sealing, then it stays individually encrypted", () => {
    withLedger((db) => {
      const oversized = "x".repeat(FRAME_MAX_RAW_BYTES - 2 * Uint32Array.BYTES_PER_ELEMENT + 1)
      const largeId = insertBlob(db, oversized)
      const smallId = insertBlob(db, "Synthetic small neighbor")
      expect(sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 1)).toBe(1)
      expect(readBlobContent(db, masterKey, largeId)).toBe(oversized)
      expect(readBlobContent(db, masterKey, smallId)).toBe("Synthetic small neighbor")
      expect(
        db
          .query<{ frame_id: string | null }, [string]>(
            "SELECT frame_id FROM context_awareness_blobs WHERE id = ?",
          )
          .get(largeId)?.frame_id,
      ).toBeNull()
    })
  })

  test("Given a sparse sealed frame, when compacting, then live member offsets and AAD still read exactly", () => {
    withLedger((db) => {
      const [firstId, secondId, thirdId] = [
        insertBlob(db, "Synthetic alpha"),
        insertBlob(db, "Synthetic beta"),
        insertBlob(db, "Synthetic gamma"),
      ]
      if (!firstId || !secondId || !thirdId) throw new Error("Synthetic member IDs missing")
      expect(sealColdBlobs(db, masterKey, start + FRAME_COLD_AGE_MS + 1)).toBe(3)
      const oldFrameId = frames(db)[0]?.id
      if (!oldFrameId) throw new Error("Synthetic frame missing")
      db.query("DELETE FROM context_awareness_blobs WHERE id IN (?, ?)").run(firstId, secondId)
      const compacted = db.transaction(() =>
        compactFrame(db, masterKey, oldFrameId, start + FRAME_COLD_AGE_MS + 2),
      )()
      expect(compacted).toBe(true)
      const remaining = db
        .query<{ frame_id: string; frame_index: number }, [string]>(
          "SELECT frame_id, frame_index FROM context_awareness_blobs WHERE id = ?",
        )
        .get(thirdId)
      expect(remaining?.frame_id).not.toBe(oldFrameId)
      expect(remaining?.frame_index).toBe(0)
      expect(readBlobContent(db, masterKey, thirdId)).toBe("Synthetic gamma")
      expect(frames(db)).toHaveLength(1)
      db.query("DELETE FROM context_awareness_blobs WHERE id = ?").run(thirdId)
      const emptied = db.transaction(() =>
        compactFrame(db, masterKey, remaining?.frame_id ?? "", start + FRAME_COLD_AGE_MS + 3),
      )()
      expect(emptied).toBe(true)
      expect(frames(db)).toHaveLength(0)
    })
  })
})
