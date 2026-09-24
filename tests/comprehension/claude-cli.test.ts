import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Briefing } from "../../src/comprehension/briefing"
import {
  EvidencePermissionRevokedError,
  summarizeBriefing,
} from "../../src/comprehension/providers"
import { SettingsSchema } from "../../src/contracts/settings"

const ref = `e:${"0".repeat(26)}`
const briefing: Briefing = {
  text: `Synthetic page ${ref}`,
  evidenceIds: new Set([ref]),
  apps: new Set(["Example"]),
  domains: new Set(["example.invalid"]),
}
const valid = {
  title: "Synthetic activity",
  description: ["Reviewed a synthetic page."],
  memorySummary: "A synthetic page was reviewed.",
  apps: ["Example"],
  domains: ["example.invalid"],
  citations: [{ ref }],
  sourceIds: [ref],
}

const stub = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const mode = process.env.SIDE_CLAUDE_STUB_MODE
const trace = process.env.SIDE_CLAUDE_STUB_TRACE
if (args[0] === "auth") {
  appendFileSync(trace, JSON.stringify({ kind: "auth", args, apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY), user: process.env.USER, logname: process.env.LOGNAME }) + "\\n")
  process.stdout.write(JSON.stringify({ loggedIn: mode !== "unauth", email: "private@example.invalid" }))
  process.exit(mode === "unauth" ? 1 : 0)
}
const input = readFileSync(0, "utf8")
appendFileSync(trace, JSON.stringify({ kind: "summary", args, input, pid: process.pid, apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY), user: process.env.USER, logname: process.env.LOGNAME }) + "\\n")
if (mode === "hang") {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, structured_output: JSON.parse(process.env.SIDE_CLAUDE_STUB_RESULT) }))
  writeFileSync(process.env.SIDE_CLAUDE_STUB_STARTED, "started")
  await new Promise(() => {})
}
if (mode === "overflow") {
  process.stdout.write("x".repeat(2_000_000))
  process.exit(0)
}
let output = JSON.parse(process.env.SIDE_CLAUDE_STUB_RESULT)
if (mode === "invalid-first") {
  const countPath = process.env.SIDE_CLAUDE_STUB_COUNT
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0
  writeFileSync(countPath, String(count + 1))
  if (count === 0) output = { ...output, sourceIds: ["e:11111111111111111111111111"] }
}
process.stdout.write(JSON.stringify({ type: "result", is_error: false, structured_output: output, usage: { input_tokens: 7, output_tokens: 3 } }))
`

async function withStub<T>(
  mode: string,
  run: (paths: { trace: string; started: string }) => Promise<T>,
  packagedParent = false,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "side-claude-test-"))
  const home = join(directory, "home")
  const executable = packagedParent
    ? join(home, ".local", "bin", "claude")
    : join(directory, "claude")
  const trace = join(directory, "trace.jsonl")
  const started = join(directory, "started")
  if (packagedParent) mkdirSync(join(home, ".local", "bin"), { recursive: true })
  writeFileSync(executable, stub.replace("#!/usr/bin/env bun", `#!${process.execPath}`))
  chmodSync(executable, 0o700)
  const original = {
    path: process.env["PATH"],
    home: process.env["HOME"],
    mode: process.env["SIDE_CLAUDE_STUB_MODE"],
    trace: process.env["SIDE_CLAUDE_STUB_TRACE"],
    result: process.env["SIDE_CLAUDE_STUB_RESULT"],
    count: process.env["SIDE_CLAUDE_STUB_COUNT"],
    started: process.env["SIDE_CLAUDE_STUB_STARTED"],
    apiKey: process.env["ANTHROPIC_API_KEY"],
    user: process.env["USER"],
    logname: process.env["LOGNAME"],
  }
  process.env["PATH"] = packagedParent
    ? "/usr/bin:/bin:/usr/sbin:/sbin"
    : `${directory}:${original.path ?? ""}`
  if (packagedParent) {
    process.env["HOME"] = home
    process.env["USER"] = "synthetic-account"
    process.env["LOGNAME"] = "synthetic-account"
  }
  process.env["SIDE_CLAUDE_STUB_MODE"] = mode
  process.env["SIDE_CLAUDE_STUB_TRACE"] = trace
  process.env["SIDE_CLAUDE_STUB_RESULT"] = JSON.stringify(valid)
  process.env["SIDE_CLAUDE_STUB_COUNT"] = join(directory, "count")
  process.env["SIDE_CLAUDE_STUB_STARTED"] = started
  process.env["ANTHROPIC_API_KEY"] = "synthetic-key-must-not-be-used"
  try {
    return await run({ trace, started })
  } finally {
    for (const [name, value] of Object.entries({
      PATH: original.path,
      HOME: original.home,
      SIDE_CLAUDE_STUB_MODE: original.mode,
      SIDE_CLAUDE_STUB_TRACE: original.trace,
      SIDE_CLAUDE_STUB_RESULT: original.result,
      SIDE_CLAUDE_STUB_COUNT: original.count,
      SIDE_CLAUDE_STUB_STARTED: original.started,
      ANTHROPIC_API_KEY: original.apiKey,
      USER: original.user,
      LOGNAME: original.logname,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test("Given a packaged daemon PATH, when Claude is installed in HOME/.local/bin, then summary launches that executable", async () => {
  await withStub(
    "ok",
    async ({ trace }) => {
      const result = await summarizeBriefing({ settings: settings(true), briefing })
      expect(result.state).toBe("done")
      const rows = traceRows(trace)
      expect(rows.map((row) => row.kind)).toEqual(["auth", "summary"])
      expect(rows.map((row) => [row.user, row.logname])).toEqual([
        ["synthetic-account", "synthetic-account"],
        ["synthetic-account", "synthetic-account"],
      ])
    },
    true,
  )
})

function settings(allowEvidence: boolean, withFallback = false) {
  return SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      enabled: true,
      summaryModel: { provider: "claude", modelId: "claude-sonnet-4-6" },
    },
    providers: [
      { id: "claude", kind: "claude-code-cli", models: ["claude-sonnet-4-6"], allowEvidence },
      ...(withFallback
        ? [
            {
              id: "http",
              baseUrl: "http://127.0.0.1:1/v1",
              models: ["fallback"],
              allowEvidence: true,
            },
          ]
        : []),
    ],
  })
}

function traceRows(path: string): {
  kind: string
  args: string[]
  input?: string
  apiKeyPresent?: boolean
  user?: string
  logname?: string
}[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("Given consent and a synthetic CLI, when summarizing, then fixed safe flags and stdin produce a validated summary", async () => {
  await withStub("ok", async ({ trace }) => {
    const logs: unknown[] = []
    const result = await summarizeBriefing({
      settings: settings(true),
      briefing,
      log: (entry) => logs.push(entry),
    })
    expect(result.state).toBe("done")
    if (result.state !== "done") return
    expect(result.model).toBe("claude/claude-sonnet-4-6")
    expect(result.summary.citations).toEqual([{ ref }])
    expect([result.inputTokens, result.outputTokens]).toEqual([7, 3])
    const rows = traceRows(trace)
    expect(rows.map((row) => row.kind)).toEqual(["auth", "summary"])
    const args = rows[1]?.args ?? []
    expect(args).toContain("-p")
    for (const flag of [
      "--restricted",
      "--safe-mode",
      "--tools",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "--json-schema",
      "--model",
    ])
      expect(args).toContain(flag)
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6")
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("No tools are available")
    expect(args[args.indexOf("--system-prompt") + 1]).not.toContain("Call the tool record_summary")
    expect(args).not.toContain("--bare")
    expect(args.join(" ")).not.toContain(briefing.text)
    expect(rows[1]?.input).toContain(briefing.text)
    expect(rows.every((row) => row.apiKeyPresent === false)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(briefing.text)
    expect(JSON.stringify(logs)).not.toContain("private@example.invalid")
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "null")
    expect(schema.required).toContain("sourceIds")
    expect(schema.properties.title.maxLength).toBeUndefined()
  })
})

test("Given no consent, when summarizing, then Claude is never spawned", async () => {
  await withStub("ok", async ({ trace }) => {
    await expect(summarizeBriefing({ settings: settings(false), briefing })).rejects.toThrow()
    expect(existsSync(trace)).toBe(false)
  })
})

test("Given an unavailable login, when summarizing, then no evidence reaches CLI and HTTP fallback runs", async () => {
  await withStub("unauth", async ({ trace }) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] }),
    })
    try {
      const config = settings(true, true)
      const selected = config.providers[0]
      const configuredFallback = config.providers[1]
      if (!selected || !configuredFallback || configuredFallback.kind === "claude-code-cli")
        throw new Error("synthetic provider fixture is incomplete")
      const fallback = { ...configuredFallback, baseUrl: `${server.url}v1` }
      const result = await summarizeBriefing({
        settings: { ...config, providers: [selected, fallback] },
        briefing,
      })
      expect(result.state).toBe("done")
      if (result.state === "done") expect(result.model).toBe("http/fallback")
      expect(traceRows(trace).map((row) => row.kind)).toEqual(["auth"])
    } finally {
      server.stop(true)
    }
  })
})

test("Given an invalid citation, when CLI repairs once, then the existing contract accepts only the corrected result", async () => {
  await withStub("invalid-first", async ({ trace }) => {
    const result = await summarizeBriefing({ settings: settings(true), briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.summary.sourceIds).toEqual([ref])
      expect([result.inputTokens, result.outputTokens]).toEqual([14, 6])
    }
    expect(traceRows(trace).filter((row) => row.kind === "summary")).toHaveLength(2)
  })
})

test("Given in-flight consent revocation, when the child waits, then it is killed and output is discarded", async () => {
  await withStub("hang", async ({ started }) => {
    let current = settings(true)
    const result = summarizeBriefing({
      settings: current,
      getCurrentSettings: () => current,
      briefing,
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(started)).toBe(true)
    current = settings(false)
    await expect(result).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
  })
})

test("Given oversized CLI output, when its byte cap is crossed, then no partial result is accepted", async () => {
  await withStub("overflow", async ({ trace }) => {
    await expect(summarizeBriefing({ settings: settings(true), briefing })).rejects.toThrow(
      "all permitted summary providers failed",
    )
    expect(traceRows(trace).map((row) => row.kind)).toEqual(["auth", "summary"])
  })
})
