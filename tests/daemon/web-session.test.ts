import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { runDaemon } from "../../src/daemon/index"
import { hello } from "../helper/fixture"

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for synthetic web session")
}

test("web.session follows listener and hello, is acknowledged once, and never writes the raw token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-web-session-"))
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: ReturnType<typeof DaemonToAppMessageSchema.parse>[] = []
  createInterface({ input: output }).on("line", (line) => {
    const frame = DaemonToAppMessageSchema.parse(JSON.parse(line))
    commands.push(frame)
    if (frame.type === "command")
      input.write(`${JSON.stringify({ type: "result", id: frame.id, ok: true, data: null })}\n`)
  })
  try {
    const running = runDaemon({ directory, input, output })
    await waitFor(() => existsSync(join(directory, "run", "web.json")))
    expect(commands.some((frame) => frame.type === "command" && frame.name === "web.session")).toBe(
      false,
    )
    input.write(`${JSON.stringify(hello)}\n`)
    await waitFor(() =>
      commands.some((frame) => frame.type === "command" && frame.name === "web.session"),
    )
    const sessions = commands.filter(
      (frame) => frame.type === "command" && frame.name === "web.session",
    )
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    if (session?.type !== "command" || session.name !== "web.session") throw new Error("No session")
    const publication = readFileSync(join(directory, "run", "web.json"), "utf8")
    expect(JSON.parse(publication)).toEqual({
      port: session.args.port,
      tokenHash: createHash("sha256").update(session.args.token).digest("hex"),
    })
    expect(publication).not.toContain(session.args.token)
    input.end()
    await running
  } finally {
    input.destroy()
    output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("web.session rejection prevents daemon startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-web-session-reject-"))
  const input = new PassThrough()
  const output = new PassThrough()
  createInterface({ input: output }).on("line", (line) => {
    const frame = DaemonToAppMessageSchema.parse(JSON.parse(line))
    if (frame.type === "command")
      input.write(
        `${JSON.stringify({ type: "result", id: frame.id, ok: false, error: "rejected" })}\n`,
      )
  })
  try {
    const running = runDaemon({ directory, input, output })
    input.write(`${JSON.stringify(hello)}\n`)
    await expect(running).rejects.toThrow()
    expect(existsSync(join(directory, "run", "web.json"))).toBe(false)
  } finally {
    input.destroy()
    output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})
