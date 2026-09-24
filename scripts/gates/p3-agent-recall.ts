import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createEvidenceHandlers } from "../../src/api/resources/evidence"
import { startApiServer } from "../../src/api/server"
import { RpcMethods } from "../../src/contracts/rpc"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

const TARGET_URL = "https://fixture.invalid/sqlite/extensions/vec0-guide"
const SNIPPET = "S2_SYNTHETIC_SNIPPET: vec0 가상 테이블은 이 합성 문서의 예시입니다."
const QUERY =
  "어제 오후에 보던 sqlite 확장 문서의 URL과 원문 스니펫을 찾아줘. Side MCP의 history_search로 찾고 해당 e: ref를 history_read로 확인해."
const MCP_TOOLS = ["mcp__side__history_search", "mcp__side__history_read"] as const

const StreamEvent = z.object({
  type: z.string(),
  message: z.object({ content: z.array(z.unknown()) }).optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
})
const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})
const ToolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
})
const TextContent = z.array(z.object({ type: z.literal("text"), text: z.string() }))
const Usage = z.object({ clientName: z.string(), tool: z.string(), resultCount: z.number() })

function resultText(content: unknown): string | null {
  if (typeof content === "string") return content
  const parsed = TextContent.safeParse(content)
  return parsed.success ? parsed.data.map((item) => item.text).join("\n") : null
}

function parseToolResult(text: string): unknown {
  const trimmed = text.trim()
  // Claude Code wraps MCP text results as untrusted evidence in stream-json.
  const wrapped =
    /^<untrusted-evidence nonce="([^"]+)">([\s\S]*)<\/untrusted-evidence nonce="([^"]+)">$/u.exec(
      trimmed,
    )
  if (wrapped && wrapped[1] !== wrapped[3]) return null
  try {
    return JSON.parse(wrapped?.[2] ?? trimmed)
  } catch {
    return null
  }
}

function transcript(stdout: string): {
  readonly uses: readonly z.infer<typeof ToolUse>[]
  readonly results: ReadonlyMap<string, string>
  readonly failed: boolean
  readonly finalResult: string | null
} {
  const uses: z.infer<typeof ToolUse>[] = []
  const results = new Map<string, string>()
  let failed = false
  let finalResult: string | null = null
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const event = StreamEvent.safeParse(value)
    if (!event.success) continue
    if (event.data.type === "result") {
      failed = event.data.is_error === true
      finalResult = event.data.result ?? null
    }
    for (const block of event.data.message?.content ?? []) {
      const use = ToolUse.safeParse(block)
      if (use.success) {
        uses.push(use.data)
        continue
      }
      const result = ToolResult.safeParse(block)
      if (!result.success || result.data.is_error === true) continue
      const text = resultText(result.data.content)
      if (text !== null) results.set(result.data.tool_use_id, text)
    }
  }
  return { uses, results, failed, finalResult }
}

async function main(mode: "bare" | "isolated-normal" | "existing-auth-normal"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "side-p3v-claude-"))
  const dataDir = join(root, "side-data")
  const configDir = join(root, "claude-config")
  mkdirSync(dataDir, { mode: 0o700 })
  mkdirSync(configDir, { mode: 0o700 })
  const db = openLedger(join(dataDir, "ledger.db"))
  const masterKey = Buffer.alloc(32, 0x53)
  let api: Awaited<ReturnType<typeof startApiServer>> | undefined
  try {
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo",
    })
    const source = writeLedgerEvent(db, masterKey, {
      occurredAt: Date.parse(`${yesterday}T15:10:00+09:00`),
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      bundleId: "invalid.fixture.browser",
      windowTitle: "SQLite sqlite 확장 문서 — vec0 사용 설명",
      url: TARGET_URL,
      content: SNIPPET,
    })
    const sourceRef = `e:${source.id}`
    const handlers = createEvidenceHandlers({
      db,
      getMasterKey: () => Buffer.from(masterKey),
      browserHistory: async () => [],
    })
    if (!handlers.search || !handlers.read) throw new Error("Evidence handlers are missing")
    const preflight = RpcMethods.search.output.parse(
      await handlers.search({ queries: ["sqlite", "확장", "문서"], limit: 5 }),
    )
    const preflightRank = preflight.findIndex(
      (hit) => hit.ref === sourceRef && hit.url === TARGET_URL,
    )
    const preflightRead = RpcMethods.read.output.parse(await handlers.read({ id: sourceRef }))
    if (preflightRank < 0 || preflightRead?.expired || !preflightRead?.text.includes(SNIPPET))
      throw new Error("Synthetic search/read preflight failed")

    api = await startApiServer({ directory: dataDir, handlers })
    const mcpConfig = join(root, ".mcp.json")
    const sideCli = join(import.meta.dir, "../../src/cli.ts")
    const registration = Bun.spawnSync({
      cmd: [
        "claude",
        "mcp",
        "add",
        "--scope",
        "project",
        "side",
        "-e",
        `SIDE_DATA_DIR=${dataDir}`,
        "-e",
        `LCA_DATA_DIR=${dataDir}`,
        "--",
        process.execPath,
        sideCli,
        "mcp",
      ],
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        CLAUDE_CONFIG_DIR: configDir,
        ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
        ...(process.env["LOGNAME"] ? { LOGNAME: process.env["LOGNAME"] } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    if (registration.exitCode !== 0 || !existsSync(mcpConfig))
      throw new Error("Isolated Claude Code MCP registration failed")
    const server = JSON.parse(readFileSync(mcpConfig, "utf8"))?.mcpServers?.side
    if (
      server?.command !== process.execPath ||
      JSON.stringify(server.args) !== JSON.stringify([sideCli, "mcp"]) ||
      server.env?.SIDE_DATA_DIR !== dataDir ||
      server.env?.LCA_DATA_DIR !== dataDir
    )
      throw new Error("Isolated Claude Code MCP registration did not match Side")
    const authKey = process.env["ANTHROPIC_API_KEY"]
    const child = Bun.spawn(
      [
        "claude",
        ...(mode === "bare" ? ["--bare"] : []),
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfig,
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--no-chrome",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        MCP_TOOLS.join(","),
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--max-budget-usd",
        "0.20",
        "--output-format",
        "stream-json",
        "--verbose",
        "-p",
        QUERY,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          TZ: "Asia/Tokyo",
          ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
          ...(process.env["LOGNAME"] ? { LOGNAME: process.env["LOGNAME"] } : {}),
          ...(mode === "existing-auth-normal"
            ? { HOME: process.env["HOME"] ?? "/nonexistent" }
            : { CLAUDE_CONFIG_DIR: configDir }),
          SIDE_DATA_DIR: dataDir,
          LCA_DATA_DIR: dataDir,
          ...(authKey ? { ANTHROPIC_API_KEY: authKey } : {}),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const trace = transcript(stdout)
    let searchRank = -1
    for (const use of trace.uses.filter((item) => item.name === MCP_TOOLS[0])) {
      const text = trace.results.get(use.id)
      if (!text) continue
      const parsed = RpcMethods.search.output.safeParse(parseToolResult(text))
      if (!parsed.success) continue
      const rank = parsed.data.findIndex((hit) => hit.ref === sourceRef && hit.url === TARGET_URL)
      if (rank >= 0 && rank < 5) searchRank = rank + 1
    }
    const readConfirmed = trace.uses.some((use) => {
      if (use.name !== MCP_TOOLS[1]) return false
      const input = RpcMethods.read.input.safeParse(use.input)
      const text = trace.results.get(use.id)
      if (!input.success || input.data.id !== sourceRef || !text) return false
      const read = RpcMethods.read.output.safeParse(parseToolResult(text))
      return (
        read.success && read.data !== null && !read.data.expired && read.data.text.includes(SNIPPET)
      )
    })
    const usagePath = join(dataDir, "run", "mcp-usage.jsonl")
    const usage = existsSync(usagePath)
      ? readFileSync(usagePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => Usage.parse(JSON.parse(line)))
      : []
    const usedTools = new Set(usage.map((record) => record.tool))
    const cliDiagnostic = (stderr.trim().split("\n")[0] || trace.finalResult)?.slice(0, 160) ?? null
    const passed =
      exitCode === 0 &&
      !trace.failed &&
      searchRank > 0 &&
      readConfirmed &&
      usedTools.has("history_search") &&
      usedTools.has("history_read")
    console.log(
      JSON.stringify({
        status: passed ? "pass" : "unresolved",
        mode,
        claudeExitCode: exitCode,
        fixturePreflight: "pass",
        targetUrl: TARGET_URL,
        sourceRef,
        historySearchRank: searchRank > 0 ? searchRank : null,
        historyReadSnippet: readConfirmed,
        toolUses: trace.uses.map((use) => use.name),
        mcpUsage: usage.map((record) => ({ clientName: record.clientName, tool: record.tool })),
        cliError: !authKey && exitCode !== 0 ? cliDiagnostic : null,
        reason: passed
          ? null
          : cliDiagnostic?.includes("OAuth session expired")
            ? "Local Claude Code OAuth expired before MCP invocation"
            : !authKey && mode === "bare"
              ? "ANTHROPIC_API_KEY is absent; claude --bare has no OAuth or keychain authentication"
              : trace.finalResult?.startsWith("Not logged in")
                ? `Claude Code OAuth is unavailable in ${mode} mode`
                : `Claude Code exited ${exitCode} without the required MCP transcript`,
      }),
    )
    if (!passed) process.exitCode = 1
  } finally {
    await api?.stop()
    db.close()
    masterKey.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
}

try {
  const mode = process.argv.includes("--existing-auth")
    ? "existing-auth-normal"
    : process.argv.includes("--normal")
      ? "isolated-normal"
      : "bare"
  await main(mode)
} catch (error) {
  console.error(
    JSON.stringify({ status: "error", reason: error instanceof Error ? error.message : "unknown" }),
  )
  process.exitCode = 1
}
