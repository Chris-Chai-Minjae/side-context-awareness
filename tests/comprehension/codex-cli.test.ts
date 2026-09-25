import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderHandlers } from "../../src/api/resources/providers"
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

const stub = `#!BUN
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const mode = process.env.SIDE_CODEX_STUB_MODE
const trace = process.env.SIDE_CODEX_STUB_TRACE
if (args[0] === "login") {
  const authPath = process.env.CODEX_HOME + "/auth.json"
  appendFileSync(trace, JSON.stringify({ kind: "login", args, cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, authLinked: lstatSync(authPath).isSymbolicLink(), authLinkTarget: readlinkSync(authPath), apiKey: Boolean(process.env.OPENAI_API_KEY), codexKey: Boolean(process.env.CODEX_API_KEY) }) + "\\n")
  if (mode === "replace-auth-link") { unlinkSync(authPath); writeFileSync(authPath, "SYNTHETIC_REPLACEMENT") }
  process.stderr.write(mode === "api-auth" ? "Logged in using an API key\\n" : "Logged in using ChatGPT\\n")
  process.exit(0)
}
const input = readFileSync(0, "utf8")
const schema = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"))
const instructionPath = process.env.CODEX_HOME + "/AGENTS.md"
const instruction = existsSync(instructionPath) ? readFileSync(instructionPath, "utf8") : ""
const outboundRequest = instruction + "\\n" + input
const shellAvailable = !args.includes("shell_tool") && !args.includes("features.shell_tool=false")
const webAvailable = !args.includes("web_search=disabled")
appendFileSync(trace, JSON.stringify({ kind: "exec", args, cwd: process.cwd(), cwdEntries: (await import("node:fs")).readdirSync(process.cwd()), input, outboundRequest, shellAvailable, webAvailable, schema, apiKey: Boolean(process.env.OPENAI_API_KEY), codexKey: Boolean(process.env.CODEX_API_KEY), pid: process.pid }) + "\\n")
if (mode === "hostile" && (shellAvailable || webAvailable)) { writeFileSync(process.env.SIDE_CODEX_STUB_STARTED, "tool executed"); process.exit(3) }
if (mode === "hang") { writeFileSync(process.env.SIDE_CODEX_STUB_STARTED, "started"); await new Promise(() => {}) }
if (mode === "overflow") { process.stdout.write("x".repeat(2_000_000)); process.exit(0) }
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n")
emit({ type: "thread.started", thread_id: "synthetic" })
emit({ type: "turn.started" })
if (mode === "tool" || mode === "tool-hang") {
  emit({ type: "item.started", item: { id: "tool", type: "command_execution", command: "pwd" } })
  if (mode === "tool-hang") {
    writeFileSync(process.env.SIDE_CODEX_STUB_STARTED, "started")
    await new Promise(() => {})
  }
}
if (mode === "tool-child") {
  const grandchild = spawn(process.execPath, ["-e", 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.SIDE_CODEX_STUB_STARTED + ".child-started", "yes"); await Bun.sleep(900); writeFileSync(process.env.SIDE_CODEX_STUB_STARTED + ".survived", "yes")'], { stdio: "ignore" })
  writeFileSync(process.env.SIDE_CODEX_STUB_STARTED, String(grandchild.pid))
  for (let i = 0; i < 100 && !existsSync(process.env.SIDE_CODEX_STUB_STARTED + ".child-started"); i++) await Bun.sleep(10)
  if (!existsSync(process.env.SIDE_CODEX_STUB_STARTED + ".child-started")) process.exit(4)
  emit({ type: "item.started", item: { id: "tool", type: "command_execution", command: "pwd" } })
  await new Promise(() => {})
}
let output = JSON.parse(process.env.SIDE_CODEX_STUB_RESULT)
if (input.includes("fictional empty activity window"))
  output = { ...output, apps: [], domains: [], citations: [], sourceIds: [] }
if (mode === "invalid-first") {
  const countPath = process.env.SIDE_CODEX_STUB_COUNT
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0
  writeFileSync(countPath, String(count + 1))
  if (count === 0) output = { ...output, sourceIds: ["e:11111111111111111111111111"] }
}
emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(output) } })
emit({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } })
`

async function withStub<T>(
  mode: string,
  run: (trace: string, started: string) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "side-codex-test-"))
  const executable = join(directory, "codex")
  const codexHome = join(directory, "codex-home")
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, "AGENTS.md"), "SYNTHETIC_GLOBAL_INSTRUCTION_SENTINEL")
  writeFileSync(join(codexHome, "auth.json"), "SYNTHETIC_AUTH_NOT_REAL", { mode: 0o600 })
  const trace = join(directory, "trace.jsonl")
  const started = join(directory, "started")
  writeFileSync(executable, stub.replace("#!BUN", `#!${process.execPath}`))
  chmodSync(executable, 0o700)
  const names = [
    "PATH",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "SIDE_CODEX_STUB_MODE",
    "SIDE_CODEX_STUB_TRACE",
    "SIDE_CODEX_STUB_STARTED",
    "SIDE_CODEX_STUB_RESULT",
    "SIDE_CODEX_STUB_COUNT",
    "CODEX_HOME",
  ] as const
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    PATH: `${directory}:${original["PATH"] ?? ""}`,
    OPENAI_API_KEY: "synthetic-key",
    CODEX_API_KEY: "synthetic-key",
    SIDE_CODEX_STUB_MODE: mode,
    SIDE_CODEX_STUB_TRACE: trace,
    SIDE_CODEX_STUB_STARTED: started,
    SIDE_CODEX_STUB_RESULT: JSON.stringify(valid),
    SIDE_CODEX_STUB_COUNT: join(directory, "count"),
    CODEX_HOME: codexHome,
  })
  try {
    return await run(trace, started)
  } finally {
    for (const name of names) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

function settings(allowEvidence: boolean, fallback = false) {
  return SettingsSchema.parse({
    version: 2,
    contextAwareness: { enabled: true, summaryModel: { provider: "codex", modelId: "gpt-6-luna" } },
    providers: [
      { id: "codex", kind: "codex-cli", models: ["gpt-6-luna"], allowEvidence },
      ...(fallback
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

function traceRows(trace: string): Array<Record<string, unknown>> {
  return readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("Codex login runs in an empty temporary cwd with safe flags, scrubbed keys, and strict nested schema", async () => {
  await withStub("ok", async (trace) => {
    const result = await summarizeBriefing({ settings: settings(true), briefing })
    expect(result.state).toBe("done")
    if (result.state !== "done") return
    expect(result.model).toBe("codex/gpt-6-luna")
    expect([result.inputTokens, result.outputTokens]).toEqual([7, 3])
    const rows = traceRows(trace)
    expect(rows.map((row) => row["kind"])).toEqual(["login", "exec"])
    expect(rows[0]?.["codexHome"]).not.toBe(process.env["CODEX_HOME"])
    expect(rows[0]?.["authLinked"]).toBe(true)
    expect(rows[0]?.["authLinkTarget"]).toBe(join(process.env["CODEX_HOME"] ?? "", "auth.json"))
    expect(readFileSync(join(process.env["CODEX_HOME"] ?? "", "auth.json"), "utf8")).toBe(
      "SYNTHETIC_AUTH_NOT_REAL",
    )
    expect(rows.every((row) => row["apiKey"] === false && row["codexKey"] === false)).toBe(true)
    expect(rows[1]?.["cwdEntries"]).toEqual([])
    expect(rows[1]?.["cwd"]).not.toBe(process.cwd())
    const args = rows[1]?.["args"] as string[]
    for (const flag of [
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "--skip-git-repo-check",
      "--json",
      "--output-schema",
      "--model",
    ])
      expect(args).toContain(flag)
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only")
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-luna")
    expect(args.join(" ")).not.toContain(briefing.text)
    expect(rows[1]?.["input"]).toContain(briefing.text)
    expect(rows[1]?.["outboundRequest"]).not.toContain("SYNTHETIC_GLOBAL_INSTRUCTION_SENTINEL")
    expect(rows[1]?.["shellAvailable"]).toBe(false)
    expect(rows[1]?.["webAvailable"]).toBe(false)
    const schema = rows[1]?.["schema"] as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort())
    const citations = schema.properties["citations"] as {
      items: { required: string[]; properties: Record<string, unknown> }
    }
    expect(citations.items.required.sort()).toEqual(Object.keys(citations.items.properties).sort())
  })
})

test("Codex hostile request cannot invoke shell or web before a tool event", async () => {
  await withStub("hostile", async (trace, started) => {
    const result = await summarizeBriefing({ settings: settings(true), briefing })
    expect(result.state).toBe("done")
    expect(existsSync(started)).toBe(false)
    expect(traceRows(trace).find((row) => row["kind"] === "exec")?.["shellAvailable"]).toBe(false)
  })
})

test("Codex refuses API-key login before evidence reaches exec and falls back", async () => {
  await withStub("api-auth", async (trace) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] }),
    })
    try {
      const config = settings(true, true)
      const selected = config.providers[0]
      const fallback = config.providers[1]
      if (
        !selected ||
        !fallback ||
        fallback.kind === "claude-code-cli" ||
        fallback.kind === "codex-cli"
      )
        throw new Error("fixture")
      const result = await summarizeBriefing({
        settings: { ...config, providers: [selected, { ...fallback, baseUrl: `${server.url}v1` }] },
        briefing,
      })
      expect(result.state).toBe("done")
      if (result.state === "done") expect(result.model).toBe("http/fallback")
      expect(traceRows(trace).map((row) => row["kind"])).toEqual(["login"])
    } finally {
      server.stop(true)
    }
  })
})

test("Codex without evidence consent never launches the CLI", async () => {
  await withStub("ok", async (trace) => {
    await expect(summarizeBriefing({ settings: settings(false), briefing })).rejects.toThrow(
      "all permitted summary providers failed",
    )
    expect(existsSync(trace)).toBe(false)
  })
})

test("Codex fails closed when file-backed login is missing or unsafe", async () => {
  for (const mode of ["missing", "public-mode"])
    await withStub("ok", async (trace) => {
      const authPath = join(process.env["CODEX_HOME"] ?? "", "auth.json")
      if (mode === "missing") unlinkSync(authPath)
      else chmodSync(authPath, 0o644)
      await expect(summarizeBriefing({ settings: settings(true), briefing })).rejects.toThrow(
        "all permitted summary providers failed",
      )
      expect(existsSync(trace)).toBe(false)
    })
})

test("Codex fails closed if login replaces the auth symlink", async () => {
  await withStub("replace-auth-link", async (trace) => {
    await expect(summarizeBriefing({ settings: settings(true), briefing })).rejects.toThrow(
      "all permitted summary providers failed",
    )
    expect(traceRows(trace).map((row) => row["kind"])).toEqual(["login"])
  })
})

test("Codex rejects tool events and oversized output", async () => {
  for (const mode of ["tool", "overflow"])
    await withStub(mode, async () => {
      await expect(summarizeBriefing({ settings: settings(true), briefing })).rejects.toThrow(
        "all permitted summary providers failed",
      )
    })
})

test("Codex stops a running child as soon as a tool event is emitted", async () => {
  await withStub("tool-hang", async (_trace, started) => {
    let current = settings(true)
    const pending = summarizeBriefing({
      settings: current,
      getCurrentSettings: () => current,
      briefing,
    })
    try {
      await expect(
        Promise.race([
          pending,
          Bun.sleep(3_000).then(() => {
            throw new Error("tool event was not stopped")
          }),
        ]),
      ).rejects.toThrow("all permitted summary providers failed")
      expect(existsSync(started)).toBe(true)
    } finally {
      current = settings(false)
      await pending.catch(() => {})
    }
  })
})

test("Codex stops a wrapper's child process when a tool event is emitted", async () => {
  await withStub("tool-child", async (_trace, started) => {
    await expect(summarizeBriefing({ settings: settings(true), briefing })).rejects.toThrow(
      "all permitted summary providers failed",
    )
    expect(existsSync(started)).toBe(true)
    expect(existsSync(`${started}.child-started`)).toBe(true)
    await Bun.sleep(1_100)
    expect(existsSync(`${started}.survived`)).toBe(false)
  })
})

test("Codex kills in-flight work after evidence consent is revoked", async () => {
  await withStub("hang", async (_trace, started) => {
    let current = settings(true)
    const pending = summarizeBriefing({
      settings: current,
      getCurrentSettings: () => current,
      briefing,
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(started)).toBe(true)
    current = settings(false)
    await expect(pending).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
  })
})

test("Codex malformed record_summary retries once under the shared validator", async () => {
  await withStub("invalid-first", async (trace) => {
    const result = await summarizeBriefing({ settings: settings(true), briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.summary.sourceIds).toEqual([ref])
    expect(traceRows(trace).filter((row) => row["kind"] === "exec")).toHaveLength(2)
  })
})

test("providers.test uses only fictional evidence for Codex and reports a validated result", async () => {
  await withStub("ok", async (trace) => {
    const currentSettings = settings(false)
    const handlers = createProviderHandlers({
      directory: join(trace, ".."),
      reconciler: {
        currentSettings,
        settingsPatched: async () => {},
      },
      helper: {
        sendCommand: async () => {
          throw new Error("unexpected key request")
        },
      },
    })
    const testProvider = handlers["providers.test"]
    if (!testProvider) throw new Error("missing provider test handler")
    const result = await testProvider({ providerId: "codex", modelId: "gpt-6-luna" })
    expect(result).toMatchObject({ ok: true, toolChoiceSupported: false })
    const execution = traceRows(trace).find((row) => row["kind"] === "exec")
    expect(execution?.["input"]).toContain("fictional empty activity window")
    expect(execution?.["input"]).not.toContain(briefing.text)
  })
})
