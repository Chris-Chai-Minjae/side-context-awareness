import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { SUMMARY_CODEX_CONSENT_POLL_MS, SUMMARY_CODEX_MAX_OUTPUT_BYTES } from "../constants"

export class CodexCliUnavailableError extends Error {
  readonly name = "CodexCliUnavailableError"
  constructor() {
    super("Codex CLI ChatGPT login is unavailable or returned no usable output")
  }
}

export class CodexCliConsentRevokedError extends Error {
  readonly name = "CodexCliConsentRevokedError"
  constructor() {
    super("summary evidence permission was revoked during Codex CLI execution")
  }
}

type CapturedRun = {
  readonly stdout: string
  readonly stderr: string
  readonly responseBytes: number
}
type StopReason = "revoked" | "timeout" | "overflow" | "input-error" | "tool"
type RunOptions = {
  readonly executable: string
  readonly args: readonly string[]
  readonly input?: string
  readonly cwd: string
  readonly home: string
  readonly codexHome: string
  readonly deadline: number
  readonly canSendEvidence: () => boolean
}

function isToolEvent(line: string): boolean {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return false
  }
  if (event === null || typeof event !== "object" || !("type" in event)) return false
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  )
    return false
  if (
    !("item" in event) ||
    event.item === null ||
    typeof event.item !== "object" ||
    !("type" in event.item)
  )
    return false
  return event.item.type !== "agent_message" && event.item.type !== "reasoning"
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveCodexExecutable(): string {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const candidate = join(directory, "codex")
    if (isExecutableFile(candidate)) return candidate
  }
  const home = process.env["HOME"]
  if (home && isAbsolute(home)) {
    const candidate = join(home, ".local", "bin", "codex")
    if (isExecutableFile(candidate)) return candidate
  }
  throw new CodexCliUnavailableError()
}

function cliEnvironment(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/(?:^|_)(?:API_KEY|AUTH_TOKEN)$/i.test(name) || name.startsWith("CODEX_")) delete env[name]
  }
  for (const name of [
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "OPENAI_PROJECT_ID",
    "AZURE_OPENAI_ENDPOINT",
  ])
    delete env[name]
  env["HOME"] = home
  env["CODEX_HOME"] = codexHome
  return env
}

export async function runCodex(options: RunOptions): Promise<CapturedRun> {
  const { executable, args, input, cwd, home, codexHome, deadline, canSendEvidence } = options
  if (!canSendEvidence()) throw new CodexCliConsentRevokedError()
  if (performance.now() >= deadline) throw new CodexCliUnavailableError()
  const child = spawn(executable, [...args], {
    shell: false,
    detached: true,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: cliEnvironment(home, codexHome),
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let responseBytes = 0
  let stopped: StopReason | undefined
  let pendingLine = ""
  const decoder = new StringDecoder("utf8")
  return new Promise<CapturedRun>((resolve, reject) => {
    const stop = (reason: StopReason): void => {
      if (stopped) return
      stopped = reason
      const pid = child.pid
      if (pid === undefined) {
        child.kill("SIGKILL")
      } else {
        try {
          process.kill(-pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error)) throw error
          child.kill("SIGKILL")
        }
      }
    }
    const timer = setTimeout(() => stop("timeout"), Math.max(0, deadline - performance.now()))
    const consentPoll = setInterval(() => {
      if (!canSendEvidence()) stop("revoked")
    }, SUMMARY_CODEX_CONSENT_POLL_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      clearInterval(consentPoll)
    }
    const collect = (chunk: Buffer, stdout: boolean): void => {
      responseBytes += chunk.length
      if (responseBytes > SUMMARY_CODEX_MAX_OUTPUT_BYTES) stop("overflow")
      else if (stdout) {
        stdoutChunks.push(chunk)
        if (args[0] === "exec") {
          pendingLine += decoder.write(chunk)
          const lines = pendingLine.split("\n")
          pendingLine = lines.pop() ?? ""
          if (lines.some(isToolEvent)) stop("tool")
        }
      } else stderrChunks.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false))
    child.stdin.on("error", () => stop("input-error"))
    child.once("error", () => {
      cleanup()
      reject(new CodexCliUnavailableError())
    })
    child.once("close", (code) => {
      cleanup()
      if (stopped === "revoked" || !canSendEvidence()) reject(new CodexCliConsentRevokedError())
      else if (stopped || code !== 0) reject(new CodexCliUnavailableError())
      else
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          responseBytes,
        })
    })
    child.stdin.end(input)
  })
}
