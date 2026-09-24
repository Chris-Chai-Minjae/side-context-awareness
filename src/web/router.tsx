import { useEffect, useState } from "preact/hooks"
import type { DayDemoState } from "./pages/day-view-demo"

export type DemoState = "loading" | "error" | "empty" | "normal"
export type SettingsDemoState = DemoState | "permissions_needed" | "paused"

export type Route =
  | { readonly kind: "settings" }
  | { readonly kind: "history"; readonly date: string }
  | { readonly kind: "demo"; readonly state: DemoState }
  | { readonly kind: "settings-demo"; readonly state: SettingsDemoState }
  | { readonly kind: "day-demo"; readonly state: DayDemoState }
  | { readonly kind: "not-found" }

export function routeFromHash(hash: string): Route {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash
  const [path = "", query = ""] = fragment.split("?", 2)
  if (path === "" || path === "/" || path === "/settings/context-awareness") {
    return { kind: "settings" }
  }
  const history = /^\/history\/(\d{4}-\d{2}-\d{2})(?:#s:[0-9A-HJKMNP-TV-Z]{26})?$/.exec(path)
  if (history?.[1]) return { kind: "history", date: history[1] }
  if (path === "/demo/phase-4/s0-shell") {
    const state = new URLSearchParams(query).get("state")
    if (state === "loading" || state === "error" || state === "empty") {
      return { kind: "demo", state }
    }
    return { kind: "demo", state: "normal" }
  }
  if (path === "/demo/phase-4/s1-settings") {
    const state = new URLSearchParams(query).get("state")
    if (
      state === "loading" ||
      state === "error" ||
      state === "empty" ||
      state === "permissions_needed" ||
      state === "paused"
    ) {
      return { kind: "settings-demo", state }
    }
    return { kind: "settings-demo", state: "normal" }
  }
  if (path === "/demo/phase-4/s2-day-view") {
    const state = new URLSearchParams(query).get("state")
    if (
      state === "loading" ||
      state === "error" ||
      state === "empty" ||
      state === "expired-evidence"
    ) {
      return { kind: "day-demo", state }
    }
    return { kind: "day-demo", state: "normal" }
  }
  return { kind: "not-found" }
}

export function useHashRoute(browser: Window): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(browser.location.hash))
  useEffect(() => {
    const update = () => setRoute(routeFromHash(browser.location.hash))
    browser.addEventListener("hashchange", update)
    return () => browser.removeEventListener("hashchange", update)
  }, [browser])
  return route
}
