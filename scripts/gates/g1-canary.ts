import { constants } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"

const CANARIES = [
  "AKIAABCDEFGHIJKLMNOP",
  "eyJabcdefgh.abcdefgh.abcdefgh",
  "4111111111111111",
  "password: hunter2",
  "900101-1234567",
] as const

const CANARY_BYTES = CANARIES.map((canary) => Buffer.from(canary, "utf8"))
const LEDGER_FILE_NAMES = new Set<string>(["ledger.db", "ledger.db-wal", "ledger.db-shm"])
const INDEX_FILE_NAMES = new Set<string>(["index.db", "index.db-wal", "index.db-shm"])

type ScanResult = {
  readonly files: readonly { readonly path: string; readonly matches: number }[]
  readonly totalMatches: number
}

type ScanErrorKind = "aside-root" | "invalid-root" | "missing-ledger" | "invalid-entry"

const ERROR_MESSAGES = {
  "aside-root": "Aside data roots are not allowed",
  "invalid-root": "Side data root is not a directory",
  "missing-ledger": "ledger.db is missing or not a regular file",
  "invalid-entry": "Scanned entry is not a regular file or directory",
} as const

class G1ScanError extends Error {
  constructor(readonly kind: ScanErrorKind) {
    super(ERROR_MESSAGES[kind])
  }
}

function isAsidePath(path: string): boolean {
  return path.split(sep).includes(".aside")
}

async function collectFiles(root: string): Promise<string[]> {
  const rootEntries = await readdir(root, { withFileTypes: true })
  if (!rootEntries.some((entry) => entry.name === "context-awareness" && entry.isDirectory())) {
    throw new G1ScanError("missing-ledger")
  }
  const ledgerDirectory = join(root, "context-awareness")
  const ledgerEntries = await readdir(ledgerDirectory, { withFileTypes: true })
  if (!ledgerEntries.some((entry) => entry.name === "ledger.db" && entry.isFile())) {
    throw new G1ScanError("missing-ledger")
  }

  const files: string[] = []
  const directories: string[] = []
  for (const entry of ledgerEntries) {
    if (!LEDGER_FILE_NAMES.has(entry.name)) continue
    if (!entry.isFile()) throw new G1ScanError("invalid-entry")
    files.push(join(ledgerDirectory, entry.name))
  }
  for (const entry of rootEntries) {
    if (INDEX_FILE_NAMES.has(entry.name)) {
      if (!entry.isFile()) throw new G1ScanError("invalid-entry")
      files.push(join(root, entry.name))
    } else if (entry.name === "memory" || entry.name === "logs") {
      if (!entry.isDirectory()) throw new G1ScanError("invalid-entry")
      directories.push(join(root, entry.name))
    }
  }

  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) files.push(path)
      else throw new G1ScanError("invalid-entry")
    }
  }
  return files.sort()
}

async function countFileMatches(path: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new G1ScanError("invalid-entry")
    const tails: Buffer[] = CANARY_BYTES.map(() => Buffer.alloc(0))
    let matches = 0
    for await (const part of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
      for (const [index, needle] of CANARY_BYTES.entries()) {
        const bytes = Buffer.concat([tails[index] ?? Buffer.alloc(0), chunk])
        let offset = 0
        while (true) {
          const found = bytes.indexOf(needle, offset)
          if (found < 0) break
          matches += 1
          offset = found + 1
        }
        tails[index] = bytes.subarray(Math.max(0, bytes.length - needle.length + 1))
      }
    }
    return matches
  } finally {
    await handle.close()
  }
}

export async function scanG1Canaries(dataRoot: string): Promise<ScanResult> {
  const requestedRoot = resolve(dataRoot)
  if (isAsidePath(requestedRoot)) throw new G1ScanError("aside-root")
  const root = await realpath(requestedRoot)
  if (isAsidePath(root)) throw new G1ScanError("aside-root")
  if (!(await stat(root)).isDirectory()) throw new G1ScanError("invalid-root")

  const files = await collectFiles(root)
  const results: { path: string; matches: number }[] = []
  let totalMatches = 0
  for (const file of files) {
    const matches = await countFileMatches(file)
    results.push({ path: relative(root, file), matches })
    totalMatches += matches
  }
  return { files: results, totalMatches }
}

function printablePath(path: string): string {
  let printable = path.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")
  for (const canary of CANARIES) printable = printable.replaceAll(canary, "[redacted]")
  return printable
}

async function main(): Promise<void> {
  const args = z.tuple([z.string().min(1)]).safeParse(process.argv.slice(2))
  if (!args.success) {
    process.stderr.write("Usage: bun run scripts/gates/g1-canary.ts <side-data-root>\n")
    process.exitCode = 2
    return
  }
  try {
    const result = await scanG1Canaries(args.data[0])
    for (const file of result.files) {
      process.stdout.write(`${printablePath(file.path)}\t${file.matches}\n`)
    }
    if (result.totalMatches > 0) process.exitCode = 1
  } catch (error) {
    if (error instanceof G1ScanError) process.stderr.write(`${error.message}\n`)
    else process.stderr.write("G1 scan failed\n")
    process.exitCode = 2
  }
}

if (import.meta.main) await main()
