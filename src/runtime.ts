import { Database } from "bun:sqlite"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { dataDirectory, loadConfig } from "./config"
import { loadEncryptionKey } from "./observe"
import { ContextStore } from "./store"

export async function openRuntime(): Promise<{
  store: ContextStore
  db: Database
  directory: string
}> {
  const directory = dataDirectory()
  await loadConfig(directory)
  const key = await loadEncryptionKey()
  const filename = join(directory, "context.sqlite")
  const db = new Database(filename, { create: true })
  await chmod(filename, 0o600)
  db.exec("PRAGMA journal_mode=WAL")
  return { store: new ContextStore(db, key), db, directory }
}
