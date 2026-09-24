import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanG1Canaries } from "../../scripts/gates/g1-canary"

const canaries = [
  "AKIAABCDEFGHIJKLMNOP",
  "eyJabcdefgh.abcdefgh.abcdefgh",
  "4111111111111111",
  "password: hunter2",
  "900101-1234567",
] as const

const script = join(import.meta.dir, "..", "..", "scripts", "gates", "g1-canary.ts")

async function writeLedger(root: string, contents: string | Buffer): Promise<void> {
  const directory = join(root, "context-awareness")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "ledger.db"), contents)
}

async function runCli(root: string) {
  const child = Bun.spawn([process.execPath, script, root], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

test("Given fixed canaries in selected binary and nested files, when scanned, then every occurrence is counted", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await mkdir(join(root, "memory", "2026", "09"), { recursive: true })
    await mkdir(join(root, "logs", "daemon"), { recursive: true })
    await writeLedger(
      root,
      Buffer.concat([
        Buffer.alloc(65_535, 0),
        Buffer.from(canaries[0]),
        Buffer.from([0xff, 0x00]),
        Buffer.from(canaries[0]),
      ]),
    )
    await writeFile(join(root, "context-awareness", "ledger.db-wal"), canaries[1])
    await writeFile(join(root, "context-awareness", "ledger.db-shm"), canaries[2])
    await writeFile(join(root, "index.db"), canaries[3])
    await writeFile(join(root, "index.db-wal"), canaries[4])
    await writeFile(join(root, "index.db-shm"), canaries[0])
    await writeFile(join(root, "memory", "2026", "09", "day.md"), canaries[1])
    await writeFile(join(root, "logs", "daemon", "side.log"), canaries[2])

    const result = await scanG1Canaries(root)

    expect(result.totalMatches).toBe(9)
    expect(Object.fromEntries(result.files.map((file) => [file.path, file.matches]))).toEqual({
      "context-awareness/ledger.db": 2,
      "context-awareness/ledger.db-wal": 1,
      "context-awareness/ledger.db-shm": 1,
      "index.db": 1,
      "index.db-wal": 1,
      "index.db-shm": 1,
      "memory/2026/09/day.md": 1,
      "logs/daemon/side.log": 1,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given similar bytes and an out-of-scope file, when scanned, then no canary is reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await writeLedger(
      root,
      [
        "AKIAABCDEFGHIJKLMNOQ",
        "eyJabcdefgh.abcdefgh.abcdefgi",
        "4111111111111112",
        "password: hunter3",
        "900101-1234568",
      ].join("\n"),
    )
    await writeFile(join(root, "unrelated.txt"), canaries.join("\n"))

    const result = await scanG1Canaries(root)

    expect(result.totalMatches).toBe(0)
    expect(result.files).toEqual([{ path: "context-awareness/ledger.db", matches: 0 }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a missing root or ledger, when scanned, then the gate fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await expect(scanG1Canaries(join(root, "missing"))).rejects.toThrow()
    await writeFile(join(root, "ledger.db"), canaries[0])
    await expect(scanG1Canaries(root)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a symlink in a scanned tree, when scanned, then the gate fails without following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  const outside = await mkdtemp(join(tmpdir(), "side-g1-outside-"))
  try {
    await writeLedger(root, "clean")
    await mkdir(join(root, "memory"))
    await writeFile(join(outside, "secret.txt"), canaries[0])
    await symlink(join(outside, "secret.txt"), join(root, "memory", "linked.txt"))

    await expect(scanG1Canaries(root)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("Given a root named .aside, when scanned, then it is rejected before reading data", async () => {
  const parent = await mkdtemp(join(tmpdir(), "side-g1-"))
  const root = join(parent, ".aside")
  try {
    await mkdir(root)
    await writeLedger(root, canaries[0])

    await expect(scanG1Canaries(root)).rejects.toThrow()
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("Given a canary in the ledger, when the CLI runs, then it fails and prints paths and counts only", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await writeLedger(root, canaries[0])

    const result = await runCli(root)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("context-awareness/ledger.db\t1\n")
    expect(result.stderr).toBe("")
    for (const canary of canaries) expect(result.stdout + result.stderr).not.toContain(canary)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a clean ledger, when the CLI runs, then it reports zero and exits successfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await writeLedger(root, Buffer.from([0x00, 0xff]))

    const result = await runCli(root)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("context-awareness/ledger.db\t0\n")
    expect(result.stderr).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a canary in a filename, when the CLI runs, then its output does not reveal it", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-g1-"))
  try {
    await writeLedger(root, "clean")
    await mkdir(join(root, "memory"))
    await writeFile(join(root, "memory", `${canaries[0]}.txt`), canaries[1])

    const result = await runCli(root)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("memory/[redacted].txt\t1\n")
    for (const canary of canaries) expect(result.stdout + result.stderr).not.toContain(canary)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
