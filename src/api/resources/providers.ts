import { createHash } from "node:crypto"
import { z } from "zod"
import { validateRecordSummary } from "../../comprehension/contract"
import type { SummaryMessage } from "../../comprehension/prompt"
import { callSummaryCompletion, ProviderRequestError } from "../../comprehension/providers"
import { saveSettings } from "../../config/index"
import { SUMMARY_CALL_SLOT_WAIT_MS, SUMMARY_PROVIDER_TIMEOUT_MS } from "../../constants"
import { RpcMethods } from "../../contracts/rpc"
import type { Settings } from "../../contracts/settings"
import type { HelperClient } from "../../helper/client"
import type { RpcHandlers } from "../rpc"
import { createSettingsMutation, type SettingsMutation } from "./settings"

type ProviderReconciler = {
  readonly currentSettings: Settings
  settingsPatched(next: Settings): Promise<void>
}

type ProviderDependencies = {
  readonly directory: string
  readonly reconciler: ProviderReconciler
  readonly helper: Pick<HelperClient, "sendCommand">
  readonly mutateSettings?: SettingsMutation
}

const KeychainSetResultSchema = z.strictObject({ ref: z.string() })
const ModelListResponseSchema = z.object({ data: z.array(z.object({ id: z.string() })) })
const ProbeMessages = [
  {
    role: "system",
    content:
      "This is a provider connection test. Call record_summary exactly once. No real user activity or evidence is supplied.",
  },
  {
    role: "user",
    content:
      "Summarize a fictional empty activity window. Use empty apps, domains, citations, and sourceIds.",
  },
] as const satisfies readonly SummaryMessage[]
const EmptyBriefing = {
  text: "",
  evidenceIds: new Set<string>(),
  apps: new Set<string>(),
  domains: new Set<string>(),
}

function latencyMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

function uniqueProvider(current: Settings, id: string): Settings["providers"][number] | undefined {
  const matches = current.providers.filter((item) => item.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

function providerStillCurrent(
  current: Settings,
  original: Settings["providers"][number],
  modelId?: string,
): boolean {
  const provider = uniqueProvider(current, original.id)
  if (!provider || (modelId !== undefined && !provider.models.includes(modelId))) return false
  if (original.kind === "claude-code-cli") return provider.kind === "claude-code-cli"
  return (
    provider.kind !== "claude-code-cli" &&
    provider.baseUrl === original.baseUrl &&
    provider.apiKeyRef === original.apiKeyRef
  )
}

export function createProviderHandlers(
  dependencies: ProviderDependencies,
): Pick<RpcHandlers, "providers.setKey" | "providers.listModels" | "providers.test"> {
  const mutateSettings =
    dependencies.mutateSettings ??
    createSettingsMutation(dependencies.reconciler, (next) =>
      saveSettings(dependencies.directory, next),
    )
  const keyVersions = new Map<string, number>()
  const keyVersion = (id: string) => keyVersions.get(id) ?? 0
  return {
    "providers.setKey": async (value) => {
      const { providerId, apiKey } = RpcMethods["providers.setKey"].input.parse(value)
      const current = dependencies.reconciler.currentSettings
      const provider = uniqueProvider(current, providerId)
      if (!provider || provider.kind === "claude-code-cli" || apiKey.length === 0)
        throw new TypeError("Invalid provider key request")

      keyVersions.set(providerId, keyVersion(providerId) + 1)
      const endpointHash = createHash("sha256")
        .update(JSON.stringify([provider.id, provider.baseUrl]))
        .digest("hex")
      const ref = provider.apiKeyRef || `provider/${provider.id}/${endpointHash}`
      const saved = KeychainSetResultSchema.parse(
        await dependencies.helper.sendCommand({
          type: "command",
          name: "keychain.set",
          args: { ref, secret: apiKey },
        }),
      )
      if (saved.ref !== ref) throw new TypeError("Keychain returned a different reference")

      await mutateSettings((latest) => {
        const latestProvider = uniqueProvider(latest, providerId)
        if (
          !latestProvider ||
          latestProvider.kind === "claude-code-cli" ||
          latestProvider.baseUrl !== provider.baseUrl
        )
          throw new TypeError("Provider changed before its key could be linked")
        return {
          ...latest,
          providers: latest.providers.map((item) =>
            item.id === providerId && item.kind !== "claude-code-cli"
              ? { ...item, apiKeyRef: ref }
              : item,
          ),
        }
      })
      return { apiKeyRef: ref }
    },
    "providers.listModels": async (value) => {
      const { providerId } = RpcMethods["providers.listModels"].input.parse(value)
      const provider = uniqueProvider(dependencies.reconciler.currentSettings, providerId)
      if (!provider) return { status: "unavailable", models: [], reason: "provider-not-found" }
      if (provider.kind === "claude-code-cli")
        return { status: "unavailable", models: [], reason: "endpoint-unavailable" }
      if (!provider.apiKeyRef)
        return { status: "unavailable", models: [], reason: "key-not-configured" }
      const version = keyVersion(providerId)

      const endpoint = new URL(provider.baseUrl)
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        return { status: "unavailable", models: [], reason: "invalid-base-url" }
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/models`
      endpoint.search = ""
      endpoint.hash = ""

      let key: string | undefined
      try {
        const value = await dependencies.helper.sendCommand({
          type: "command",
          name: "keychain.get",
          args: { ref: provider.apiKeyRef },
        })
        key = typeof value === "string" && value.length > 0 ? value : undefined
      } catch {
        // no-excuse-ok: catch -- only a fixed status crosses this RPC boundary.
        return { status: "unavailable", models: [], reason: "key-unavailable" }
      }
      if (!key) return { status: "unavailable", models: [], reason: "key-unavailable" }
      if (
        !providerStillCurrent(dependencies.reconciler.currentSettings, provider) ||
        keyVersion(providerId) !== version
      )
        return { status: "unavailable", models: [], reason: "provider-not-found" }

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          redirect: "manual",
          signal: AbortSignal.timeout(SUMMARY_PROVIDER_TIMEOUT_MS),
        })
      } catch {
        // no-excuse-ok: catch -- network and timeout details may contain credentials.
        return { status: "unavailable", models: [], reason: "request-failed" }
      }
      if (response.status >= 300 && response.status < 400)
        return {
          status: "unavailable",
          models: [],
          reason: "redirect-blocked",
          httpStatus: response.status,
        }
      if (!response.ok)
        return {
          status: "unavailable",
          models: [],
          reason:
            response.status === 404 || response.status === 405
              ? "endpoint-unavailable"
              : "http-error",
          httpStatus: response.status,
        }

      let decoded: unknown
      try {
        decoded = await response.json()
      } catch {
        // no-excuse-ok: catch -- malformed upstream bodies are never returned.
        return { status: "unavailable", models: [], reason: "invalid-response" }
      }
      const parsed = ModelListResponseSchema.safeParse(decoded)
      if (!parsed.success) return { status: "unavailable", models: [], reason: "invalid-response" }
      const models = [...new Set(parsed.data.data.map((item) => item.id.trim()).filter(Boolean))]
      return { status: "available", models }
    },
    "providers.test": async (value) => {
      const { providerId, modelId } = RpcMethods["providers.test"].input.parse(value)
      const provider = uniqueProvider(dependencies.reconciler.currentSettings, providerId)
      if (!provider?.models.includes(modelId)) {
        return {
          ok: false,
          latencyMs: 0,
          toolChoiceSupported: false,
          error: "Provider or model is not configured",
        }
      }

      const version = keyVersion(providerId)
      const started = performance.now()
      let status: number | undefined
      try {
        const completion = await callSummaryCompletion({ provider, modelId }, ProbeMessages, {
          queueWaitTimeoutMs: SUMMARY_CALL_SLOT_WAIT_MS,
          canSendRequest: () =>
            providerStillCurrent(dependencies.reconciler.currentSettings, provider, modelId) &&
            keyVersion(providerId) === version,
          getApiKey: async (ref) => {
            const secret = await dependencies.helper.sendCommand({
              type: "command",
              name: "keychain.get",
              args: { ref },
            })
            return typeof secret === "string" ? secret : undefined
          },
          log: (entry) => {
            status = entry.status
          },
        })
        const validated = validateRecordSummary(completion.argumentsValue, EmptyBriefing)
        if (!validated.ok) {
          return {
            ok: false,
            latencyMs: latencyMs(started),
            toolChoiceSupported: false,
            error: "record_summary response failed validation",
          }
        }
        return {
          ok: true,
          latencyMs: latencyMs(started),
          toolChoiceSupported:
            provider.kind !== "claude-code-cli" &&
            provider.supportsToolChoice &&
            completion.toolCallObserved,
        }
      } catch (error) {
        const httpStatus = error instanceof ProviderRequestError ? error.status : status
        return {
          ok: false,
          latencyMs: latencyMs(started),
          toolChoiceSupported: false,
          error: httpStatus && httpStatus >= 400 ? `HTTP ${httpStatus}` : "Provider test failed",
        }
      }
    },
  }
}
