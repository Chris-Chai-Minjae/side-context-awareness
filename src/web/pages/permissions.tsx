import { useEffect, useRef, useState } from "preact/hooks"
import { z } from "zod"
import {
  PermissionsSchema,
  ProviderKeyAuthorizationSchema,
  ProviderModelListSchema,
} from "../../contracts/rpc-resources"
import { t, type UiCopy, type UiLanguage } from "../i18n"
import type { RpcClient } from "../rpc-client"

const PageStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["starting", "running", "paused", "stopped"]),
  banner: z.enum(["none", "starting", "not_running", "permissions_needed", "some_unavailable"]),
  stop_reason: z.string().nullable().optional(),
  health: z.object({
    nativeCaptureAvailable: z.boolean(),
    inputCaptureAvailable: z.boolean().optional(),
    screenOcrAvailable: z.boolean().optional(),
    eventTapHealthy: z.boolean().optional(),
    pid: z.number().optional(),
    observerRegistrationFailures: z.number().int().optional(),
  }),
})
const PageSettingsSchema = z.object({
  screen_ocr: z.boolean(),
  providers: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["openai-compatible", "claude-code-cli", "codex-cli"]),
      has_key: z.boolean(),
    }),
  ),
})

const osPermissions = [
  {
    kind: "accessibility",
    field: "accessibility",
    label: "Accessibility",
    pane: "Privacy_Accessibility",
    guide: "https://support.apple.com/guide/mac-help/mh43185/mac",
  },
  {
    kind: "inputMonitoring",
    field: "input_monitoring",
    label: "Input Monitoring",
    pane: "Privacy_ListenEvent",
    guide: "https://support.apple.com/guide/mac-help/mchl4cedafb6/mac",
  },
  {
    kind: "screenRecording",
    field: "screen_recording",
    label: "Screen Recording",
    pane: "Privacy_ScreenCapture",
    guide: "https://support.apple.com/guide/mac-help/mchld6aa7d23/mac",
  },
] as const

type PageData = {
  readonly permissions: z.infer<typeof PermissionsSchema>
  readonly status: z.infer<typeof PageStatusSchema>
  readonly settings: z.infer<typeof PageSettingsSchema>
}
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: PageData }
type Verification =
  | { readonly kind: "checking" }
  | { readonly kind: "result"; readonly value: z.infer<typeof ProviderModelListSchema> }
  | { readonly kind: "error" }

const unavailableCopy = {
  "provider-not-found": "Provider no longer configured",
  "key-not-configured": "Key not configured",
  "key-unavailable": "Key unavailable",
  "invalid-base-url": "Invalid provider URL",
  "redirect-blocked": "Model list redirect blocked",
  "endpoint-unavailable": "Model list unavailable",
  "http-error": "Provider rejected model list",
  "invalid-response": "Invalid model list response",
  "request-failed": "Could not reach model list",
} as const satisfies Record<
  Extract<z.infer<typeof ProviderModelListSchema>, { status: "unavailable" }>["reason"],
  UiCopy
>

async function loadData(rpc: RpcClient): Promise<PageData> {
  const [permissions, status, settings] = await Promise.all([
    rpc.call("permissions"),
    rpc.call("status"),
    rpc.call("settings.get"),
  ])
  const parsedSettings = PageSettingsSchema.parse(settings)
  return {
    permissions: PermissionsSchema.parse(permissions),
    status: PageStatusSchema.parse(status),
    settings: parsedSettings,
  }
}

interface PermissionsPageProps {
  readonly rpc: RpcClient
  readonly language: UiLanguage
}

export function PermissionsPage({ rpc, language }: PermissionsPageProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [authorizedKeys, setAuthorizedKeys] = useState<Readonly<Record<string, true>>>({})
  const [verifications, setVerifications] = useState<Readonly<Record<string, Verification>>>({})
  const pageGeneration = useRef(0)

  useEffect(() => {
    let active = true
    pageGeneration.current += 1
    setLoad({ kind: "loading" })
    setAuthorizedKeys({})
    setVerifications({})
    loadData(rpc).then(
      (data) => {
        if (active) setLoad({ kind: "ready", data })
      },
      () => {
        if (active) setLoad({ kind: "error" })
      },
    )
    return () => {
      active = false
    }
  }, [rpc, reload])

  async function request(kind: (typeof osPermissions)[number]["kind"] | "automation") {
    const generation = ++pageGeneration.current
    setBusy(kind)
    setNotice("")
    setAuthorizedKeys({})
    setVerifications({})
    try {
      await rpc.call("requestPermissions", { kinds: [kind] })
      const data = await loadData(rpc)
      if (generation === pageGeneration.current) setLoad({ kind: "ready", data })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (generation === pageGeneration.current)
        setNotice(t(language, "Could not request permission. Refresh and check System Settings."))
    } finally {
      setBusy(null)
    }
  }

  async function verify(providerId: string) {
    const generation = pageGeneration.current
    setVerifications((current) => ({ ...current, [providerId]: { kind: "checking" } }))
    try {
      const value = ProviderModelListSchema.parse(
        await rpc.call("providers.listModels", { providerId }),
      )
      if (generation === pageGeneration.current) {
        if (value.status === "unavailable" && value.reason === "key-unavailable")
          setAuthorizedKeys((current) => {
            const next = { ...current }
            delete next[providerId]
            return next
          })
        setVerifications((current) => ({ ...current, [providerId]: { kind: "result", value } }))
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (generation === pageGeneration.current)
        setVerifications((current) => ({ ...current, [providerId]: { kind: "error" } }))
    }
  }

  async function authorize(providerId: string) {
    const generation = pageGeneration.current
    setBusy(providerId)
    setNotice("")
    try {
      const result = ProviderKeyAuthorizationSchema.parse(
        await rpc.call("providers.authorizeKey", { providerId }),
      )
      if (generation !== pageGeneration.current) return
      if (!result.authorized) {
        setNotice(t(language, "Keychain access was not granted."))
        return
      }
      setAuthorizedKeys((current) => ({ ...current, [providerId]: true }))
      setVerifications((current) => {
        const next = { ...current }
        delete next[providerId]
        return next
      })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      if (generation === pageGeneration.current)
        setNotice(t(language, "Could not authorize Keychain access."))
    } finally {
      setBusy(null)
    }
  }

  if (load.kind === "loading")
    return (
      <p role="status" class="state-message">
        {t(language, "Loading…")}
      </p>
    )
  if (load.kind === "error")
    return (
      <div role="alert" class="state-message">
        <p>{t(language, "Could not load permissions.")}</p>
        <button
          type="button"
          class="button button-secondary"
          onClick={() => setReload((n) => n + 1)}
        >
          {t(language, "Retry")}
        </button>
      </div>
    )

  const { permissions, status, settings } = load.data
  const automation = Object.entries(permissions.automation).sort(([a], [b]) => a.localeCompare(b))
  const automationAllAllowed = automation.length > 0 && automation.every(([, allowed]) => allowed)
  const helperConnected = (status.health.pid ?? 0) > 0
  const captureState = !status.enabled
    ? "Capture disabled"
    : status.state === "running"
      ? "Capture running"
      : status.state === "paused"
        ? "Capture paused"
        : "Capture not running"

  return (
    <div class="permissions-page content-stack">
      <div>
        <h1>{t(language, "Permissions")}</h1>
        <p class="settings-intro">
          {t(language, "Review each permission and connection separately.")}
        </p>
        <button
          type="button"
          class="button button-secondary permissions-action"
          onClick={() => setReload((n) => n + 1)}
        >
          {t(language, "Refresh statuses")}
        </button>
      </div>
      <section class="settings-section" aria-labelledby="helper-heading">
        <h2 id="helper-heading">{t(language, "Capture and helper")}</h2>
        <div class="permission-row">
          <strong>{t(language, captureState)}</strong>
          <span>{t(language, helperConnected ? "Helper connected" : "Helper not running")}</span>
        </div>
        {status.banner === "some_unavailable" && (
          <>
            <p class="supporting-text">{t(language, "Some capture features are unavailable")}</p>
            {status.health.eventTapHealthy === false && (
              <p class="supporting-text">{t(language, "Input event tap unhealthy")}</p>
            )}
            {status.health.inputCaptureAvailable === false && (
              <p class="supporting-text">{t(language, "Input capture unavailable")}</p>
            )}
            {settings.screen_ocr && status.health.screenOcrAvailable === false && (
              <p class="supporting-text">{t(language, "Screen OCR unavailable")}</p>
            )}
          </>
        )}
        {helperConnected && !status.health.nativeCaptureAvailable && (
          <p class="supporting-text">{t(language, "Native capture unavailable")}</p>
        )}
        {(status.health.observerRegistrationFailures ?? 0) > 0 && (
          <p class="supporting-text">
            {t(
              language,
              "Capture observer registration failed. Some activity may be unavailable even when macOS permissions are allowed.",
            )}
          </p>
        )}
        <p class="supporting-text">
          {t(language, "Capture being off does not tell you whether macOS granted a permission.")}
        </p>
      </section>
      <section class="settings-section" aria-labelledby="macos-heading">
        <h2 id="macos-heading">{t(language, "macOS permissions")}</h2>
        {osPermissions.map(({ kind, field, label, pane, guide }) => (
          <div class="permission-row" data-permission={kind} key={kind}>
            <div>
              <strong>{t(language, label)}</strong>
              <span class="setting-meta">
                {t(language, permissions[field] ? "Allowed" : "Not allowed")}
              </span>
              <span class="setting-meta">
                {t(language, "System Settings → Privacy & Security →")} {t(language, label)}
              </span>
            </div>
            <div class="permission-controls">
              <button
                type="button"
                class="button button-secondary"
                disabled={
                  permissions[field] ||
                  busy !== null ||
                  (kind === "screenRecording" && !settings.screen_ocr)
                }
                onClick={() => void request(kind)}
              >
                {t(language, permissions[field] ? "Permission granted" : "Request permission")}
              </button>
              {kind === "screenRecording" && !settings.screen_ocr && (
                <span class="setting-meta">
                  {t(language, "Enable OCR in Settings before requesting access.")}
                </span>
              )}
              <a
                class="permissions-link"
                href={`x-apple.systempreferences:com.apple.preference.security?${pane}`}
              >
                {t(language, "Open System Settings")}
              </a>
              <a class="permissions-link" href={guide}>
                {t(language, "View Apple guide")}
              </a>
            </div>
          </div>
        ))}
        <p class="supporting-text">
          {t(
            language,
            "Check Privacy & Security in macOS System Settings after requesting access. You may need to restart Side.",
          )}
        </p>
      </section>
      <section class="settings-section" aria-labelledby="automation-heading">
        <h2 id="automation-heading">{t(language, "Browser Automation")}</h2>
        {automation.length === 0 ? (
          <p class="supporting-text">
            {t(language, "No browser target is available for an Automation request.")}
          </p>
        ) : (
          automation.map(([bundleId, allowed]) => (
            <div class="permission-row" data-automation={bundleId} key={bundleId}>
              <strong>{bundleId}</strong>
              <span>{t(language, allowed ? "Allowed" : "Not allowed")}</span>
            </div>
          ))
        )}
        <button
          type="button"
          class="button button-secondary permissions-action"
          disabled={busy !== null || automation.length === 0 || automationAllAllowed}
          onClick={() => void request("automation")}
        >
          {t(language, automationAllAllowed ? "Already allowed" : "Request Automation")}
        </button>
        <p class="supporting-text">
          {t(language, "Automation access is shown only for browsers the helper has reported.")}
        </p>
        <a
          class="permissions-link"
          href="https://support.apple.com/guide/mac-help/mchl07817563/mac"
        >
          {t(language, "View Apple guide")}
        </a>
      </section>
      <section class="settings-section" aria-labelledby="providers-heading">
        <h2 id="providers-heading">{t(language, "Model providers")}</h2>
        {settings.providers.length === 0 ? (
          <p class="supporting-text">{t(language, "No model providers added.")}</p>
        ) : (
          settings.providers.map((provider) => {
            const keyAuthorized = authorizedKeys[provider.id] === true
            const verification = verifications[provider.id]
            const result = verification?.kind === "result" ? verification.value : null
            const state =
              verification?.kind === "checking"
                ? "Checking…"
                : verification?.kind === "error"
                  ? "Connection check failed"
                  : result?.status === "available"
                    ? "Available"
                    : result?.status === "unavailable"
                      ? unavailableCopy[result.reason]
                      : "Not checked yet"
            return (
              <div class="permission-row" data-provider={provider.id} key={provider.id}>
                <div>
                  <strong>{provider.id}</strong>
                  <span class="setting-meta">
                    {t(
                      language,
                      provider.kind === "claude-code-cli" || provider.kind === "codex-cli"
                        ? provider.kind === "codex-cli"
                          ? "OpenAI (Codex login)"
                          : "Claude Code login"
                        : provider.has_key
                          ? "Key reference configured"
                          : "Key not configured",
                    )}
                  </span>
                  {provider.kind === "openai-compatible" && provider.has_key && (
                    <span class="setting-meta">
                      {t(
                        language,
                        keyAuthorized ? "Keychain accessible" : "Keychain access not checked",
                      )}
                    </span>
                  )}
                  <span class="setting-meta" role="status">
                    {t(language, state)}
                  </span>
                </div>
                <div class="permission-controls">
                  {provider.kind === "openai-compatible" && provider.has_key && !keyAuthorized && (
                    <button
                      type="button"
                      class="button button-secondary"
                      data-action="authorize-key"
                      disabled={busy !== null}
                      onClick={() => void authorize(provider.id)}
                    >
                      {t(language, "Authorize Keychain")}
                    </button>
                  )}
                  <button
                    type="button"
                    class="button button-secondary"
                    data-action="verify-connection"
                    disabled={
                      verification?.kind === "checking" ||
                      (provider.kind === "openai-compatible" && provider.has_key && !keyAuthorized)
                    }
                    onClick={() => void verify(provider.id)}
                  >
                    {t(language, "Verify connection")}
                  </button>
                </div>
              </div>
            )
          })
        )}
        <p class="supporting-text">
          {t(
            language,
            "Verification requests the model list without generating text. A provider may not expose this endpoint.",
          )}
        </p>
        <a class="permissions-link" href="#/settings/context-awareness">
          {t(language, "Manage providers in Settings")}
        </a>
      </section>
      {notice && (
        <p role="alert" class="state-message">
          {notice}
        </p>
      )}
    </div>
  )
}
