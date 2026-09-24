import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

let configuredPath: string | null = null

export function bundledResourcePath(executablePath: string, ...parts: readonly string[]): string {
  return join(dirname(executablePath), ...parts)
}

export function configureSqlite(): string {
  if (configuredPath !== null) return configuredPath
  const bundled = bundledResourcePath(process.execPath, "lib", "libsqlite3.dylib")
  const candidates = [
    bundled,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]
  const path = candidates.find(existsSync)
  if (!path) throw new Error("Custom SQLite library is missing; run side doctor")
  Database.setCustomSQLite(path)
  configuredPath = path
  return path
}
