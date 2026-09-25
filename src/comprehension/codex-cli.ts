import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { SUMMARY_PROVIDER_TIMEOUT_MS } from "../constants"
import { CodexCliUnavailableError, resolveCodexExecutable, runCodex } from "./codex-cli-process"
import type { SummaryMessage } from "./prompt"
import { SUMMARY_SYSTEM_PROMPT } from "./prompt"

export { CodexCliConsentRevokedError, CodexCliUnavailableError } from "./codex-cli-process"

const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
})

// Codex's strict output schema requires every property, including nested properties, in required.
// Optional record_summary fields are omitted here; the shared contract checks semantic limits.
const CliJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "memorySummary", "apps", "domains", "citations", "sourceIds"],
  properties: {
    title: { type: "string" },
    description: { type: "array", items: { type: "string" } },
    memorySummary: { type: "string" },
    apps: { type: "array", items: { type: "string" } },
    domains: { type: "array", items: { type: "string" } },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref"],
        properties: { ref: { type: "string" } },
      },
    },
    sourceIds: { type: "array", items: { type: "string" } },
  },
} as const

function parseEvents(stdout: string): {
  readonly argumentsValue: unknown
  readonly inputTokens: number
  readonly outputTokens: number
} {
  let answer: string | undefined
  let completed = false
  let inputTokens = 0
  let outputTokens = 0
  for (const line of stdout.trim().split("\n")) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new CodexCliUnavailableError()
    }
    if (event === null || typeof event !== "object" || !("type" in event))
      throw new CodexCliUnavailableError()
    switch (event.type) {
      case "thread.started":
      case "turn.started":
        break
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (
          !("item" in event) ||
          event.item === null ||
          typeof event.item !== "object" ||
          !("type" in event.item)
        )
          throw new CodexCliUnavailableError()
        if (event.item.type !== "agent_message" && event.item.type !== "reasoning")
          throw new CodexCliUnavailableError()
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          if (
            !("text" in event.item) ||
            typeof event.item.text !== "string" ||
            answer !== undefined
          )
            throw new CodexCliUnavailableError()
          answer = event.item.text
        }
        break
      }
      case "turn.completed": {
        if (completed) throw new CodexCliUnavailableError()
        completed = true
        const usage = UsageSchema.safeParse("usage" in event ? event.usage : undefined)
        if (usage.success) {
          inputTokens = usage.data.input_tokens
          outputTokens = usage.data.output_tokens
        }
        break
      }
      default:
        throw new CodexCliUnavailableError()
    }
  }
  if (!completed || answer === undefined) throw new CodexCliUnavailableError()
  let argumentsValue: unknown
  try {
    argumentsValue = JSON.parse(answer)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new CodexCliUnavailableError()
  }
  if (
    argumentsValue === null ||
    typeof argumentsValue !== "object" ||
    Array.isArray(argumentsValue)
  )
    throw new CodexCliUnavailableError()
  return { argumentsValue, inputTokens, outputTokens }
}

export async function callCodexCliSummary(
  messages: readonly SummaryMessage[],
  modelId: string,
  canSendEvidence: () => boolean,
): Promise<{
  readonly argumentsValue: unknown
  readonly inputTokens: number
  readonly outputTokens: number
  readonly responseBytes: number
}> {
  if (!ModelIdSchema.safeParse(modelId).success) throw new CodexCliUnavailableError()
  const deadline = performance.now() + SUMMARY_PROVIDER_TIMEOUT_MS
  const executable = resolveCodexExecutable()
  const accountHome = process.env["CODEX_HOME"] ?? join(process.env["HOME"] ?? "", ".codex")
  if (!isAbsolute(accountHome)) throw new CodexCliUnavailableError()
  const accountAuth = join(accountHome, "auth.json")
  try {
    const auth = lstatSync(accountAuth)
    if (!auth.isFile() || auth.uid !== process.getuid?.() || (auth.mode & 0o077) !== 0)
      throw new CodexCliUnavailableError()
  } catch {
    throw new CodexCliUnavailableError()
  }
  const directory = mkdtempSync(join(tmpdir(), "side-codex-"))
  const home = join(directory, "home")
  const codexHome = join(directory, "codex")
  const authLink = join(codexHome, "auth.json")
  const cwd = join(directory, "work")
  const schemaPath = join(directory, "summary-schema.json")
  try {
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(codexHome, { mode: 0o700 })
    mkdirSync(cwd, { mode: 0o700 })
    symlinkSync(accountAuth, authLink)
    writeFileSync(schemaPath, JSON.stringify(CliJsonSchema), { mode: 0o600 })
    const auth = await runCodex({
      executable,
      args: ["login", "status"],
      cwd,
      home,
      codexHome,
      deadline,
      canSendEvidence,
    })
    if (!lstatSync(authLink).isSymbolicLink() || readlinkSync(authLink) !== accountAuth)
      throw new CodexCliUnavailableError()
    if (`${auth.stdout}${auth.stderr}`.trim() !== "Logged in using ChatGPT")
      throw new CodexCliUnavailableError()

    const systemPrompt = `${(
      messages.find((message) => message.role === "system")?.content ?? SUMMARY_SYSTEM_PROMPT
    ).replace(
      /Call (?:the tool )?record_summary exactly once\./,
      "Return exactly one JSON object containing record_summary arguments.",
    )}\nDo not use tools. Return only the JSON object described by the output schema.`
    const userInput = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n")
    const response = await runCodex({
      executable,
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "skills.include_instructions=false",
        "-c",
        "web_search=disabled",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "--disable",
        "skill_search",
        "--disable",
        "multi_agent",
        "--disable",
        "browser_use",
        "--disable",
        "browser_use_external",
        "--disable",
        "in_app_browser",
        "--disable",
        "computer_use",
        "--disable",
        "image_generation",
        "--disable",
        "view_image",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--json",
        "--output-schema",
        schemaPath,
        "--model",
        modelId,
        "-",
      ],
      input: `${systemPrompt}\n\n${userInput}`,
      cwd,
      home,
      codexHome,
      deadline,
      canSendEvidence,
    })
    if (!lstatSync(authLink).isSymbolicLink() || readlinkSync(authLink) !== accountAuth)
      throw new CodexCliUnavailableError()
    return { ...parseEvents(response.stdout), responseBytes: response.responseBytes }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
