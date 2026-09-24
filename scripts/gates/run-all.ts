type GateStatus = "PASS" | "FAIL" | "BLOCKED"

export type CommandEvidence = {
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly durationMs: number
  readonly error?: string
}

export type GateResult = {
  readonly id: string
  readonly status: GateStatus
  readonly commands: readonly CommandEvidence[]
  readonly remaining?: string
}

export type ReleaseResult = {
  readonly status: GateStatus
  readonly gates: readonly GateResult[]
}

type CommandRunner = (argv: readonly string[]) => Promise<{
  readonly exitCode: number
  readonly durationMs: number
}>

type GatePlan = {
  readonly id: string
  readonly commands: readonly (readonly string[])[]
  readonly remaining?: string
}

const test = (...files: string[]): readonly string[] => ["bun", "test", ...files]

// All inputs are repository tests with synthetic fixtures. No user data root or credential path is accepted.
const GATES: readonly GatePlan[] = [
  {
    id: "G0",
    commands: [
      ["npx", "tsc", "--noEmit"],
      ["npx", "biome", "check", "."],
      test(),
      ["swift", "build", "-c", "release", "--package-path", "apps/side-mac"],
    ],
  },
  {
    id: "G1",
    commands: [
      test(
        "tests/gates/g1-canary.test.ts",
        "tests/redact.test.ts",
        "tests/integration/phase1.test.ts",
      ),
    ],
    remaining:
      "Run fixed canaries through an isolated Side capture, then scan its ledger/index/memory/log bytes.",
  },
  {
    id: "G2",
    commands: [test("tests/policy.test.ts", "tests/integration/phase1.test.ts")],
    remaining:
      "Use blocked app and domain for 10 minutes on a permitted test Mac; verify zero events and positive suppressions.",
  },
  {
    id: "G3",
    commands: [test("tests/ledger/delete.test.ts", "tests/memory/render.test.ts")],
  },
  {
    id: "G4",
    commands: [
      test("tests/comprehension/contract.test.ts", "tests/comprehension/providers.test.ts"),
    ],
  },
  { id: "G5", commands: [test("tests/constants.test.ts")] },
  { id: "G6", commands: [test("tests/ledger/schema.test.ts")] },
  {
    id: "G7",
    commands: [test("tests/comprehension/neutralize.test.ts")],
    remaining:
      "The ten-fixture provider response gate needs authorized synthetic provider credentials; the live credential-reading script is excluded.",
  },
  { id: "G7b", commands: [test("tests/api/evidence.test.ts", "tests/mcp/server.test.ts")] },
  { id: "G8", commands: [test("tests/ledger/gc.test.ts")] },
  { id: "G9", commands: [test("tests/config.test.ts", "tests/api/server.test.ts")] },
  { id: "G10", commands: [test("tests/api/server.test.ts")] },
  { id: "G11", commands: [test("tests/comprehension/providers.test.ts")] },
]

export async function runReleaseGates(run: CommandRunner): Promise<ReleaseResult> {
  const gates: GateResult[] = []
  for (const gate of GATES) {
    const commands: CommandEvidence[] = []
    for (const argv of gate.commands) {
      try {
        const result = await run(argv)
        commands.push({ argv, ...result })
      } catch {
        commands.push({ argv, exitCode: null, durationMs: 0, error: "command failed to start" })
      }
    }
    const failed = commands.some((command) => command.exitCode !== 0)
    gates.push({
      id: gate.id,
      status: failed ? "FAIL" : gate.remaining ? "BLOCKED" : "PASS",
      commands,
      ...(gate.remaining ? { remaining: gate.remaining } : {}),
    })
  }
  return {
    status: gates.some((gate) => gate.status === "FAIL")
      ? "FAIL"
      : gates.some((gate) => gate.status === "BLOCKED")
        ? "BLOCKED"
        : "PASS",
    gates,
  }
}

async function execute(argv: readonly string[]): Promise<{ exitCode: number; durationMs: number }> {
  const started = performance.now()
  const child = Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" })
  const exitCode = await child.exited
  return { exitCode, durationMs: Math.round(performance.now() - started) }
}

if (import.meta.main) {
  const result = await runReleaseGates(execute)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2
}
