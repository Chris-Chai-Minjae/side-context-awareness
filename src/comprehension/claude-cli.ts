import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { z } from "zod"
import {
  SUMMARY_CLAUDE_CONSENT_POLL_MS,
  SUMMARY_CLAUDE_MAX_OUTPUT_BYTES,
  SUMMARY_PROVIDER_TIMEOUT_MS,
} from "../constants"
import { RecordSummaryTool } from "../contracts/summary"
import type { SummaryMessage } from "./prompt"
import { SUMMARY_SYSTEM_PROMPT } from "./prompt"

export class ClaudeCliUnavailableError extends Error {
  readonly name = "ClaudeCliUnavailableError"
  constructor() {
    super("Claude Code CLI is unavailable or returned no usable output")
  }
}

export class ClaudeCliConsentRevokedError extends Error {
  readonly name = "ClaudeCliConsentRevokedError"
  constructor() {
    super("summary evidence permission was revoked during Claude Code CLI execution")
  }
}

const AuthStatusSchema = z.object({ loggedIn: z.literal(true) })
const ResultSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean().optional(),
  structured_output: z.unknown(),
  usage: z.unknown().optional(),
})
const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
})
const ModelIdSchema = z.string().regex(/^claude-[A-Za-z0-9-]+$/)
// The CLI schema enforces structure; the existing record_summary validator enforces these limits.
const CliJsonSchema = JSON.stringify(RecordSummaryTool.parameters, (key, value: unknown) =>
  key === "maxLength" || key === "minItems" || key === "maxItems" ? undefined : value,
)

type CapturedRun = { readonly stdout: string; readonly responseBytes: number }
type StopReason = "revoked" | "timeout" | "overflow" | "input-error"

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveClaudeExecutable(): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, "claude")
    if (isExecutableFile(candidate)) return candidate
  }
  const home = process.env["HOME"]
  if (home && isAbsolute(home)) {
    const candidate = join(home, ".local", "bin", "claude")
    if (isExecutableFile(candidate)) return candidate
  }
  throw new ClaudeCliUnavailableError()
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // The optional CLI provider uses the user's Claude Code login, not an inherited API key.
  delete env["ANTHROPIC_API_KEY"]
  delete env["ANTHROPIC_AUTH_TOKEN"]
  delete env["CLAUDE_CODE_SIMPLE"]
  return env
}

async function runClaude(
  executable: string,
  args: readonly string[],
  input: string | undefined,
  deadline: number,
  canSendEvidence: () => boolean,
): Promise<CapturedRun> {
  if (!canSendEvidence()) throw new ClaudeCliConsentRevokedError()
  if (performance.now() >= deadline) throw new ClaudeCliUnavailableError()
  const child = spawn(executable, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: cliEnvironment(),
  })
  const chunks: Buffer[] = []
  let responseBytes = 0
  let stopped: StopReason | undefined
  return new Promise<CapturedRun>((resolve, reject) => {
    const stop = (reason: StopReason): void => {
      if (stopped) return
      stopped = reason
      child.kill("SIGKILL")
    }
    const timer = setTimeout(() => stop("timeout"), Math.max(0, deadline - performance.now()))
    const consentPoll = setInterval(() => {
      if (!canSendEvidence()) stop("revoked")
    }, SUMMARY_CLAUDE_CONSENT_POLL_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      clearInterval(consentPoll)
    }
    const collect = (chunk: Buffer, stdout: boolean): void => {
      responseBytes += chunk.length
      if (responseBytes > SUMMARY_CLAUDE_MAX_OUTPUT_BYTES) {
        stop("overflow")
      } else if (stdout) {
        chunks.push(chunk)
      }
    }
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false))
    child.stdin.on("error", () => stop("input-error"))
    child.once("error", () => {
      cleanup()
      reject(new ClaudeCliUnavailableError())
    })
    child.once("close", (code) => {
      cleanup()
      if (stopped === "revoked" || !canSendEvidence()) {
        reject(new ClaudeCliConsentRevokedError())
      } else if (stopped || code !== 0) {
        reject(new ClaudeCliUnavailableError())
      } else {
        resolve({ stdout: Buffer.concat(chunks).toString("utf8"), responseBytes })
      }
    })
    child.stdin.end(input)
  })
}

export async function callClaudeCliSummary(
  messages: readonly SummaryMessage[],
  modelId: string,
  canSendEvidence: () => boolean,
): Promise<{
  readonly argumentsValue: unknown
  readonly inputTokens: number
  readonly outputTokens: number
  readonly responseBytes: number
}> {
  if (!ModelIdSchema.safeParse(modelId).success) throw new ClaudeCliUnavailableError()
  const deadline = performance.now() + SUMMARY_PROVIDER_TIMEOUT_MS
  const executable = resolveClaudeExecutable()
  const auth = await runClaude(
    executable,
    ["auth", "status", "--json"],
    undefined,
    deadline,
    canSendEvidence,
  )
  let authValue: unknown
  try {
    authValue = JSON.parse(auth.stdout)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new ClaudeCliUnavailableError()
  }
  if (!AuthStatusSchema.safeParse(authValue).success) throw new ClaudeCliUnavailableError()

  const systemPrompt = `${(
    messages.find((message) => message.role === "system")?.content ?? SUMMARY_SYSTEM_PROMPT
  ).replace(
    /Call (?:the tool )?record_summary exactly once\./,
    "Return exactly one JSON object containing record_summary arguments.",
  )}\nNo tools are available; return only the JSON object.`
  const input = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")
  const response = await runClaude(
    executable,
    [
      "-p",
      "--restricted",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      CliJsonSchema,
      "--model",
      modelId,
      "--system-prompt",
      systemPrompt,
    ],
    input,
    deadline,
    canSendEvidence,
  )
  let value: unknown
  try {
    value = JSON.parse(response.stdout)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new ClaudeCliUnavailableError()
  }
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, "structured_output"))
    throw new ClaudeCliUnavailableError()
  const envelope = ResultSchema.safeParse(value)
  if (!envelope.success || envelope.data.is_error) throw new ClaudeCliUnavailableError()
  const usage = UsageSchema.safeParse(envelope.data.usage)
  return {
    argumentsValue: envelope.data.structured_output,
    inputTokens: usage.success ? usage.data.input_tokens : 0,
    outputTokens: usage.success ? usage.data.output_tokens : 0,
    responseBytes: response.responseBytes,
  }
}
