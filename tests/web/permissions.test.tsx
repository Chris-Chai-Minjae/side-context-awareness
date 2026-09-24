import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { mountApp } from "../../src/web/main"
import { routeFromHash } from "../../src/web/router"
import type { FetchLike } from "../../src/web/rpc-client"

let browser: Window
let calls: { method: string; params: unknown }[]
let permissions: Record<string, unknown>
let settings: Record<string, unknown>
let status: Record<string, unknown>
let models: unknown
let keyStatuses: Record<string, { stored: boolean; accessible: boolean }>
let authorizationAllowed: boolean
let failMethod: string | null
const originalGlobals = new Map(
  (["window", "document", "Event", "KeyboardEvent"] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
)

beforeEach(() => {
  browser = new Window({ url: "http://127.0.0.1:49152/?t=synthetic-token#/permissions" })
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, "Event", { configurable: true, value: browser.Event })
  Object.defineProperty(globalThis, "KeyboardEvent", {
    configurable: true,
    value: browser.KeyboardEvent,
  })
  calls = []
  failMethod = null
  permissions = {
    accessibility: true,
    input_monitoring: false,
    screen_recording: false,
    automation: { "com.apple.Safari": true, "com.google.Chrome": false },
  }
  status = {
    enabled: false,
    state: "stopped",
    banner: "not_running",
    health: { nativeCaptureAvailable: false },
  }
  settings = {
    ui_language: "en",
    screen_ocr: true,
    providers: [
      { id: "local", kind: "openai-compatible", has_key: true },
      { id: "missing", kind: "openai-compatible", has_key: false },
      { id: "claude", kind: "claude-code-cli", has_key: false },
    ],
  }
  models = { status: "available", models: ["test-model"] }
  authorizationAllowed = true
  keyStatuses = {
    local: { stored: true, accessible: true },
    missing: { stored: false, accessible: false },
  }
})

afterEach(() => {
  browser.happyDOM.abort()
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const fetcher: FetchLike = async (_input, init) => {
  const packet = JSON.parse(String(init?.body))
  calls.push({ method: packet.method, params: packet.params })
  if (packet.method === failMethod) {
    return Response.json({ jsonrpc: "2.0", id: packet.id, error: { message: "unavailable" } })
  }
  if (packet.method === "providers.authorizeKey") {
    const providerId = packet.params.providerId
    if (authorizationAllowed && keyStatuses[providerId]) keyStatuses[providerId].accessible = true
    return Response.json({
      jsonrpc: "2.0",
      id: packet.id,
      result: { authorized: authorizationAllowed },
    })
  }
  const result =
    packet.method === "permissions" || packet.method === "requestPermissions"
      ? permissions
      : packet.method === "status"
        ? status
        : packet.method === "settings.get"
          ? settings
          : packet.method === "providers.keyStatus"
            ? (keyStatuses[packet.params.providerId] ?? { stored: false, accessible: false })
            : packet.method === "providers.listModels"
              ? models
              : null
  return Response.json({ jsonrpc: "2.0", id: packet.id, result })
}

test("Given OCR is off, when permissions load, then Screen Recording request explains why it is unavailable", async () => {
  settings["screen_ocr"] = false
  const element = await page()
  const row = element.querySelector('[data-permission="screenRecording"]')
  expect(row?.querySelector("button")?.disabled).toBe(true)
  expect(row?.textContent).toContain("Enable OCR in Settings before requesting access.")
  expect(row?.querySelector('a[href^="x-apple.systempreferences:"]')).not.toBeNull()
})

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2))
}

async function page(): Promise<HTMLDivElement> {
  const element = document.createElement("div")
  document.body.append(element)
  mountApp(element, window, fetcher)
  await settle()
  return element
}

test("Given the permissions route, when resolved, then it has its own page", () => {
  expect(routeFromHash("#/permissions")).toEqual({ kind: "permissions" })
})

test("Given mixed permissions and disabled capture, when loaded, then each status and helper state is distinct", async () => {
  const element = await page()
  expect(element.querySelector('a[href="#/permissions"]')?.getAttribute("aria-current")).toBe(
    "page",
  )
  expect(element.querySelector('[data-permission="accessibility"]')?.textContent).toContain(
    "Allowed",
  )
  expect(element.querySelector('[data-permission="inputMonitoring"]')?.textContent).toContain(
    "Not allowed",
  )
  expect(element.querySelector('[data-permission="screenRecording"]')?.textContent).toContain(
    "Not allowed",
  )
  expect(element.querySelector('[data-automation="com.apple.Safari"]')?.textContent).toContain(
    "Allowed",
  )
  expect(element.querySelector('[data-automation="com.google.Chrome"]')?.textContent).toContain(
    "Not allowed",
  )
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Key reference configured",
  )
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain access not checked",
  )
  expect(element.querySelector('[data-provider="missing"]')?.textContent).toContain(
    "Key not configured",
  )
  expect(element.querySelector('[data-provider="claude"]')?.textContent).toContain(
    "Claude Code login",
  )
  expect(element.textContent).toContain("Capture disabled")
  expect(element.textContent).toContain("Helper not running")
  expect(calls.map((call) => call.method)).not.toContain("providers.listModels")
  expect(calls.map((call) => call.method)).not.toContain("providers.keyStatus")
  expect(calls.map((call) => call.method)).not.toContain("providers.authorizeKey")
})

for (const [kind, guide, pane] of [
  ["accessibility", "mh43185", "Privacy_Accessibility"],
  ["inputMonitoring", "mchl4cedafb6", "Privacy_ListenEvent"],
  ["screenRecording", "mchld6aa7d23", "Privacy_ScreenCapture"],
] as const) {
  test(`Given ${kind}, when requested, then only that kind is sent and statuses refresh`, async () => {
    permissions[
      kind === "inputMonitoring"
        ? "input_monitoring"
        : kind === "screenRecording"
          ? "screen_recording"
          : "accessibility"
    ] = false
    const element = await page()
    expect(
      element
        .querySelector(`[data-permission="${kind}"] a[href^="x-apple.systempreferences:"]`)
        ?.getAttribute("href"),
    ).toBe(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
    expect(
      element
        .querySelector(`[data-permission="${kind}"] a[href^="https://support.apple.com/"]`)
        ?.getAttribute("href"),
    ).toContain(guide)
    element.querySelector<HTMLButtonElement>(`[data-permission="${kind}"] button`)?.click()
    await settle()
    expect(calls.find((call) => call.method === "requestPermissions")?.params).toEqual({
      kinds: [kind],
    })
    expect(calls.filter((call) => call.method === "permissions")).toHaveLength(2)
    expect(calls.filter((call) => call.method === "status")).toHaveLength(2)
  })
}

test("Given an allowed macOS permission, its request button is disabled while System Settings remains available", async () => {
  const element = await page()
  const row = element.querySelector('[data-permission="accessibility"]')
  const button = row?.querySelector<HTMLButtonElement>("button")
  expect(button?.disabled).toBe(true)
  expect(button?.textContent).toContain("Permission granted")
  expect(row?.querySelector('a[href^="x-apple.systempreferences:"]')).not.toBeNull()
  button?.click()
  await settle()
  expect(calls.map((call) => call.method)).not.toContain("requestPermissions")
})

test("Given reported browser Automation, when requested, then only automation is sent", async () => {
  const element = await page()
  element.querySelector<HTMLButtonElement>("#automation-heading ~ button")?.click()
  await settle()
  expect(calls.find((call) => call.method === "requestPermissions")?.params).toEqual({
    kinds: ["automation"],
  })
})

test("Given connected helper and disabled capture, when loaded, then both states remain distinct", async () => {
  status["health"] = { nativeCaptureAvailable: false, pid: 123 }
  const element = await page()
  expect(element.textContent).toContain("Capture disabled")
  expect(element.textContent).toContain("Helper connected")
  expect(element.textContent).toContain("Native capture unavailable")
  expect(element.querySelector('[data-permission="inputMonitoring"]')?.textContent).toContain(
    "Not allowed",
  )
})

test("Given capture running with granted permissions and observer registration failure, the non-permission cause is shown", async () => {
  permissions["input_monitoring"] = true
  permissions["screen_recording"] = true
  status = {
    enabled: true,
    state: "running",
    banner: "some_unavailable",
    health: { nativeCaptureAvailable: true, pid: 123, observerRegistrationFailures: 1 },
  }
  const english = await page()
  expect(english.textContent).toContain("Capture running")
  expect(english.textContent).toContain("Capture observer registration failed")
  expect(english.textContent).not.toContain("Native capture unavailable")
})

test("Given observer registration failure, the Korean page explains the non-permission cause", async () => {
  status = {
    enabled: true,
    state: "running",
    banner: "some_unavailable",
    health: { nativeCaptureAvailable: true, pid: 123, observerRegistrationFailures: 1 },
  }
  settings["ui_language"] = "ko"
  const korean = await page()
  expect(korean.textContent).toContain("캡처 관찰자 등록에 실패")
})

test("Given partial capture failure with granted TCC permissions, when loaded, then each health cause is visible separately", async () => {
  permissions["input_monitoring"] = true
  permissions["screen_recording"] = true
  status = {
    enabled: true,
    state: "running",
    banner: "some_unavailable",
    health: {
      nativeCaptureAvailable: true,
      pid: 123,
      eventTapHealthy: false,
      inputCaptureAvailable: false,
      screenOcrAvailable: false,
    },
  }
  const element = await page()
  expect(element.textContent).toContain("Capture running")
  expect(element.textContent).toContain("Helper connected")
  expect(element.textContent).toContain("Some capture features are unavailable")
  expect(element.textContent).toContain("Input event tap unhealthy")
  expect(element.textContent).toContain("Input capture unavailable")
  expect(element.textContent).toContain("Screen OCR unavailable")
  expect(element.querySelector('[data-permission="inputMonitoring"]')?.textContent).toContain(
    "Allowed",
  )
  expect(element.querySelector('[data-permission="screenRecording"]')?.textContent).toContain(
    "Allowed",
  )
})

test("Given partial capture failure in Korean, when loaded, then each health cause is translated", async () => {
  settings["ui_language"] = "ko"
  status = {
    enabled: true,
    state: "running",
    banner: "some_unavailable",
    health: {
      nativeCaptureAvailable: true,
      pid: 123,
      eventTapHealthy: false,
      inputCaptureAvailable: false,
      screenOcrAvailable: false,
    },
  }
  const element = await page()
  expect(element.textContent).toContain("입력 이벤트 탭에 문제가 있습니다")
  expect(element.textContent).toContain("입력 캡처를 사용할 수 없습니다")
  expect(element.textContent).toContain("화면 OCR을 사용할 수 없습니다")
})

test("Given changed macOS permissions, when refreshed, then the new status is shown", async () => {
  const element = await page()
  permissions["input_monitoring"] = true
  element.querySelector<HTMLButtonElement>(".permissions-page > div button")?.click()
  await settle()
  expect(element.querySelector('[data-permission="inputMonitoring"]')?.textContent).toContain(
    "Allowed",
  )
  expect(calls.filter((call) => call.method === "permissions")).toHaveLength(2)
})

test("Given a configured provider, when explicitly verified, then a model-list result appears without generation", async () => {
  const element = await page()
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  element
    .querySelector<HTMLButtonElement>(
      '[data-provider="local"] button[data-action="verify-connection"]',
    )
    ?.click()
  await settle()
  expect(calls.filter((call) => call.method === "providers.listModels")).toEqual([
    { method: "providers.listModels", params: { providerId: "local" } },
  ])
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain("Available")
  expect(calls.some((call) => call.method === "providers.test")).toBe(false)
})

test("Given a Keychain-unavailable result, when verified, then the specific failure is shown", async () => {
  models = { status: "unavailable", models: [], reason: "key-unavailable" }
  const element = await page()
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  element
    .querySelector<HTMLButtonElement>(
      '[data-provider="local"] button[data-action="verify-connection"]',
    )
    ?.click()
  await settle()
  const provider = element.querySelector('[data-provider="local"]')
  expect(provider?.textContent).toContain("Key unavailable")
  expect(provider?.textContent).not.toContain("Keychain accessible")
  expect(
    provider?.querySelector<HTMLButtonElement>('button[data-action="authorize-key"]'),
  ).not.toBeNull()
  expect(
    provider?.querySelector<HTMLButtonElement>('button[data-action="verify-connection"]')?.disabled,
  ).toBe(true)
  provider?.querySelector<HTMLButtonElement>('button[data-action="authorize-key"]')?.click()
  await settle()
  expect(provider?.textContent).toContain("Keychain accessible")
  expect(provider?.querySelector('[role="status"]')?.textContent).toBe("Not checked yet")
})

test("Given an inaccessible stored key, when explicitly authorized, then its access status refreshes", async () => {
  keyStatuses["local"] = { stored: true, accessible: false }
  const element = await page()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain access not checked",
  )
  expect(calls.map((call) => call.method)).not.toContain("providers.authorizeKey")
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  expect(calls.filter((call) => call.method === "providers.authorizeKey")).toEqual([
    { method: "providers.authorizeKey", params: { providerId: "local" } },
  ])
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain accessible",
  )
  expect(calls.map((call) => call.method)).not.toContain("providers.keyStatus")
})

test("Given key-status RPC failure, when loaded, then Keychain access remains unchecked", async () => {
  failMethod = "providers.keyStatus"
  const element = await page()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain access not checked",
  )
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Key reference configured",
  )
  expect(calls.map((call) => call.method)).not.toContain("providers.keyStatus")
})

test("Given denied Keychain authorization, when clicked, then access stays unchecked and connection stays disabled", async () => {
  authorizationAllowed = false
  const element = await page()
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain access not checked",
  )
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    "Keychain access was not granted.",
  )
  expect(
    element.querySelector<HTMLButtonElement>(
      '[data-provider="local"] button[data-action="verify-connection"]',
    )?.disabled,
  ).toBe(true)
  expect(calls.map((call) => call.method)).not.toContain("providers.keyStatus")
})

test("Given a refresh after authorization, when loaded again, then Keychain access is unchecked without querying it", async () => {
  const element = await page()
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain accessible",
  )
  element
    .querySelector<HTMLButtonElement>(
      '[data-provider="local"] button[data-action="verify-connection"]',
    )
    ?.click()
  await settle()
  expect(element.querySelector('[data-provider="local"] [role="status"]')?.textContent).toBe(
    "Available",
  )
  element.querySelector<HTMLButtonElement>(".permissions-page > div button")?.click()
  await settle()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Keychain access not checked",
  )
  expect(element.querySelector('[data-provider="local"] [role="status"]')?.textContent).toBe(
    "Not checked yet",
  )
  expect(calls.map((call) => call.method)).not.toContain("providers.keyStatus")
})

test("Given an RPC error, when explicitly verified, then the connection check reports an error", async () => {
  failMethod = "providers.listModels"
  const element = await page()
  element
    .querySelector<HTMLButtonElement>('[data-provider="local"] button[data-action="authorize-key"]')
    ?.click()
  await settle()
  element
    .querySelector<HTMLButtonElement>(
      '[data-provider="local"] button[data-action="verify-connection"]',
    )
    ?.click()
  await settle()
  expect(element.querySelector('[data-provider="local"]')?.textContent).toContain(
    "Connection check failed",
  )
})

test("Given Korean settings, when loaded, then page and status copy are Korean", async () => {
  settings["ui_language"] = "ko"
  const element = await page()
  expect(element.querySelector("h1")?.textContent).toBe("권한")
  expect(element.querySelector('[data-permission="accessibility"]')?.textContent).toContain(
    "허용됨",
  )
  expect(element.querySelector('[data-provider="missing"]')?.textContent).toContain("키 미설정")
})

test("Given pending RPCs, when loading, then the page shows loading", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  mountApp(element, window, () => new Promise<Response>(() => {}))
  expect(element.querySelector('[role="status"]')?.textContent).toContain("불러오는 중")
})

test("Given a failed permissions RPC, when loading, then an error and retry are shown", async () => {
  failMethod = "permissions"
  const element = await page()
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load permissions",
  )
  expect(element.querySelector<HTMLButtonElement>('[role="alert"] button')?.textContent).toBe(
    "Retry",
  )
})
