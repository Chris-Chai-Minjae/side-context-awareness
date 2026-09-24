import { render } from "preact"
import { useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks"
import { z } from "zod"
import { UiLanguageSchema } from "../contracts/settings"
import { ConfirmDialog } from "./components/confirm-dialog"
import { PauseControl } from "./components/pause-control"
import { PermissionBanner } from "./components/permission-banner"
import { UntrustedTextView } from "./components/untrusted-text-view"
import { t, type UiLanguage } from "./i18n"
import { DayViewPage } from "./pages/day-view"
import { SettingsPage } from "./pages/settings"
import type { DemoState, Route } from "./router"
import { useHashRoute } from "./router"
import type { FetchLike, RpcClient } from "./rpc-client"
import { createRpcClient, RpcError, readInjectedToken } from "./rpc-client"

const ShellStatusSchema = z.object({
  banner: z.enum(["none", "starting", "not_running", "permissions_needed", "some_unavailable"]),
  paused_until: z.number().nullable(),
  today: z.object({ events: z.number().int().nonnegative() }),
})

type ShellStatus = z.infer<typeof ShellStatusSchema>
type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly status: ShellStatus }

function createDemoRpcClient(state: DemoState): RpcClient {
  let pausedUntil: number | null = null
  let banner: ShellStatus["banner"] =
    state === "normal" || state === "empty" ? "permissions_needed" : "none"
  return {
    async call(method, params) {
      if (state === "loading") return new Promise<unknown>(() => {})
      if (state === "error") throw new RpcError("Demo status unavailable")
      if (method === "pause") {
        const pause = z
          .union([z.object({ until: z.number() }), z.object({ durationMs: z.number() })])
          .parse(params)
        pausedUntil = "until" in pause ? pause.until : Date.now() + pause.durationMs
        return { paused_until: pausedUntil }
      }
      if (method === "resume") {
        pausedUntil = null
        return null
      }
      if (method === "requestPermissions") {
        banner = "none"
        return null
      }
      if (method === "status") {
        return { banner, paused_until: pausedUntil, today: { events: state === "empty" ? 0 : 12 } }
      }
      throw new RpcError("Unsupported demo method")
    },
  }
}

function routeTitle(route: Route, language: UiLanguage): string {
  switch (route.kind) {
    case "settings":
      return t(language, "Settings")
    case "history":
      return `${t(language, "History")} · ${route.date}`
    case "demo":
      return t(language, "Shared components")
    case "settings-demo":
      return t(language, "Context Awareness demo")
    case "day-demo":
      return t(language, "Day view demo")
    case "not-found":
      return t(language, "Page not found")
  }
}

interface AppProps {
  readonly browser: Window
  readonly rpc: RpcClient
}

function App({ browser, rpc }: AppProps) {
  const route = useHashRoute(browser)
  const demoState = route.kind === "demo" ? route.state : null
  const settingsRoute = route.kind === "settings" || route.kind === "settings-demo"
  const dayRoute = route.kind === "history" || route.kind === "day-demo"
  const client = useMemo(() => (demoState ? createDemoRpcClient(demoState) : rpc), [demoState, rpc])
  const [load, setLoad] = useState<LoadState>({ kind: "loading" })
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [language, setLanguage] = useState<UiLanguage>("ko")
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = browser.localStorage.getItem("side.theme")
    if (saved === "light" || saved === "dark") return saved
    return browser.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  })

  useEffect(() => {
    if (
      route.kind === "settings" ||
      route.kind === "settings-demo" ||
      route.kind === "demo" ||
      route.kind === "day-demo"
    )
      return
    let active = true
    rpc.call("settings.get").then(
      (value) => {
        const choice = z.object({ ui_language: UiLanguageSchema }).parse(value).ui_language
        if (active) setLanguage(choice)
      },
      () => {
        if (active) setLanguage("ko")
      },
    )
    return () => {
      active = false
    }
  }, [route.kind, rpc])

  useLayoutEffect(() => {
    browser.document.documentElement.lang = language
    browser.document.title = `Side · ${routeTitle(route, language)}`
  }, [browser, language, route])

  useEffect(() => {
    if (settingsRoute || dayRoute) return
    let active = true
    setLoad({ kind: "loading" })
    client
      .call("status")
      .then((value) => ShellStatusSchema.parse(value))
      .then(
        (status) => {
          if (active) setLoad({ kind: "ready", status })
        },
        () => {
          if (active) setLoad({ kind: "error" })
        },
      )
    return () => {
      active = false
    }
  }, [client, dayRoute, reload, settingsRoute])

  function run(method: "pause" | "resume" | "requestPermissions", params?: unknown) {
    setBusy(true)
    client
      .call(method, params)
      .then(
        () => setReload((value) => value + 1),
        () => setLoad({ kind: "error" }),
      )
      .finally(() => setBusy(false))
  }

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light"
    browser.localStorage.setItem("side.theme", next)
    setTheme(next)
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())

  return (
    <div class="app-shell" data-theme={theme}>
      <header class="app-header">
        <span class="brand">Side</span>
        <nav aria-label={t(language, "Main navigation")} class="nav-links">
          <a href="#/settings/context-awareness" aria-current={settingsRoute ? "page" : undefined}>
            {t(language, "Settings")}
          </a>
          <a
            href={`#/history/${today}`}
            aria-current={route.kind === "history" ? "page" : undefined}
          >
            {t(language, "History")}
          </a>
        </nav>
        <button type="button" class="button button-secondary theme-button" onClick={toggleTheme}>
          {t(language, theme === "light" ? "Dark theme" : "Light theme")}
        </button>
      </header>
      <main class="app-main">
        <div class={dayRoute ? "content content-day" : "content"}>
          {settingsRoute ? (
            <SettingsPage
              rpc={rpc}
              browser={browser}
              language={language}
              onLanguageChange={setLanguage}
              {...(route.kind === "settings-demo" ? { demoState: route.state } : {})}
            />
          ) : dayRoute ? (
            <DayViewPage
              key={route.kind === "history" ? route.date : route.state}
              browser={browser}
              rpc={rpc}
              date={route.kind === "history" ? route.date : today}
              language={language}
              {...(route.kind === "day-demo" ? { demoState: route.state } : {})}
            />
          ) : (
            <h1>{routeTitle(route, language)}</h1>
          )}
          {settingsRoute || dayRoute ? null : route.kind === "not-found" ? (
            <p>{t(language, "The requested page could not be found.")}</p>
          ) : load.kind === "loading" ? (
            <p role="status" class="state-message">
              {t(language, "Loading…")}
            </p>
          ) : load.kind === "error" ? (
            <div role="alert" class="state-message">
              <p>{t(language, "Could not load capture status.")}</p>
              <button
                type="button"
                class="button button-secondary"
                onClick={() => setReload((value) => value + 1)}
              >
                {t(language, "Retry")}
              </button>
            </div>
          ) : (
            <div class="content-stack">
              <PermissionBanner
                language={language}
                banner={load.status.banner}
                busy={busy}
                onAllow={() => run("requestPermissions")}
              />
              <section class="status-panel" aria-label={t(language, "Capture status")}>
                <div class="status-row">
                  <span>{t(language, "Captured today")}</span>
                  <strong>{load.status.today.events}</strong>
                </div>
                <PauseControl
                  language={language}
                  pausedUntil={load.status.paused_until}
                  busy={busy}
                  onPause={(value) => run("pause", value)}
                  onResume={() => run("resume")}
                />
              </section>
              {load.status.today.events === 0 && (
                <p class="state-message">{t(language, "No activity yet.")}</p>
              )}
              {route.kind === "demo" && (
                <section class="showcase" aria-label={t(language, "Shared component preview")}>
                  <h2>{t(language, "Evidence text")}</h2>
                  <UntrustedTextView
                    language={language}
                    text={'<script>alert("sample")</script> sqlite notes'}
                    match="sqlite"
                  />
                  <button
                    type="button"
                    class="button button-secondary"
                    onClick={() => setDialogOpen(true)}
                  >
                    {t(language, "Review confirmation")}
                  </button>
                </section>
              )}
            </div>
          )}
        </div>
      </main>
      <ConfirmDialog
        language={language}
        open={dialogOpen}
        title={t(language, "Clear all Context Awareness?")}
        body={t(language, "This sample confirmation does not change saved history.")}
        confirmLabel={t(language, "Confirm")}
        onConfirm={() => setDialogOpen(false)}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  )
}

export function mountApp(root: HTMLElement, browser: Window = window, fetcher: FetchLike = fetch) {
  const token = readInjectedToken(browser)
  const rpc = createRpcClient(token, fetcher)
  render(<App browser={browser} rpc={rpc} />, root)
  return () => render(null, root)
}

if (typeof document !== "undefined") {
  const root = document.getElementById("app")
  if (root) mountApp(root)
}
