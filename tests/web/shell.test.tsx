import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { render } from "preact"
import { ConfirmDialog } from "../../src/web/components/confirm-dialog"
import { EvidencePanel } from "../../src/web/components/evidence-panel"
import { PauseControl } from "../../src/web/components/pause-control"
import { PermissionBanner } from "../../src/web/components/permission-banner"
import { UntrustedTextView } from "../../src/web/components/untrusted-text-view"
import { mountApp } from "../../src/web/main"
import { routeFromHash } from "../../src/web/router"
import type { FetchLike } from "../../src/web/rpc-client"
import { createRpcClient, readInjectedToken } from "../../src/web/rpc-client"

let browser: Window
const originalGlobals = new Map(
  (["window", "document", "Event", "KeyboardEvent"] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
)

beforeEach(() => {
  browser = new Window({
    url: "http://127.0.0.1:49152/?t=synthetic-token#/settings/context-awareness",
  })
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, "Event", { configurable: true, value: browser.Event })
  Object.defineProperty(globalThis, "KeyboardEvent", {
    configurable: true,
    value: browser.KeyboardEvent,
  })
})

afterEach(() => {
  browser.happyDOM.abort()
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

function root(): HTMLDivElement {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test("injected token is held in memory and removed from the current history entry", () => {
  const beforeLength = window.history.length
  expect(readInjectedToken(window)).toBe("synthetic-token")
  expect(window.location.href).toBe("http://127.0.0.1:49152/#/settings/context-awareness")
  expect(window.history.length).toBe(beforeLength)
  expect(window.location.search).toBe("")
})

test("RPC sends Bearer auth to the local path without placing token in URL or body", async () => {
  let path = ""
  let auth = ""
  let body = ""
  const fetcher: FetchLike = async (input, init) => {
    path = String(input)
    auth = new Headers(init?.headers).get("Authorization") ?? ""
    body = String(init?.body)
    return Response.json({ jsonrpc: "2.0", id: 1, result: { enabled: true } })
  }
  const client = createRpcClient("synthetic-token", fetcher)
  expect(await client.call("status")).toEqual({ enabled: true })
  expect(path).toBe("/rpc")
  expect(auth).toBe("Bearer synthetic-token")
  expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", id: 1, method: "status" })
  expect(body).not.toContain("synthetic-token")
})

test("hash router resolves settings, day, demo state, and unknown paths", () => {
  expect(routeFromHash("#/settings/context-awareness")).toEqual({ kind: "settings" })
  expect(routeFromHash("#/history/2026-09-24")).toEqual({
    kind: "history",
    date: "2026-09-24",
  })
  expect(routeFromHash("#/demo/phase-4/s0-shell?state=error")).toEqual({
    kind: "demo",
    state: "error",
  })
  expect(routeFromHash("#/unknown")).toEqual({ kind: "not-found" })
})

test("permission banner follows the approved copy and shows Allow only when actionable", () => {
  const element = root()
  let allowed = 0
  render(
    <PermissionBanner language="en" banner="permissions_needed" onAllow={() => allowed++} />,
    element,
  )
  expect(element.textContent).toContain("Permissions needed")
  const button = element.querySelector("button")
  expect(button?.textContent).toBe("Allow")
  button?.click()
  expect(allowed).toBe(1)
  render(<PermissionBanner language="en" banner="starting" onAllow={() => allowed++} />, element)
  expect(element.textContent).toContain("Starting capture…")
  expect(element.querySelector("button")).toBeNull()
})

test("pause control sends the selected duration, indefinite marker, and resume", async () => {
  const element = root()
  const requests: unknown[] = []
  let resumed = 0
  render(
    <PauseControl
      language="en"
      pausedUntil={null}
      onPause={(value) => requests.push(value)}
      onResume={() => resumed++}
    />,
    element,
  )
  const select = element.querySelector("select")
  expect(select?.options.length).toBe(4)
  if (!select) throw new Error("pause selection missing")
  select.value = "30m"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await flush()
  element.querySelector("button")?.click()
  expect(requests).toEqual([{ durationMs: 1_800_000 }])
  select.value = "indefinite"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await flush()
  element.querySelector("button")?.click()
  expect(requests).toEqual([{ durationMs: 1_800_000 }, { until: Number.MAX_SAFE_INTEGER }])
  render(
    <PauseControl
      language="en"
      pausedUntil={Number.MAX_SAFE_INTEGER}
      onPause={(value) => requests.push(value)}
      onResume={() => resumed++}
    />,
    element,
  )
  expect(element.textContent).toContain("Paused until you resume")
  element.querySelector("button")?.click()
  expect(resumed).toBe(1)
})

test("destructive dialog waits for confirmation and Escape cancels", () => {
  const element = root()
  let confirmed = 0
  let cancelled = 0
  render(
    <ConfirmDialog
      language="en"
      open
      title="Clear all Context Awareness?"
      body="This deletes history on this Mac."
      confirmLabel="Clear history"
      onConfirm={() => confirmed++}
      onCancel={() => cancelled++}
    />,
    element,
  )
  expect(confirmed).toBe(0)
  expect(element.querySelector('[role="dialog"]')).not.toBeNull()
  element.querySelector<HTMLButtonElement>('[data-action="confirm"]')?.click()
  expect(confirmed).toBe(1)
  element
    .querySelector('[role="dialog"]')
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  expect(cancelled).toBe(1)
})

test("untrusted evidence is text only and highlights literal matches", () => {
  const element = root()
  render(
    <UntrustedTextView
      language="en"
      text={'<img src=x onerror="alert(1)"> sqlite sqlite'}
      match="sqlite"
    />,
    element,
  )
  expect(element.querySelector("img")).toBeNull()
  expect(element.textContent).toContain('<img src=x onerror="alert(1)">')
  expect(element.querySelectorAll("mark")).toHaveLength(2)
})

test("expired evidence keeps its citing reference in both UI languages", () => {
  const element = root()
  const summaryRef = "s:01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6"
  const evidence = {
    kind: "ready" as const,
    value: {
      id: "e:01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z7",
      occurred_at: Date.parse("2026-09-23T09:15:00+09:00"),
      app: "",
      title: "",
      url: null,
      text: `Original event expired.\nCiting summaries: ${summaryRef}`,
      expired: true,
    },
    match: "",
  }
  const props = {
    date: "2026-09-23",
    evidence,
    selection: { ref: evidence.value.id, summaryRef },
    matchInput: "",
    onMatchInput: () => {},
    onMatchSubmit: () => {},
  }
  render(<EvidencePanel {...props} language="en" />, element)
  expect(element.querySelector(".untrusted-text")?.textContent).toContain(
    `Citing summaries: ${summaryRef}`,
  )
  render(<EvidencePanel {...props} language="ko" />, element)
  expect(element.querySelector(".untrusted-text")?.textContent).toContain(
    `인용한 요약: ${summaryRef}`,
  )
  expect(element.querySelector(".untrusted-text")?.textContent).not.toContain("Citing summaries:")
})

test("zero captured events still show the permissions action and pause control", async () => {
  window.history.replaceState(null, "", "/?t=synthetic-token#/demo/phase-4/s0-shell?state=empty")
  const element = root()
  const fetcher: FetchLike = async (_input, init) => {
    expect(window.location.search).toBe("")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token")
    const request = JSON.parse(String(init?.body))
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { banner: "permissions_needed", paused_until: null, today: { events: 0 } },
    })
  }
  mountApp(element, window, fetcher)
  for (let attempt = 0; attempt < 20 && element.textContent.includes("불러오는 중…"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(element.textContent).toContain("아직 활동이 없습니다")
  expect(element.textContent).toContain("권한이 필요합니다")
  expect(element.querySelector("select")).not.toBeNull()
})

test.each(["loading", "error", "empty", "normal"])(
  "demo shell renders the %s state without live network calls",
  async (state) => {
    window.history.replaceState(
      null,
      "",
      `/?t=synthetic-token#/demo/phase-4/s0-shell?state=${state}`,
    )
    const element = root()
    let requests = 0
    const fetcher: FetchLike = async () => {
      requests++
      throw new Error("unexpected network call")
    }
    mountApp(element, window, fetcher)
    await flush()
    if (state !== "loading") {
      for (
        let attempt = 0;
        attempt < 20 && element.textContent.includes("불러오는 중…");
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    expect(window.location.search).toBe("")
    expect(requests).toBe(0)
    const expected =
      state === "loading"
        ? "불러오는 중…"
        : state === "error"
          ? "캡처 상태를 불러올 수 없습니다."
          : state === "empty"
            ? "아직 활동이 없습니다."
            : "공통 구성 요소"
    expect(element.textContent).toContain(expected)
  },
)
