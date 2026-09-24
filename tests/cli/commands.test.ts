import { expect, test } from "bun:test"
import { runClientCommand } from "../../src/cli/commands"
import { PAUSE_15_MINUTES_MS, PAUSE_INDEFINITE } from "../../src/constants"

function fixture() {
  const calls: { method: string; params: unknown }[] = []
  const output: string[] = []
  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params })
    return method === "status" ? { enabled: true, state: "running", today: { events: 3 } } : []
  }
  return { calls, output, rpc, write: (line: string) => output.push(line) }
}

test("Given status and search flags, the CLI maps them to UDS RPC and safe output", async () => {
  const cli = fixture()
  await runClientCommand(["status", "--json"], cli)
  await runClientCommand(
    [
      "search",
      "synthetic",
      "sqlite",
      "--from",
      "2026-09-23T00:00:00Z",
      "--app",
      "Browser",
      "--limit",
      "5",
    ],
    cli,
  )
  expect(cli.calls).toEqual([
    { method: "status", params: undefined },
    {
      method: "search",
      params: {
        queries: ["synthetic sqlite"],
        from: "2026-09-23T00:00:00Z",
        app: "Browser",
        limit: 5,
      },
    },
  ])
  expect(cli.output[0]).toBe('{"enabled":true,"state":"running","today":{"events":3}}')
})

test("Given read, memory, pause, resume and digest, the CLI uses only approved RPC methods", async () => {
  const cli = fixture()
  await runClientCommand(
    ["read", `e:${"0".repeat(26)}`, "--match", "synthetic", "--context", "4"],
    cli,
  )
  await runClientCommand(["memory", "synthetic", "task"], cli)
  await runClientCommand(["pause", "15m"], cli)
  await runClientCommand(["pause", "forever"], cli)
  await runClientCommand(["resume"], cli)
  await runClientCommand(["digest", "--day", "2026-09-24"], cli)
  expect(cli.calls).toEqual([
    {
      method: "read",
      params: { id: `e:${"0".repeat(26)}`, match: "synthetic", contextLines: 4 },
    },
    { method: "memorySearch", params: { query: "synthetic task" } },
    { method: "pause", params: { durationMs: PAUSE_15_MINUTES_MS } },
    { method: "pause", params: { until: PAUSE_INDEFINITE } },
    { method: "resume", params: undefined },
    { method: "digest", params: { day: "2026-09-24" } },
  ])
})

test("Given clear all without --yes, the CLI requires confirmation before deleting", async () => {
  const cli = fixture()
  let asked = 0
  const denied = await runClientCommand(["clear", "all"], {
    ...cli,
    confirmClearAll: async () => {
      asked++
      return false
    },
  })
  expect(denied).toBe(1)
  expect(asked).toBe(1)
  expect(cli.calls).toEqual([])
  await runClientCommand(["clear", "all", "--yes"], cli)
  expect(cli.calls).toEqual([{ method: "clear", params: { target: "all" } }])
})

test("Given invalid or missing CLI arguments, no RPC request is sent", async () => {
  const cli = fixture()
  await expect(runClientCommand(["search", "--limit", "oops"], cli)).rejects.toThrow()
  await expect(runClientCommand(["clear", "unknown"], cli)).rejects.toThrow()
  await expect(runClientCommand(["read"], cli)).rejects.toThrow()
  expect(cli.calls).toEqual([])
})
