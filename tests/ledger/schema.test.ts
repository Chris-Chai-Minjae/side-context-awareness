import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LedgerSchemaVersionError, openLedger } from "../../src/ledger/schema"

const asideDdl = readFileSync(new URL("../fixtures/aside-ledger-ddl.sql", import.meta.url), "utf8")

type SchemaRow = {
  readonly type: string
  readonly name: string
  readonly sql: string
}

function asideSchema(db: Database): readonly SchemaRow[] {
  return db
    .query<SchemaRow, []>(`
      SELECT type, name, sql FROM sqlite_master
      WHERE (type = 'table' AND name LIKE 'context_awareness_%')
         OR (type = 'index' AND name LIKE 'idx_context_awareness_%')
      ORDER BY type, name
    `)
    .all()
    .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }))
}

function withScratchPath(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-ledger-schema-"))
  try {
    run(join(directory, "ledger.db"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("ledger schema", () => {
  test("Given an empty ledger, when opened, then the Aside tables and indexes match the measured DDL", () => {
    withScratchPath((path) => {
      const expectedDb = new Database(":memory:")
      expectedDb.exec(asideDdl)
      const expected = asideSchema(expectedDb)
      expectedDb.close()

      const db = openLedger(path)
      try {
        const actual = asideSchema(db)
        expect(actual.filter((row) => row.type === "table")).toHaveLength(4)
        expect(actual.filter((row) => row.type === "index")).toHaveLength(13)
        expect(actual).toEqual(expected)
      } finally {
        db.close()
      }
    })
  })

  test("Given a new ledger, when opened, then side tables and connection PRAGMAs are ready", () => {
    withScratchPath((path) => {
      const db = openLedger(path)
      try {
        const sideTables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'side_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name)
        expect(sideTables).toEqual([
          "side_day_counters",
          "side_meta",
          "side_suppressions",
          "side_terms",
        ])
        expect(
          db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
        ).toBe("wal")
        expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(
          1,
        )
        expect(
          db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
        ).toBe(1)
        expect(
          db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete,
        ).toBe(1)
        expect(db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(
          2,
        )
        expect(
          db
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'schema_version'",
            )
            .get()?.value,
        ).toBe("1")
      } finally {
        db.close()
      }
    })
  })

  test("Given an event with a side term, when the event is deleted, then the term cascades", () => {
    withScratchPath((path) => {
      const db = openLedger(path)
      try {
        db.query(
          "INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload) VALUES ('synthetic-event', 0, 'test', 'window', '{}')",
        ).run()
        db.query(
          "INSERT INTO side_terms (term_hash, event_id) VALUES ('synthetic-term', 'synthetic-event')",
        ).run()
        db.query("DELETE FROM context_awareness_events WHERE id = 'synthetic-event'").run()
        expect(
          db.query<{ count: number }, []>("SELECT count(*) AS count FROM side_terms").get()?.count,
        ).toBe(0)
      } finally {
        db.close()
      }
    })
  })

  test("Given a migrated ledger, when reopened, then migration keeps existing metadata", () => {
    withScratchPath((path) => {
      const first = openLedger(path)
      first.query("INSERT INTO side_meta (key, value) VALUES ('account_generation', '7')").run()
      first.close()

      const reopened = openLedger(path)
      try {
        expect(
          reopened
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'schema_version'",
            )
            .get()?.value,
        ).toBe("1")
        expect(
          reopened
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'account_generation'",
            )
            .get()?.value,
        ).toBe("7")
      } finally {
        reopened.close()
      }
    })
  })

  test("Given a newer schema version, when opened, then migration rejects it", () => {
    withScratchPath((path) => {
      const first = openLedger(path)
      first.query("UPDATE side_meta SET value = '2' WHERE key = 'schema_version'").run()
      first.close()

      expect(() => openLedger(path)).toThrow(LedgerSchemaVersionError)
    })
  })
})
