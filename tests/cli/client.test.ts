import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callDaemon, DaemonUnavailableError } from "../../src/cli/client"

test("Given a daemon UDS, the CLI sends JSON-RPC and validates its response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-uds-"))
  const socketPath = join(directory, "daemon.sock")
  let observed: unknown
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      observed = await request.json()
      return Response.json({
        jsonrpc: "2.0",
        id: (observed as { id: string }).id,
        result: null,
      })
    },
  })
  try {
    const value = await callDaemon("resume", undefined, { socketPath })
    expect(observed).toMatchObject({ jsonrpc: "2.0", method: "resume" })
    expect(value).toBeNull()
  } finally {
    await server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a stopped daemon, CLI commands return the approved availability message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-down-"))
  try {
    await expect(
      callDaemon("status", undefined, { socketPath: join(directory, "missing.sock") }),
    ).rejects.toThrow(DaemonUnavailableError)
    await expect(
      callDaemon("status", undefined, { socketPath: join(directory, "missing.sock") }),
    ).rejects.toThrow("Side is not running. Open Side.app.")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given malformed daemon output, CLI rejects it rather than displaying unchecked fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-bad-"))
  const socketPath = join(directory, "daemon.sock")
  const server = Bun.serve({
    unix: socketPath,
    fetch() {
      return Response.json({ jsonrpc: "2.0", id: "wrong", result: { secret: "synthetic" } })
    },
  })
  try {
    await expect(callDaemon("status", undefined, { socketPath })).rejects.toThrow()
  } finally {
    await server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
})
