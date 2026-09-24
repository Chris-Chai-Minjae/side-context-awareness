import { expect, test } from "bun:test"
import { runReleaseGates } from "../../scripts/gates/run-all"

test("Given all synthetic checks pass, when gates run, then physical and provider gates remain blocked", async () => {
  const commands: string[] = []
  const result = await runReleaseGates(async (argv) => {
    commands.push(argv.join(" "))
    return { exitCode: 0, durationMs: 1 }
  })

  expect(result.status).toBe("BLOCKED")
  expect(result.gates.map((gate) => gate.id)).toEqual([
    "G0",
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
    "G6",
    "G7",
    "G7b",
    "G8",
    "G9",
    "G10",
    "G11",
  ])
  expect(result.gates.filter((gate) => gate.status === "BLOCKED").map((gate) => gate.id)).toEqual([
    "G1",
    "G2",
    "G7",
  ])
  expect(result.gates.find((gate) => gate.id === "G0")?.commands).toHaveLength(4)
  expect(commands).not.toContain("bun run scripts/gates/g7-injection.ts")
  expect(
    commands.every((command) => !command.includes(".aside") && !command.includes("g1-canary.ts")),
  ).toBe(true)
})

test("Given one failed command, when gates run, then its gate and the release fail", async () => {
  const result = await runReleaseGates(async (argv) => ({
    exitCode: argv.includes("tests/ledger/delete.test.ts") ? 1 : 0,
    durationMs: 1,
  }))

  expect(result.status).toBe("FAIL")
  expect(result.gates.find((gate) => gate.id === "G3")?.status).toBe("FAIL")
  expect(result.gates.find((gate) => gate.id === "G7")?.status).toBe("BLOCKED")
})

test("Given a missing tool, when a command cannot start, then the gate fails with bounded evidence", async () => {
  const result = await runReleaseGates(async (argv) => {
    if (argv[0] === "swift") throw new Error("tool unavailable")
    return { exitCode: 0, durationMs: 1 }
  })

  const gate = result.gates.find((item) => item.id === "G0")
  expect(gate?.status).toBe("FAIL")
  expect(gate?.commands.at(-1)?.exitCode).toBeNull()
  expect(gate?.commands.at(-1)?.error).toBe("command failed to start")
})
