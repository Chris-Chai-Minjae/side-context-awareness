import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppToDaemonMessageSchema } from "../../src/contracts/protocol"

test("Given a scenario file and commands, when the fake helper runs over stdio, then JSON-lines replay and correlate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "side-fake-helper-"))
  const scenario = join(directory, "scenario.jsonl")
  await writeFile(
    scenario,
    [
      JSON.stringify({ kind: "window.changed", source: "mac_ax", occurredAt: 1 }),
      JSON.stringify({ kind: "selection.changed", source: "mac_ax", occurredAt: 2 }),
    ].join("\n"),
  )
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "mocks", "fake-helper.ts"), scenario],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      },
    )
    child.stdin.write(`${JSON.stringify({ type: "command", id: "h1", name: "health" })}\n`)
    child.stdin.end()
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    const frames = output
      .trim()
      .split("\n")
      .map((line) => AppToDaemonMessageSchema.parse(JSON.parse(line)))
    expect(frames.map((frame) => frame.type)).toEqual([
      "hello",
      "health",
      "event",
      "event",
      "result",
    ])
    expect(frames[2]).toMatchObject({
      type: "event",
      event: { kind: "window.changed", occurredAt: 1 },
    })
    expect(frames[4]).toMatchObject({ type: "result", id: "h1", ok: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
