import { z } from "zod"
import {
  MAX_CONCURRENT_SUMMARY_CALLS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_PROVIDER_TIMEOUT_MS,
  SUMMARY_TEMPERATURE,
} from "../constants"
import type { Settings } from "../contracts/settings"
import { RecordSummaryTool } from "../contracts/summary"
import {
  HelperCommandFailureError,
  HelperCommandTimeoutError,
  HelperUnavailableError,
} from "../helper/client"
import type { Briefing } from "./briefing"
import {
  ClaudeCliConsentRevokedError,
  ClaudeCliUnavailableError,
  callClaudeCliSummary,
} from "./claude-cli"
import {
  CodexCliConsentRevokedError,
  CodexCliUnavailableError,
  callCodexCliSummary,
} from "./codex-cli"
import type { ValidatedSummary } from "./contract"
import type { SummaryMessage } from "./prompt"
import { runSummaryWithOneRepair } from "./repair"

export type ResolvedSummaryModel = {
  readonly provider: Settings["providers"][number]
  readonly modelId: string
  readonly reasoningEffort?: "low" | "medium" | "high"
  readonly fastMode?: boolean
}

export type ProviderLog = {
  readonly provider: string
  readonly modelId: string
  readonly status?: number
  readonly durationMs: number
  readonly requestBytes: number
  readonly responseBytes: number
}

export type SummaryResult =
  | { readonly state: "no-summary-model" }
  | {
      readonly state: "done"
      readonly summary: ValidatedSummary
      readonly model: string
      readonly inputTokens: number
      readonly outputTokens: number
      readonly durationMs: number
    }

export type SummaryOptions = {
  readonly settings: Settings
  readonly briefing: Briefing
  readonly getCurrentSettings?: () => Settings
  readonly getApiKey?: (ref: string) => Promise<string | undefined>
  readonly log?: (entry: ProviderLog) => void
}

export class AllProvidersFailedError extends Error {
  readonly name = "AllProvidersFailedError"
  constructor() {
    super("all permitted summary providers failed")
  }
}

export class ProviderRequestError extends Error {
  readonly name = "ProviderRequestError"
  constructor(readonly status: number) {
    super(`summary provider returned HTTP ${status}`)
  }
}

export class EvidencePermissionRevokedError extends Error {
  readonly name = "EvidencePermissionRevokedError"
  constructor() {
    super("summary evidence permission was revoked before the provider request")
  }
}

class ProviderFallbackError extends Error {
  readonly name = "ProviderFallbackError"
  constructor() {
    super("summary provider is unavailable or returned no usable output")
  }
}

const CompletionSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        tool_calls: z
          .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
          .nullish(),
        content: z.string().nullable().optional(),
      }),
    }),
  ),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .nullish(),
})

// A granted slot passes directly to the next waiter, preserving the global two-call cap.
let activeCalls = 0
const waiting: (() => void)[] = []
async function withCallSlot<T>(run: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
  if (activeCalls < MAX_CONCURRENT_SUMMARY_CALLS) activeCalls++
  else
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const grant = () => {
        if (timeout !== undefined) clearTimeout(timeout)
        resolve()
      }
      if (waitTimeoutMs !== undefined)
        timeout = setTimeout(() => {
          const index = waiting.indexOf(grant)
          if (index < 0) return
          waiting.splice(index, 1)
          reject(new ProviderFallbackError())
        }, waitTimeoutMs)
      waiting.push(grant)
    })
  try {
    return await run()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else activeCalls--
  }
}

export function resolveSummaryChain(settings: Settings): readonly ResolvedSummaryModel[] {
  const selected = settings.contextAwareness.summaryModel ?? settings.defaultModel
  if (!selected) return []
  const refs = [
    selected,
    ...settings.providers.flatMap((provider) =>
      provider.models.map((modelId) => ({ provider: provider.id, modelId })),
    ),
  ]
  const seen = new Set<string>()
  return refs.flatMap((ref) => {
    const key = `${ref.provider}\u0000${ref.modelId}`
    if (seen.has(key)) return []
    seen.add(key)
    const provider = settings.providers.find((item) => item.id === ref.provider)
    if (!provider) return []
    if (
      (provider.kind === "claude-code-cli" || provider.kind === "codex-cli") &&
      !provider.models.includes(ref.modelId)
    )
      return []
    const override = settings.summary.modelOverrides.find((item) =>
      new RegExp(item.match).test(ref.modelId),
    )
    return [
      {
        provider,
        modelId: ref.modelId,
        ...(override
          ? { reasoningEffort: override.reasoningEffort, fastMode: override.fastMode }
          : {}),
      },
    ]
  })
}

function firstJsonObject(content: string): unknown | undefined {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let end = start; end < content.length; end++) {
      const char = content[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        try {
          const parsed: unknown = JSON.parse(content.slice(start, end + 1))
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
        break
      }
    }
  }
  return undefined
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ("code" in error && (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused")) {
    return true
  }
  if (/ECONNREFUSED|connection refused/i.test(error.message)) return true
  return "cause" in error && error.cause !== error && isConnectionRefused(error.cause)
}

function shouldFallback(status: number): boolean {
  return (
    status >= 500 ||
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429
  )
}

export async function callSummaryCompletion(
  model: ResolvedSummaryModel,
  messages: readonly SummaryMessage[],
  options: Pick<SummaryOptions, "getApiKey" | "log"> & {
    readonly canSendEvidence?: () => boolean
    readonly canSendRequest?: () => boolean
    readonly queueWaitTimeoutMs?: number
  },
): Promise<{
  readonly argumentsValue: unknown
  readonly toolCallObserved: boolean
  readonly inputTokens: number
  readonly outputTokens: number
}> {
  const provider = model.provider
  if (provider.kind === "claude-code-cli") {
    return withCallSlot(async () => {
      if (options.canSendRequest && !options.canSendRequest()) throw new ProviderFallbackError()
      const started = performance.now()
      const requestBytes = Buffer.byteLength(
        messages.map((message) => message.content).join("\n\n"),
      )
      try {
        const response = await callClaudeCliSummary(
          messages,
          model.modelId,
          options.canSendEvidence ?? (() => true),
        )
        options.log?.({
          provider: provider.id,
          modelId: model.modelId,
          durationMs: performance.now() - started,
          requestBytes,
          responseBytes: response.responseBytes,
        })
        return { ...response, toolCallObserved: false }
      } catch (error) {
        options.log?.({
          provider: provider.id,
          modelId: model.modelId,
          durationMs: performance.now() - started,
          requestBytes,
          responseBytes: 0,
        })
        if (error instanceof ClaudeCliConsentRevokedError)
          throw new EvidencePermissionRevokedError()
        if (error instanceof ClaudeCliUnavailableError) throw new ProviderFallbackError()
        throw error
      }
    }, options.queueWaitTimeoutMs)
  }
  if (provider.kind === "codex-cli") {
    return withCallSlot(async () => {
      if (options.canSendRequest && !options.canSendRequest()) throw new ProviderFallbackError()
      const started = performance.now()
      const requestBytes = Buffer.byteLength(
        messages.map((message) => message.content).join("\n\n"),
      )
      try {
        const response = await callCodexCliSummary(
          messages,
          model.modelId,
          options.canSendEvidence ?? (() => true),
        )
        options.log?.({
          provider: provider.id,
          modelId: model.modelId,
          durationMs: performance.now() - started,
          requestBytes,
          responseBytes: response.responseBytes,
        })
        return { ...response, toolCallObserved: false }
      } catch (error) {
        options.log?.({
          provider: provider.id,
          modelId: model.modelId,
          durationMs: performance.now() - started,
          requestBytes,
          responseBytes: 0,
        })
        if (error instanceof CodexCliConsentRevokedError) throw new EvidencePermissionRevokedError()
        if (error instanceof CodexCliUnavailableError) throw new ProviderFallbackError()
        throw error
      }
    }, options.queueWaitTimeoutMs)
  }
  return withCallSlot(async () => {
    if (options.canSendRequest && !options.canSendRequest()) throw new ProviderFallbackError()
    const { modelId, reasoningEffort } = model
    let key: string | undefined
    try {
      key = provider.apiKeyRef ? await options.getApiKey?.(provider.apiKeyRef) : undefined
    } catch (error) {
      if (
        error instanceof HelperCommandFailureError ||
        error instanceof HelperCommandTimeoutError ||
        error instanceof HelperUnavailableError
      )
        throw new ProviderFallbackError()
      throw error
    }
    if (provider.apiKeyRef && !key) throw new ProviderFallbackError()
    const body = JSON.stringify({
      model: modelId,
      messages,
      tools: [{ type: "function", function: RecordSummaryTool }],
      tool_choice: provider.supportsToolChoice
        ? { type: "function", function: { name: RecordSummaryTool.name } }
        : "auto",
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: SUMMARY_TEMPERATURE,
    })
    const requestBytes = Buffer.byteLength(body, "utf8")
    const started = performance.now()
    const signal = AbortSignal.timeout(SUMMARY_PROVIDER_TIMEOUT_MS)
    let response: Response
    let responseText: string
    if (options.canSendEvidence && !options.canSendEvidence()) {
      throw new EvidencePermissionRevokedError()
    }
    if (options.canSendRequest && !options.canSendRequest()) throw new ProviderFallbackError()
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body,
        signal,
        redirect: "manual",
      })
      responseText = await response.text()
    } catch (error) {
      options.log?.({
        provider: provider.id,
        modelId,
        durationMs: performance.now() - started,
        requestBytes,
        responseBytes: 0,
      })
      if (signal.aborted || isConnectionRefused(error)) throw new ProviderFallbackError()
      throw error
    }
    options.log?.({
      provider: provider.id,
      modelId,
      status: response.status,
      durationMs: performance.now() - started,
      requestBytes,
      responseBytes: Buffer.byteLength(responseText, "utf8"),
    })
    if (!response.ok) {
      if (shouldFallback(response.status)) throw new ProviderFallbackError()
      throw new ProviderRequestError(response.status)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(responseText)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new ProviderFallbackError()
    }
    const completion = CompletionSchema.safeParse(decoded)
    if (!completion.success) throw new ProviderFallbackError()
    const message = completion.data.choices[0]?.message
    const calls = message?.tool_calls ?? []
    const argumentsValue =
      calls.length > 0
        ? calls.length === 1 && calls[0]?.function.name === RecordSummaryTool.name
          ? calls[0].function.arguments
          : undefined
        : typeof message?.content === "string"
          ? firstJsonObject(message.content)
          : undefined
    if (argumentsValue === undefined) throw new ProviderFallbackError()
    return {
      argumentsValue,
      toolCallObserved: calls.length === 1 && calls[0]?.function.name === RecordSummaryTool.name,
      inputTokens: completion.data.usage?.prompt_tokens ?? 0,
      outputTokens: completion.data.usage?.completion_tokens ?? 0,
    }
  }, options.queueWaitTimeoutMs)
}

export async function summarizeBriefing(options: SummaryOptions): Promise<SummaryResult> {
  const selected = options.settings.contextAwareness.summaryModel ?? options.settings.defaultModel
  if (!selected) return { state: "no-summary-model" }
  for (const model of resolveSummaryChain(options.settings)) {
    if (!model.provider.allowEvidence) continue
    const canSendEvidence = (): boolean => {
      const current = options.getCurrentSettings?.() ?? options.settings
      const provider = current.providers.find((item) => item.id === model.provider.id)
      if (!current.contextAwareness.enabled || provider?.allowEvidence !== true) return false
      if (model.provider.kind === "claude-code-cli" || model.provider.kind === "codex-cli")
        return provider.kind === model.provider.kind && provider.models.includes(model.modelId)
      return (
        provider.kind !== "claude-code-cli" &&
        provider.kind !== "codex-cli" &&
        provider.baseUrl === model.provider.baseUrl &&
        provider.apiKeyRef === model.provider.apiKeyRef
      )
    }
    let inputTokens = 0
    let outputTokens = 0
    const started = performance.now()
    try {
      const summary = await runSummaryWithOneRepair(options.briefing, async (messages) => {
        const response = await callSummaryCompletion(model, messages, {
          ...options,
          canSendEvidence,
        })
        inputTokens += response.inputTokens
        outputTokens += response.outputTokens
        return response.argumentsValue
      })
      if (!canSendEvidence()) throw new EvidencePermissionRevokedError()
      return {
        state: "done",
        summary,
        model: `${model.provider.id}/${model.modelId}`,
        inputTokens,
        outputTokens,
        durationMs: performance.now() - started,
      }
    } catch (error) {
      if (error instanceof ProviderFallbackError) continue
      throw error
    }
  }
  throw new AllProvidersFailedError()
}
