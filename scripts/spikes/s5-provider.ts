import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const toolSchema = z.object({
  name: z.literal("record_summary"),
  parameters: z.object({ type: z.literal("object") }).passthrough(),
})

const argumentsSchema = z.strictObject({
  title: z.string().min(1).max(80),
  description: z.array(z.string().max(240)).min(1).max(3),
  memorySummary: z.string().max(2000),
  priorContext: z.string().max(600).optional(),
  userEntities: z.array(z.string().max(80)).max(20).optional(),
  recordingSummary: z.string().max(600).optional(),
  apps: z.array(z.string()).max(20),
  domains: z.array(z.string()).max(20),
  citations: z
    .array(
      z.strictObject({ ref: z.string(), title: z.string().optional(), url: z.string().optional() }),
    )
    .max(30),
  sourceIds: z.array(z.string()).max(200),
})

const toolCallSchema = z.object({
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})
const responseSchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ tool_calls: z.array(toolCallSchema).nullish() }) }),
  ),
})

const providerSchema = z.object({
  api: z.literal("openai-completions"),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
})

type Target = {
  readonly id: "mimo" | "minimax" | "lan"
  readonly modelId: string
  readonly baseUrl: string
  readonly key: string
  readonly authHeader: "api-key" | "Authorization"
}

type Result = {
  readonly id: Target["id"]
  readonly modelId: string
  readonly host: string
  readonly httpStatus: number | null
  readonly latencyMs: number | null
  readonly toolCallCount: number | null
  readonly forcedToolCallObserved: boolean | null
  readonly supportsToolChoice: boolean | null
  readonly outcome: string
}

function blocked(id: Target["id"], modelId: string, outcome: string): Result {
  return {
    id,
    modelId,
    host: "unconfirmed",
    httpStatus: null,
    latencyMs: null,
    toolCallCount: null,
    forcedToolCallObserved: null,
    supportsToolChoice: null,
    outcome,
  }
}

function registeredUrl(baseUrl: string, protocol: "http:" | "https:", hostname: string): boolean {
  const url = new URL(baseUrl)
  return (
    url.protocol === protocol &&
    url.hostname === hostname &&
    url.pathname === "/v1" &&
    !(url.search || url.hash) &&
    !(url.username || url.password)
  )
}

async function probe(target: Target, tool: z.infer<typeof toolSchema>): Promise<Result> {
  const started = performance.now()
  let httpStatus: number | null = null
  let toolCallCount: number | null = null
  let toolArgumentsValid: boolean | null = null
  let outcome = "network_error"
  try {
    const response = await fetch(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/json",
        [target.authHeader]:
          target.authHeader === "Authorization" ? `Bearer ${target.key}` : target.key,
      },
      body: JSON.stringify({
        model: target.modelId,
        messages: [
          {
            role: "system",
            content:
              "Write a factual summary for one fictional time window. Call record_summary exactly once. Do not write other text. Cite only evidence ids present in the briefing.",
          },
          {
            role: "user",
            content:
              "<untrusted-evidence>A fictional person opened TextEdit and drafted a garden club poster. There are no source ids or URLs.</untrusted-evidence>",
          },
        ],
        tools: [{ type: "function", function: tool }],
        tool_choice: { type: "function", function: { name: "record_summary" } },
        max_tokens: 4096,
        temperature: 0.2,
      }),
    })
    httpStatus = response.status
    if (response.ok) {
      const envelope: unknown = await response.json()
      const parsed = responseSchema.safeParse(envelope)
      if (parsed.success) {
        const calls = parsed.data.choices[0]?.message.tool_calls ?? []
        const call = calls.length === 1 ? calls[0] : undefined
        toolCallCount = calls.length
        toolArgumentsValid = false
        if (call?.type === "function" && call.function.name === "record_summary") {
          try {
            const argumentsValue: unknown = JSON.parse(call.function.arguments)
            toolArgumentsValid = argumentsSchema.safeParse(argumentsValue).success
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
          }
        }
        outcome = toolArgumentsValid ? "tool_call_valid" : "tool_call_missing_or_invalid"
      } else {
        outcome = "response_shape_invalid"
      }
    } else {
      outcome =
        response.status === 400
          ? "http_400"
          : response.status === 429
            ? "http_429"
            : response.status === 404
              ? "http_404_model_unconfirmed"
              : "http_error"
    }
  } catch (error) {
    outcome =
      error instanceof SyntaxError
        ? "response_json_invalid"
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "timeout"
          : "network_error"
  }
  return {
    id: target.id,
    modelId: target.modelId,
    host: new URL(target.baseUrl).host,
    httpStatus,
    latencyMs: Math.round(performance.now() - started),
    toolCallCount,
    forcedToolCallObserved: httpStatus === 200 ? toolArgumentsValid : null,
    // Xiaomi documents that non-auto tool_choice is dropped by its OpenAI backend.
    supportsToolChoice:
      target.id === "mimo" ? false : httpStatus === 200 ? toolArgumentsValid : null,
    outcome,
  }
}

async function main(): Promise<void> {
  const onlyLan = z.enum(["lan"]).optional().parse(process.argv[2]) === "lan"
  const approvedSpec = await readFile(
    join(import.meta.dir, "../../docs/planning/05-comprehension.md"),
    "utf8",
  )
  const toolJson = z
    .string()
    .parse(approvedSpec.match(/## 5\. 출력 계약:[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1])
  const tool = toolSchema.parse(JSON.parse(toolJson))
  const root = join(homedir(), ".aside", "u", "0")
  const models: unknown = JSON.parse(await readFile(join(root, "models.json"), "utf8"))
  const credentials: unknown = JSON.parse(await readFile(join(root, "credentials.json"), "utf8"))
  const providers = z.object({ providers: z.record(z.string(), z.unknown()) }).safeParse(models)
  const xiaomi = providerSchema.safeParse(
    providers.success ? providers.data.providers["xiaomi-coding"] : undefined,
  )
  const litellm = providerSchema.safeParse(
    providers.success ? providers.data.providers["litellm"] : undefined,
  )
  const minimax = z.object({ minimax: z.object({ key: z.string().min(1) }) }).safeParse(credentials)
  const targets: Target[] = []
  const results: Result[] = []

  if (
    xiaomi.success &&
    registeredUrl(xiaomi.data.baseUrl, "https:", "token-plan-sgp.xiaomimimo.com") &&
    new URL(xiaomi.data.baseUrl).port === "" &&
    /^(?:tp|ttp)-/.test(xiaomi.data.apiKey)
  ) {
    targets.push({
      id: "mimo",
      modelId: "mimo-v2.6-pro",
      baseUrl: xiaomi.data.baseUrl,
      key: xiaomi.data.apiKey,
      authHeader: "api-key",
    })
  } else results.push(blocked("mimo", "mimo-v2.6-pro", "direct_token_plan_unconfirmed"))

  if (minimax.success) {
    // The user and official MiniMax docs confirm this OpenAI-compatible endpoint and model.
    targets.push({
      id: "minimax",
      modelId: "MiniMax-M3",
      baseUrl: "https://api.minimax.io/v1",
      key: minimax.data.minimax.key,
      authHeader: "Authorization",
    })
  } else results.push(blocked("minimax", "MiniMax-M3", "direct_model_or_key_unconfirmed"))

  let lanModelListed = false
  if (litellm.success && registeredUrl(litellm.data.baseUrl, "http:", "192.168.1.141")) {
    try {
      const listed = await fetch(`${litellm.data.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${litellm.data.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
      if (listed.ok) {
        const listing: unknown = await listed.json()
        const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(listing)
        lanModelListed = parsed.success && parsed.data.data.some((model) => model.id === "grok-4.7")
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
  }
  if (litellm.success && lanModelListed) {
    targets.push({
      id: "lan",
      modelId: "grok-4.7",
      baseUrl: litellm.data.baseUrl,
      key: litellm.data.apiKey,
      authHeader: "Authorization",
    })
  } else results.push(blocked("lan", "grok-4.7", "registered_lan_model_unconfirmed"))

  const chosen = onlyLan ? targets.filter((target) => target.id === "lan") : targets
  results.push(...(await Promise.all(chosen.map((target) => probe(target, tool)))))
  for (const result of results) {
    if (!onlyLan || result.id === "lan") console.log(JSON.stringify(result))
  }
}

main().catch(() => {
  // no-excuse-ok: catch — this CLI boundary deliberately suppresses credential-bearing errors.
  console.log(JSON.stringify({ outcome: "local_setup_failed" }))
  process.exitCode = 1
})
