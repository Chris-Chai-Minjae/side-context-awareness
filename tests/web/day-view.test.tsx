import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { mountApp } from "../../src/web/main"
import { routeFromHash } from "../../src/web/router"
import type { FetchLike } from "../../src/web/rpc-client"

const day = "2025-09-23"
const earlier = "2025-09-22"
const later = "2025-09-24"
const summaryId = "01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6"
const sourceId = "01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z7"
const sourceRef = `e:${sourceId}`
const markdown = `---
render: '3'
updated_at: 2026-09-23T09:41:00+09:00
---
# Context awareness — ${day}

## Day overview
- Reviewed notes  s:${summaryId}

### 09:10 – 09:20 — Reviewed notes  s:${summaryId}
Read **sqlite** notes and <script>window.bad = true</script>.

Sources: [Reference](https://example.com/notes) — ${sourceRef} | s:${summaryId}
`

type Request = { readonly method: string; readonly params: unknown }
let browser: Window
let calls: Request[]
let cleared: boolean
let uiLanguage: "ko" | "en"
const globalNames = ["window", "document", "Event"] as const
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

beforeEach(() => {
  for (const name of globalNames) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  browser = new Window({ url: `http://127.0.0.1:49152/?t=synthetic-token#/history/${day}` })
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, "Event", { configurable: true, value: browser.Event })
  calls = []
  cleared = false
  uiLanguage = "en"
})

afterEach(() => {
  browser.happyDOM.abort()
  for (const name of globalNames) {
    const descriptor = previousGlobals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

function root(): HTMLDivElement {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const fakeFetch: FetchLike = async (_input, init) => {
  const request = JSON.parse(String(init?.body))
  calls.push({ method: request.method, params: request.params })
  let result: unknown
  switch (request.method) {
    case "settings.get":
      result = { ui_language: uiLanguage }
      break
    case "historyStatus":
      result = {
        store_bytes: 1024,
        average_bytes_per_day: 512,
        days_with_summaries: [earlier, day, later],
        today_summary_states: { pending: 0, running: 0, done: 1, failed: 0, skipped: 0 },
      }
      break
    case "day.get":
      result =
        request.params.date === day && !cleared
          ? { date: day, markdown, updated_at: "2026-09-23T09:41:00+09:00" }
          : { date: request.params.date, markdown: null, updated_at: "2026-09-23T09:41:00+09:00" }
      break
    case "read":
      result = {
        id: request.params.id,
        occurred_at: Date.parse("2026-09-23T09:15:00+09:00"),
        app: "Browser",
        title: "Reference",
        url: "https://example.com/notes",
        text: '<img src=x onerror="alert(1)"> sqlite notes',
        expired: false,
      }
      break
    case "clear":
      cleared = true
      result = { deleted_events: 1, deleted_summaries: 1, deletion_epoch: 1 }
      break
    default:
      throw new Error(`Unexpected RPC ${request.method}`)
  }
  return Response.json({ jsonrpc: "2.0", id: request.id, result })
}

test("routes history and all approved Day view demo states", () => {
  expect(routeFromHash(`#/history/${day}#s:${summaryId}`)).toEqual({ kind: "history", date: day })
  for (const state of ["loading", "error", "empty", "normal", "expired-evidence"] as const) {
    expect(routeFromHash(`#/demo/phase-4/s2-day-view?state=${state}`)).toEqual({
      kind: "day-demo",
      state,
    })
  }
})

test("renders the day page, follows source once, and inserts evidence as text nodes", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(element.textContent).toContain("Day overview")
  expect(element.textContent).toContain("09:10 – 09:20")
  expect(element.querySelector("script")).toBeNull()
  expect(element.textContent).toContain("<script>window.bad = true</script>")
  const source = element.querySelector<HTMLAnchorElement>(`[data-ref="${sourceRef}"]`)
  expect(source).not.toBeNull()
  source?.click()
  await settle()
  expect(calls.filter((call) => call.method === "read")).toEqual([
    { method: "read", params: { id: sourceRef } },
  ])
  const evidence = element.querySelector(".untrusted-text")
  expect(evidence?.textContent).toContain('<img src=x onerror="alert(1)">')
  expect(evidence?.querySelector("img")).toBeNull()
  expect(evidence?.firstChild?.firstChild?.nodeType).toBe(browser.Node.TEXT_NODE)
})

test("Given saved Korean, when opening Day view, then navigation, evidence, and fixed markdown headings use Korean", async () => {
  uiLanguage = "ko"
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(element.querySelector(".day-heading h1")?.textContent).toBe(`기록 · ${day}`)
  expect(element.textContent).toContain("하루 개요")
  expect(element.textContent).toContain("출처:")
  expect(element.textContent).toContain("증거를 보려면 출처를 선택하세요.")
  expect(element.textContent).not.toContain("Select a source to view its evidence.")
  expect(element.querySelector('[aria-label="주 탐색"]')?.textContent).toContain("설정")
})

test("uses only summary dates for previous and next navigation", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(element.querySelector<HTMLAnchorElement>('[data-action="previous-day"]')?.hash).toBe(
    `#/history/${earlier}`,
  )
  expect(element.querySelector<HTMLAnchorElement>('[data-action="next-day"]')?.hash).toBe(
    `#/history/${later}`,
  )
  expect(Boolean(element.querySelector('[data-action="clear-today"]'))).toBe(false)
  window.location.hash = `#/history/${earlier}`
  window.dispatchEvent(new Event("hashchange"))
  await settle()
  expect(element.querySelector('[data-action="previous-day"]')).toBeNull()
  expect(element.querySelector<HTMLAnchorElement>('[data-action="next-day"]')?.hash).toBe(
    `#/history/${day}`,
  )
})

test("opens a summary hash at its section and safe external links in a new browser context", async () => {
  const scrolled: string[] = []
  browser.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.id)
  }
  window.location.hash = `#/history/${day}#s:${summaryId}`
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(scrolled).toContain(`s:${summaryId}`)
  const external = element.querySelector<HTMLAnchorElement>('a[href="https://example.com/notes"]')
  expect(external?.target).toBe("_blank")
  expect(external?.rel).toContain("noopener")
})

test("treats hostile markdown HTML and URL schemes as inert text", async () => {
  const hostile = `${markdown}\n[unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>`
  const fetcher: FetchLike = async (input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method !== "day.get") return fakeFetch(input, init)
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: { date: day, markdown: hostile, updated_at: "2026-09-23T09:41:00+09:00" },
    })
  }
  const element = root()
  mountApp(element, window, fetcher)
  await settle()
  expect(element.querySelector("script, img")).toBeNull()
  expect(element.querySelector('a[href^="javascript:"]')).toBeNull()
  expect(element.textContent).toContain("<img src=x onerror=alert(1)>")
})

test("shows an expired source and its citing summary link", async () => {
  const fetcher: FetchLike = async (input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method !== "read") return fakeFetch(input, init)
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        id: sourceRef,
        occurred_at: Date.parse("2026-09-23T09:15:00+09:00"),
        app: "",
        title: "",
        url: null,
        text: `Original event expired.\nCiting summaries: s:${summaryId}`,
        expired: true,
      },
    })
  }
  const element = root()
  mountApp(element, window, fetcher)
  await settle()
  element.querySelector<HTMLAnchorElement>(`[data-ref="${sourceRef}"]`)?.click()
  await settle()
  expect(element.textContent).toContain("expired")
  expect(
    element.querySelector<HTMLAnchorElement>(`[href="#/history/${day}#s:${summaryId}"]`),
  ).not.toBeNull()
})

test("re-reads a selected summary with literal match and ten context lines", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  element.querySelector<HTMLAnchorElement>(`[data-ref="s:${summaryId}"]`)?.click()
  await settle()
  const input = element.querySelector<HTMLInputElement>("#evidence-match")
  expect(input).not.toBeNull()
  if (!input) return
  input.value = "sqlite"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await settle()
  element.querySelector<HTMLButtonElement>(".evidence-match button")?.click()
  await settle()
  expect(calls.filter((call) => call.method === "read")).toEqual([
    { method: "read", params: { id: `s:${summaryId}` } },
    { method: "read", params: { id: `s:${summaryId}`, match: "sqlite", contextLines: 10 } },
  ])
  expect(element.querySelectorAll(".untrusted-text mark")).toHaveLength(1)
})

test("invalid day RPC data shows the retry state", async () => {
  const fetcher: FetchLike = async (input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method !== "day.get") return fakeFetch(input, init)
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { markdown: "missing date" } })
  }
  const element = root()
  mountApp(element, window, fetcher)
  await settle()
  expect(element.textContent).toContain("Could not load day view.")
})

test("allows clear today only on today and reloads after confirmation", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  window.location.hash = `#/history/${today}`
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  element.querySelector<HTMLButtonElement>('[data-action="clear-today"]')?.click()
  await settle()
  expect(calls.filter((call) => call.method === "clear")).toHaveLength(0)
  element.querySelector<HTMLButtonElement>('[role="dialog"] [data-action="confirm"]')?.click()
  await settle()
  expect(calls.filter((call) => call.method === "clear")).toEqual([
    { method: "clear", params: { target: "today" } },
  ])
  expect(calls.filter((call) => call.method === "day.get")).toHaveLength(2)
})

test("shows failed work for today and retries it only after an explicit click", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  window.location.hash = `#/history/${today}`
  const fetcher: FetchLike = async (input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === "historyStatus") {
      calls.push({ method: request.method, params: request.params })
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          store_bytes: 1024,
          average_bytes_per_day: 512,
          days_with_summaries: [],
          today_summary_states: { pending: 0, running: 0, done: 0, failed: 1, skipped: 0 },
        },
      })
    }
    if (request.method === "summaries.retryFailedToday") {
      calls.push({ method: request.method, params: request.params })
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { requeued: 1 } })
    }
    return fakeFetch(input, init)
  }
  const element = root()
  mountApp(element, window, fetcher)
  await settle()
  expect(calls.some((call) => call.method === "summaries.retryFailedToday")).toBe(false)
  const retry = element.querySelector<HTMLButtonElement>('[data-action="retry-failed-today"]')
  expect(retry).not.toBeNull()
  retry?.click()
  await settle()
  expect(calls.filter((call) => call.method === "summaries.retryFailedToday")).toHaveLength(1)
  expect(element.textContent).toContain("1 summary job queued")
})

test("refreshes a queued retry after asynchronous completion without retrying the model", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  window.location.hash = `#/history/${today}`
  let queued = false
  let completed = false
  const fetcher: FetchLike = async (input, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === "historyStatus") {
      calls.push({ method: request.method, params: request.params })
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          store_bytes: 1024,
          average_bytes_per_day: 512,
          days_with_summaries: completed ? [today] : [],
          today_summary_states: {
            pending: queued && !completed ? 1 : 0,
            running: 0,
            done: completed ? 1 : 0,
            failed: queued ? 0 : 1,
            skipped: 0,
          },
        },
      })
    }
    if (request.method === "day.get") {
      calls.push({ method: request.method, params: request.params })
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: completed
          ? { date: today, markdown, updated_at: "2026-09-23T09:41:00+09:00" }
          : null,
      })
    }
    if (request.method === "summaries.retryFailedToday") {
      calls.push({ method: request.method, params: request.params })
      queued = true
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { requeued: 1 } })
    }
    return fakeFetch(input, init)
  }
  const element = root()
  mountApp(element, window, fetcher)
  await settle()
  expect(element.textContent).toContain("No summaries for this day.")
  element.querySelector<HTMLButtonElement>('[data-action="retry-failed-today"]')?.click()
  await settle()
  expect(element.textContent).toContain("1 summary job queued")
  expect(element.textContent).toContain("No summaries for this day.")
  completed = true
  const readsBeforeRefresh = calls.filter((call) => call.method === "day.get").length
  await settle()
  expect(calls.filter((call) => call.method === "day.get")).toHaveLength(readsBeforeRefresh)
  const refresh = element.querySelector<HTMLButtonElement>('[data-action="refresh-day"]')
  expect(refresh).not.toBeNull()
  refresh?.click()
  await settle()
  expect(calls.filter((call) => call.method === "day.get")).toHaveLength(readsBeforeRefresh + 1)
  expect(calls.filter((call) => call.method === "summaries.retryFailedToday")).toHaveLength(1)
  expect(element.textContent).toContain("Day overview")
})

test.each(["loading", "error", "empty", "normal", "expired-evidence"])(
  "Day view demo renders %s without live RPC",
  async (state) => {
    window.location.hash = `#/demo/phase-4/s2-day-view?state=${state}`
    const element = root()
    const fetcher: FetchLike = async () => {
      throw new Error("Unexpected live RPC")
    }
    mountApp(element, window, fetcher)
    await settle()
    const expected =
      state === "loading"
        ? "불러오는 중…"
        : state === "error"
          ? "하루 기록을 불러올 수 없습니다."
          : state === "empty"
            ? "이 날짜에는 요약이 없습니다."
            : "하루 개요"
    expect(element.textContent).toContain(expected)
    if (state === "expired-evidence") {
      expect(element.textContent).toContain("원본 증거가 만료되었습니다.")
    }
  },
)
