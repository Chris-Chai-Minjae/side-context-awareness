import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderHandlers } from "../../src/api/resources/providers"
import { createSettingsHandlers, createSettingsMutation } from "../../src/api/resources/settings"
import { handleRpcBody } from "../../src/api/rpc"
import { callSummaryCompletion } from "../../src/comprehension/providers"
import { loadSettings, saveSettings } from "../../src/config/index"
import { HELPER_COMMAND_TIMEOUT_MS } from "../../src/constants"
import { type Settings, SettingsSchema } from "../../src/contracts/settings"
import type { HelperCommandRequest } from "../../src/helper/client"
import { HelperCommandTimeoutError } from "../../src/helper/client"
import { harness } from "../helper/fixture"

function rpc(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
}

function apiKeyRefOf(provider: Settings["providers"][number] | undefined): string | undefined {
  return provider?.kind === "claude-code-cli" || provider?.kind === "codex-cli"
    ? undefined
    : provider?.apiKeyRef
}

async function fixture(
  baseUrl: string,
  supportsToolChoice = true,
  beforeGet?: () => Promise<void>,
  initialRef?: string,
  beforeStatus?: () => Promise<void>,
  beforeAuthorize?: () => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "side-api-providers-"))
  let current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [
      {
        id: "synthetic",
        baseUrl,
        models: ["probe-model"],
        supportsToolChoice,
        allowEvidence: false,
        ...(initialRef ? { apiKeyRef: initialRef } : {}),
      },
    ],
  })
  await saveSettings(directory, current)
  const keys = new Map<string, string>()
  const inaccessible = new Set<string>()
  const denied = new Set<string>()
  const commands: HelperCommandRequest[] = []
  const applied: Settings[] = []
  const reconciler = {
    get currentSettings() {
      return current
    },
    async settingsPatched(next: Settings) {
      applied.push(next)
      current = next
    },
  }
  const mutateSettings = createSettingsMutation(reconciler, (next) => saveSettings(directory, next))
  const handlers = createProviderHandlers({
    directory,
    reconciler,
    mutateSettings,
    helper: {
      async sendCommand(command) {
        commands.push(command)
        if (command.name === "keychain.set") {
          keys.set(command.args.ref, command.args.secret)
          return { ref: command.args.ref }
        }
        if (command.name === "keychain.get") {
          await beforeGet?.()
          return keys.get(command.args.ref)
        }
        if (command.name === "keychain.status") {
          await beforeStatus?.()
          return {
            stored: keys.has(command.args.ref),
            accessible: keys.has(command.args.ref) && !inaccessible.has(command.args.ref),
          }
        }
        if (command.name === "keychain.authorize") {
          await beforeAuthorize?.()
          if (denied.has(command.args.ref)) return { authorized: false }
          inaccessible.delete(command.args.ref)
          return { authorized: keys.has(command.args.ref) }
        }
        throw new TypeError("Unexpected helper command")
      },
    },
  })
  const settings = createSettingsHandlers({ directory, reconciler, mutateSettings })
  return {
    directory,
    handlers,
    settings,
    keys,
    inaccessible,
    denied,
    commands,
    applied,
    current: () => current,
  }
}

function startServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { baseUrl: `${server.url}v1`, stop: () => server.stop(true) }
}

function toolResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "record_summary",
                arguments: JSON.stringify({
                  title: "Synthetic connection check",
                  description: ["A fictional test completed."],
                  memorySummary: "No user activity was sent.",
                  apps: [],
                  domains: [],
                  citations: [],
                  sourceIds: [],
                }),
              },
            },
          ],
        },
      },
    ],
  })
}

function gate() {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release: () => release() }
}

test("provider key status and explicit authorization disclose no key and make no model call", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  const secret = `synthetic-${randomUUID()}`
  try {
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: false, accessible: false } })
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const provider = fixtureValue.current().providers[0]
    const ref = apiKeyRefOf(provider)
    if (!ref) throw new TypeError("Missing synthetic key ref")
    fixtureValue.inaccessible.add(ref)
    const status = await handleRpcBody(
      rpc("providers.keyStatus", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(status).toMatchObject({ result: { stored: null, accessible: null } })
    const authorization = await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(authorization).toMatchObject({ result: { authorized: true } })
    const afterAuthorization = await handleRpcBody(
      rpc("providers.keyStatus", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(afterAuthorization).toMatchObject({ result: { stored: true, accessible: true } })
    expect(JSON.stringify([status, authorization, afterAuthorization])).not.toContain(secret)
    expect(fixtureValue.commands.map((command) => command.name)).toEqual([
      "keychain.set",
      "keychain.authorize",
    ])
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("failed Keychain read invalidates prior authorization until explicitly authorized again", async () => {
  let failGet = false
  const fixtureValue = await fixture("http://127.0.0.1:1/v1", true, async () => {
    if (failGet) throw new HelperCommandTimeoutError("synthetic-command")
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    expect(
      await handleRpcBody(
        rpc("providers.authorizeKey", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { authorized: true } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
    failGet = true
    const modelList = await handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(modelList).toMatchObject({
      result: { status: "unavailable", reason: "key-unavailable" },
    })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: null, accessible: null } })
    expect(JSON.stringify(modelList)).not.toContain("synthetic-secret")
    failGet = false
    expect(
      await handleRpcBody(
        rpc("providers.authorizeKey", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { authorized: true } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    if (!ref) throw new TypeError("Missing synthetic key ref")
    fixtureValue.keys.delete(ref)
    expect(
      await handleRpcBody(
        rpc("providers.listModels", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { status: "unavailable", reason: "key-unavailable" } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: null, accessible: null } })
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given an authorized key, when provider test key read fails, then key status becomes unknown", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1", true, async () => {
    throw new HelperCommandTimeoutError("synthetic-command")
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })

    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )

    expect(response).toMatchObject({ result: { ok: false } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: null, accessible: null } })
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given an authorized key, when provider test key read is empty, then key status becomes unknown", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    if (!ref) throw new TypeError("Missing synthetic key ref")
    fixtureValue.keys.delete(ref)

    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )

    expect(response).toMatchObject({ result: { ok: false } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: null, accessible: null } })
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("key status rejects stale provider settings without exposing a previous key", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: "http://127.0.0.1:2/v1", models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    const afterPatch = await handleRpcBody(
      rpc("providers.keyStatus", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(afterPatch).toMatchObject({ result: { stored: false, accessible: false } })
    expect(fixtureValue.commands.map((command) => command.name)).toEqual([
      "keychain.set",
      "keychain.authorize",
    ])
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("key status returns unknown promptly without touching a blocked Keychain helper", async () => {
  const fixtureValue = await fixture(
    "http://127.0.0.1:1/v1",
    true,
    undefined,
    undefined,
    async () => {
      throw new HelperCommandTimeoutError("synthetic-command")
    },
  )
  const secret = `synthetic-${randomUUID()}`
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const response = await handleRpcBody(
      rpc("providers.keyStatus", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({ result: { stored: null, accessible: null } })
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(fixtureValue.commands.map((command) => command.name)).toEqual(["keychain.set"])
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("denied authorization leaves key access unknown without a status query", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    if (!ref) throw new TypeError("Missing synthetic key ref")
    fixtureValue.denied.add(ref)
    expect(
      await handleRpcBody(
        rpc("providers.authorizeKey", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { authorized: false } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: null, accessible: null } })
    expect(fixtureValue.commands.map((command) => command.name)).toEqual([
      "keychain.set",
      "keychain.authorize",
    ])
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("unknown provider identity cannot inspect or authorize a Keychain account", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  try {
    for (const method of ["providers.keyStatus", "providers.authorizeKey"]) {
      expect(
        await handleRpcBody(rpc(method, { providerId: "missing" }), fixtureValue.handlers),
      ).toMatchObject({ error: { code: -32603, message: "Internal error" } })
    }
    expect(fixtureValue.commands).toEqual([])
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("explicit Keychain authorization gets longer than a background helper command", async () => {
  const { client, clock, input, running } = harness()
  await client.waitForHello()
  let timedOut = false
  const authorization = client
    .sendCommand({
      type: "command",
      name: "keychain.authorize",
      args: { ref: "provider/synthetic" },
    })
    .catch((error: unknown) => {
      timedOut = true
      return error
    })
  clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
  await Promise.resolve()
  expect(timedOut).toBe(false)
  clock.advanceBy(120_000 - HELPER_COMMAND_TIMEOUT_MS)
  expect(await authorization).toBeInstanceOf(HelperCommandTimeoutError)
  input.end()
  await running
})

test("Given a configured provider, when setting a key, then only its Keychain ref is saved", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  const secret = `synthetic-${randomUUID()}`
  try {
    const response = await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    expect(ref).toBeTruthy()
    if (ref === undefined) throw new TypeError("Missing Keychain reference")
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { apiKeyRef: ref } })
    expect(fixtureValue.commands).toEqual([
      { type: "command", name: "keychain.set", args: { ref, secret } },
    ])
    expect(fixtureValue.keys.get(ref ?? "")).toBe(secret)
    expect(fixtureValue.applied).toHaveLength(1)
    expect(apiKeyRefOf((await loadSettings(fixtureValue.directory)).providers[0])).toBe(ref)
    const persisted = readFileSync(join(fixtureValue.directory, "settings.json"), "utf8")
    expect(persisted).not.toContain(secret)
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(statSync(join(fixtureValue.directory, "settings.json")).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given one endpoint, when its key rotates, then one Keychain account is updated", async () => {
  const fixtureValue = await fixture("https://same.fixture.invalid/v1")
  try {
    const first = await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-first" }),
      fixtureValue.handlers,
    )
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    const second = await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-second" }),
      fixtureValue.handlers,
    )
    expect(first).toMatchObject({ result: { apiKeyRef: ref } })
    expect(second).toMatchObject({ result: { apiKeyRef: ref } })
    expect(fixtureValue.keys.size).toBe(1)
    expect(fixtureValue.keys.get(ref ?? "")).toBe("synthetic-second")
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a linked legacy ref on the same endpoint, when its key rotates, then that account is reused", async () => {
  const legacyRef = `provider/synthetic/${randomUUID()}`
  const fixtureValue = await fixture(
    "https://legacy.fixture.invalid/v1",
    true,
    undefined,
    legacyRef,
  )
  try {
    const response = await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-rotated" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({ result: { apiKeyRef: legacyRef } })
    expect(fixtureValue.keys.get(legacyRef)).toBe("synthetic-rotated")
    expect(fixtureValue.keys.size).toBe(1)
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a Side provider with a Keychain key, when listing models, then only normalized IDs are returned", async () => {
  let requestPath = ""
  let requestMethod = ""
  let authorization = ""
  const server = startServer((request) => {
    requestPath = new URL(request.url).pathname
    requestMethod = request.method
    authorization = request.headers.get("authorization") ?? ""
    return Response.json({
      data: [
        { id: " alpha ", owned_by: "private-provider-detail" },
        { id: "beta" },
        { id: "alpha" },
      ],
      private_metadata: "do-not-return",
    })
  })
  const fixtureValue = await fixture(server.baseUrl)
  const secret = `synthetic-${randomUUID()}`
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const result = await handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "available", models: ["alpha", "beta"] },
    })
    expect(requestPath).toBe("/v1/models")
    expect(requestMethod).toBe("GET")
    expect(authorization).toBe(`Bearer ${secret}`)
    expect(fixtureValue.commands.map((command) => command.name)).toEqual([
      "keychain.set",
      "keychain.get",
    ])
    expect(fixtureValue.current().providers[0]?.models).toEqual(["probe-model"])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("private-provider-detail")
    expect(JSON.stringify(result)).not.toContain("do-not-return")
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given distinct providers A and B, removing A leaves B's key and sends only B's key to B", async () => {
  let aCalls = 0
  const a = startServer(() => {
    aCalls++
    return toolResponse()
  })
  const bAuthorizations: string[] = []
  const b = startServer((request) => {
    bAuthorizations.push(request.headers.get("authorization") ?? "")
    return request.url.endsWith("/models")
      ? Response.json({ data: [{ id: "probe-model" }] })
      : toolResponse()
  })
  const fixtureValue = await fixture(a.baseUrl)
  try {
    expect(
      await handleRpcBody(
        rpc("settings.patch", {
          providers: [
            { id: "synthetic", baseUrl: a.baseUrl, models: ["probe-model"] },
            { id: "b", baseUrl: b.baseUrl, models: ["probe-model"] },
          ],
        }),
        fixtureValue.settings,
      ),
    ).toHaveProperty("result")
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "key-a" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "b", apiKey: "key-b" }),
      fixtureValue.handlers,
    )
    const bRef = apiKeyRefOf(fixtureValue.current().providers[1])
    expect(bRef).toBeTruthy()
    expect(
      await handleRpcBody(
        rpc("settings.patch", {
          providers: [{ id: "b", baseUrl: b.baseUrl, models: ["probe-model"] }],
        }),
        fixtureValue.settings,
      ),
    ).toHaveProperty("result")
    expect(apiKeyRefOf((await loadSettings(fixtureValue.directory)).providers[0])).toBe(bRef)
    expect(
      await handleRpcBody(rpc("providers.listModels", { providerId: "b" }), fixtureValue.handlers),
    ).toMatchObject({ result: { status: "available", models: ["probe-model"] } })
    expect(
      await handleRpcBody(
        rpc("providers.test", { providerId: "b", modelId: "probe-model" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { ok: true } })
    expect(aCalls).toBe(0)
    expect(bAuthorizations).toEqual(["Bearer key-b", "Bearer key-b"])
  } finally {
    a.stop()
    b.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given an unknown provider or missing key, when listing models, then no network request is sent", async () => {
  let calls = 0
  const server = startServer(() => {
    calls++
    return Response.json({ data: [] })
  })
  const fixtureValue = await fixture(server.baseUrl)
  try {
    expect(
      await handleRpcBody(
        rpc("providers.listModels", { providerId: "missing" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { status: "unavailable", models: [], reason: "provider-not-found" } })
    expect(
      await handleRpcBody(
        rpc("providers.listModels", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { status: "unavailable", models: [], reason: "key-not-configured" } })
    expect(calls).toBe(0)
    expect(fixtureValue.commands).toHaveLength(0)
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given ambiguous provider IDs in current state, provider RPCs fail closed before helper or network calls", async () => {
  const valid = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [{ id: "p", baseUrl: "https://a.fixture.invalid/v1", models: ["m"] }],
  })
  const provider = valid.providers[0]
  if (!provider || provider.kind === "claude-code-cli" || provider.kind === "codex-cli")
    throw new TypeError("Missing OpenAI provider fixture")
  const current: Settings = {
    ...valid,
    providers: [provider, { ...provider, baseUrl: "https://b.fixture.invalid/v1" }],
  }
  let helperCalls = 0
  const handlers = createProviderHandlers({
    directory: "unused",
    reconciler: {
      currentSettings: current,
      async settingsPatched() {
        throw new TypeError("Must not reconcile")
      },
    },
    helper: {
      async sendCommand() {
        helperCalls++
        throw new TypeError("Must not access Keychain")
      },
    },
  })
  expect(
    await handleRpcBody(rpc("providers.setKey", { providerId: "p", apiKey: "key-a" }), handlers),
  ).toMatchObject({ error: { code: -32603 } })
  expect(
    await handleRpcBody(rpc("providers.listModels", { providerId: "p" }), handlers),
  ).toMatchObject({
    result: { status: "unavailable", reason: "provider-not-found" },
  })
  expect(
    await handleRpcBody(rpc("providers.test", { providerId: "p", modelId: "m" }), handlers),
  ).toMatchObject({ result: { ok: false } })
  expect(helperCalls).toBe(0)
})

test("Claude Code CLI rejects key storage and HTTP model discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-claude-provider-"))
  const current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [
      {
        id: "Claude Code",
        kind: "claude-code-cli",
        models: ["claude-synthetic"],
        allowEvidence: false,
      },
    ],
  })
  let helperCalls = 0
  const handlers = createProviderHandlers({
    directory,
    reconciler: {
      currentSettings: current,
      async settingsPatched() {},
    },
    helper: {
      async sendCommand() {
        helperCalls++
        throw new TypeError("Unexpected helper call")
      },
    },
  })
  try {
    expect(
      await handleRpcBody(
        rpc("providers.setKey", { providerId: "Claude Code", apiKey: "synthetic-secret" }),
        handlers,
      ),
    ).toMatchObject({ error: { code: -32603, message: "Internal error" } })
    expect(
      await handleRpcBody(rpc("providers.listModels", { providerId: "Claude Code" }), handlers),
    ).toMatchObject({ result: { status: "unavailable", reason: "endpoint-unavailable" } })
    expect(helperCalls).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Codex CLI rejects key storage and HTTP model discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-codex-provider-"))
  const current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [{ id: "Codex", kind: "codex-cli", models: ["gpt-6-luna"], allowEvidence: false }],
  })
  let helperCalls = 0
  const handlers = createProviderHandlers({
    directory,
    reconciler: { currentSettings: current, async settingsPatched() {} },
    helper: {
      async sendCommand() {
        helperCalls++
        throw new TypeError("Unexpected helper call")
      },
    },
  })
  try {
    expect(
      await handleRpcBody(
        rpc("providers.setKey", { providerId: "Codex", apiKey: "synthetic-secret" }),
        handlers,
      ),
    ).toMatchObject({ error: { code: -32603, message: "Internal error" } })
    expect(
      await handleRpcBody(rpc("providers.listModels", { providerId: "Codex" }), handlers),
    ).toMatchObject({ result: { status: "unavailable", reason: "endpoint-unavailable" } })
    expect(helperCalls).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an unavailable model endpoint, when listing models, then manual entry remains possible", async () => {
  const server = startServer(() =>
    Response.json({ error: "private upstream detail" }, { status: 404 }),
  )
  const fixtureValue = await fixture(server.baseUrl)
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    const result = await handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(result).toMatchObject({
      result: {
        status: "unavailable",
        models: [],
        reason: "endpoint-unavailable",
        httpStatus: 404,
      },
    })
    expect(JSON.stringify(result)).not.toContain("private upstream detail")
    expect(fixtureValue.current().providers[0]?.models).toEqual(["probe-model"])
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a cross-origin redirect, when listing models, then the Keychain key never reaches the target", async () => {
  let redirectedCalls = 0
  const target = startServer(() => {
    redirectedCalls++
    return Response.json({ data: [{ id: "stolen" }] })
  })
  const source = startServer(() => Response.redirect(`${target.baseUrl}/models`, 307))
  const fixtureValue = await fixture(source.baseUrl)
  const secret = `synthetic-${randomUUID()}`
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const result = await handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(result).toMatchObject({
      result: { status: "unavailable", models: [], reason: "redirect-blocked", httpStatus: 307 },
    })
    expect(redirectedCalls).toBe(0)
    expect(JSON.stringify(result)).not.toContain(secret)
  } finally {
    source.stop()
    target.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a malformed model response, when listing models, then raw upstream data is not exposed", async () => {
  const server = startServer(() => Response.json({ error: "private upstream detail" }))
  const fixtureValue = await fixture(server.baseUrl)
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    const result = await handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    expect(result).toMatchObject({
      result: { status: "unavailable", models: [], reason: "invalid-response" },
    })
    expect(JSON.stringify(result)).not.toContain("private upstream detail")
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a concurrent settings patch while Keychain is pending, setting a provider key preserves the patch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-provider-race-"))
  let current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [
      {
        id: "synthetic",
        baseUrl: "https://fixture.invalid/v1",
        models: ["probe-model"],
      },
    ],
  })
  await saveSettings(directory, current)
  const reconciler = {
    get currentSettings() {
      return current
    },
    async settingsPatched(next: Settings) {
      current = next
    },
  }
  let enteredKeychain: () => void = () => {}
  let releaseKeychain: () => void = () => {}
  const keychainEntered = new Promise<void>((resolve) => {
    enteredKeychain = resolve
  })
  const keychainWait = new Promise<void>((resolve) => {
    releaseKeychain = resolve
  })
  const mutateSettings = createSettingsMutation(reconciler, (next) => saveSettings(directory, next))
  const providers = createProviderHandlers({
    directory,
    reconciler,
    mutateSettings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "keychain.set") throw new TypeError("Unexpected helper command")
        enteredKeychain()
        await keychainWait
        return { ref: command.args.ref }
      },
    },
  })
  const settings = createSettingsHandlers({ directory, reconciler, mutateSettings })
  try {
    const settingKey = handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      providers,
    )
    await keychainEntered
    await handleRpcBody(rpc("settings.patch", { captureTypedText: false }), settings)
    releaseKeychain()
    await settingKey
    expect(current.contextAwareness.captureTypedText).toBe(false)
    expect(apiKeyRefOf(current.providers[0])).toMatch(/^provider\/synthetic\/[a-f0-9-]+$/)
    expect((await loadSettings(directory)).contextAwareness.captureTypedText).toBe(false)
  } finally {
    releaseKeychain()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("A pending key write cannot attach its credential after the provider URL changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-provider-host-race-"))
  let current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [{ id: "synthetic", baseUrl: "https://first.fixture.invalid/v1", models: ["m"] }],
  })
  await saveSettings(directory, current)
  const reconciler = {
    get currentSettings() {
      return current
    },
    async settingsPatched(next: Settings) {
      current = next
    },
  }
  let entered: () => void = () => {}
  let release: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const mutateSettings = createSettingsMutation(reconciler, (next) => saveSettings(directory, next))
  const providers = createProviderHandlers({
    directory,
    reconciler,
    mutateSettings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "keychain.set") throw new TypeError("Unexpected helper command")
        entered()
        await gate
        return { ref: command.args.ref }
      },
    },
  })
  const settings = createSettingsHandlers({ directory, reconciler, mutateSettings })
  try {
    const pending = handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      providers,
    )
    await waiting
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          { id: "synthetic", baseUrl: "https://second.fixture.invalid/v1", models: ["m"] },
        ],
      }),
      settings,
    )
    release()
    expect(await pending).toMatchObject({ error: { code: -32603 } })
    expect(apiKeyRefOf(current.providers[0])).toBeUndefined()
  } finally {
    release()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a stale key write for A, changing to B keeps B's credential binding intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-provider-stale-key-"))
  let current = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [{ id: "p", baseUrl: "https://a.fixture.invalid/v1", models: ["m"] }],
  })
  await saveSettings(directory, current)
  const keys = new Map<string, string>()
  const entered = gate()
  const release = gate()
  const reconciler = {
    get currentSettings() {
      return current
    },
    async settingsPatched(next: Settings) {
      current = next
    },
  }
  const mutateSettings = createSettingsMutation(reconciler, (next) => saveSettings(directory, next))
  const providers = createProviderHandlers({
    directory,
    reconciler,
    mutateSettings,
    helper: {
      async sendCommand(command) {
        if (command.name !== "keychain.set") throw new TypeError("Unexpected helper command")
        if (command.args.secret === "key-a") {
          entered.release()
          await release.wait
        }
        keys.set(command.args.ref, command.args.secret)
        return { ref: command.args.ref }
      },
    },
  })
  const settings = createSettingsHandlers({ directory, reconciler, mutateSettings })
  try {
    const stale = handleRpcBody(
      rpc("providers.setKey", { providerId: "p", apiKey: "key-a" }),
      providers,
    )
    await entered.wait
    expect(
      await handleRpcBody(
        rpc("settings.patch", {
          providers: [{ id: "p", baseUrl: "https://b.fixture.invalid/v1", models: ["m"] }],
        }),
        settings,
      ),
    ).toHaveProperty("result")
    const fresh = await handleRpcBody(
      rpc("providers.setKey", { providerId: "p", apiKey: "key-b" }),
      providers,
    )
    const bRef = apiKeyRefOf(current.providers[0])
    expect(fresh).toMatchObject({ result: { apiKeyRef: bRef } })
    release.release()
    expect(await stale).toMatchObject({ error: { code: -32603 } })
    expect(keys.size).toBe(2)
    expect(keys.get(bRef ?? "")).toBe("key-b")
    expect(apiKeyRefOf((await loadSettings(directory)).providers[0])).toBe(bRef)
  } finally {
    release.release()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an unknown provider or helper failure, when setting a key, then settings stay unchanged", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  const secret = `synthetic-${randomUUID()}`
  try {
    const before = readFileSync(join(fixtureValue.directory, "settings.json"), "utf8")
    const unknown = await handleRpcBody(
      rpc("providers.setKey", { providerId: "missing", apiKey: secret }),
      fixtureValue.handlers,
    )
    expect(unknown).toMatchObject({ error: { code: -32603 } })
    expect(fixtureValue.commands).toHaveLength(0)
    const failed = createProviderHandlers({
      directory: fixtureValue.directory,
      reconciler: {
        get currentSettings() {
          return fixtureValue.current()
        },
        async settingsPatched() {
          throw new TypeError("Must not reconcile")
        },
      },
      helper: {
        async sendCommand() {
          throw new TypeError("Synthetic helper unavailable")
        },
      },
    })
    const response = await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      failed,
    )
    expect(response).toMatchObject({ error: { code: -32603 } })
    expect(readFileSync(join(fixtureValue.directory, "settings.json"), "utf8")).toBe(before)
    expect(JSON.stringify([unknown, response])).not.toContain(secret)
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given two busy summary slots, a queued synthetic provider test succeeds after a slot opens", async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reachedTwo: () => void = () => {}
  const twoStarted = new Promise<void>((resolve) => {
    reachedTwo = resolve
  })
  const server = startServer(async () => {
    calls++
    if (calls === 2) reachedTwo()
    if (calls <= 2) await gate
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl)
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    const configured = fixtureValue.current().providers[0]
    if (!configured) throw new TypeError("Missing synthetic provider")
    const model = { provider: configured, modelId: "probe-model" }
    const messages = [{ role: "user" as const, content: "Synthetic call" }]
    const active = Array.from({ length: 2 }, () =>
      callSummaryCompletion(model, messages, { getApiKey: async () => "synthetic-secret" }),
    )
    await twoStarted
    const pending = handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    await Bun.sleep(100)
    expect(calls).toBe(2)
    release()
    const response = await pending
    await Promise.all(active)
    expect(response).toMatchObject({ result: { ok: true } })
    expect(calls).toBe(3)
  } finally {
    release()
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a queued provider test and a replaced provider URL, the new key never reaches the old URL", async () => {
  const occupied = gate()
  const twoStarted = gate()
  const oldAuthorizations: string[] = []
  const oldServer = startServer(async (request) => {
    oldAuthorizations.push(request.headers.get("authorization") ?? "")
    if (oldAuthorizations.length === 2) twoStarted.release()
    await occupied.wait
    return toolResponse()
  })
  let newCalls = 0
  const newServer = startServer(() => {
    newCalls++
    return toolResponse()
  })
  const fixtureValue = await fixture(oldServer.baseUrl)
  const oldKey = `old-${randomUUID()}`
  const newKey = `new-${randomUUID()}`
  const active: Promise<unknown>[] = []
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: oldKey }),
      fixtureValue.handlers,
    )
    const provider = fixtureValue.current().providers[0]
    if (!provider) throw new TypeError("Missing synthetic provider")
    const originalRef = apiKeyRefOf(provider)
    active.push(
      ...Array.from({ length: 2 }, () =>
        callSummaryCompletion(
          { provider, modelId: "probe-model" },
          [{ role: "user", content: "Synthetic call" }],
          { getApiKey: async () => oldKey },
        ),
      ),
    )
    await twoStarted.wait
    const pending = handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: newServer.baseUrl, models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: newKey }),
      fixtureValue.handlers,
    )
    const newRef = apiKeyRefOf(fixtureValue.current().providers[0])
    expect(newRef).not.toBe(originalRef)
    expect(fixtureValue.keys.get(originalRef ?? "")).toBe(oldKey)
    expect(fixtureValue.keys.get(newRef ?? "")).toBe(newKey)
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: oldServer.baseUrl, models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    const returnedKey = `returned-${randomUUID()}`
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: returnedKey }),
      fixtureValue.handlers,
    )
    const returnedRef = apiKeyRefOf(fixtureValue.current().providers[0])
    expect(returnedRef).toBe(originalRef)
    expect(returnedRef).not.toBe(newRef)
    expect(fixtureValue.keys.size).toBe(2)
    expect(fixtureValue.keys.get(returnedRef ?? "")).toBe(returnedKey)
    occupied.release()
    expect(await pending).toMatchObject({ result: { ok: false } })
    await Promise.all(active)
    expect(oldAuthorizations).toEqual([`Bearer ${oldKey}`, `Bearer ${oldKey}`])
    expect(
      await handleRpcBody(
        rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { ok: true } })
    expect(oldAuthorizations).toEqual([
      `Bearer ${oldKey}`,
      `Bearer ${oldKey}`,
      `Bearer ${returnedKey}`,
    ])
    expect(newCalls).toBe(0)
  } finally {
    occupied.release()
    await Promise.allSettled(active)
    oldServer.stop()
    newServer.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given an in-flight provider key read and a replaced URL, the new key never reaches the old test URL", async () => {
  const keyEntered = gate()
  const keyRelease = gate()
  const oldAuthorizations: string[] = []
  const oldServer = startServer((request) => {
    oldAuthorizations.push(request.headers.get("authorization") ?? "")
    return toolResponse()
  })
  const newServer = startServer(() => toolResponse())
  const fixtureValue = await fixture(oldServer.baseUrl, true, async () => {
    keyEntered.release()
    await keyRelease.wait
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: `old-${randomUUID()}` }),
      fixtureValue.handlers,
    )
    const pending = handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    await keyEntered.wait
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: newServer.baseUrl, models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: `new-${randomUUID()}` }),
      fixtureValue.handlers,
    )
    keyRelease.release()
    expect(await pending).toMatchObject({ result: { ok: false } })
    expect(oldAuthorizations).toEqual([])
  } finally {
    keyRelease.release()
    oldServer.stop()
    newServer.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("a background read started during authorization cannot undo its later success", async () => {
  const authorizationEntered = gate()
  const authorizationRelease = gate()
  let holdAuthorization = false
  const fixtureValue = await fixture(
    "http://127.0.0.1:1/v1",
    true,
    undefined,
    undefined,
    undefined,
    async () => {
      if (holdAuthorization) {
        authorizationEntered.release()
        await authorizationRelease.wait
      }
    },
  )
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "synthetic-secret" }),
      fixtureValue.handlers,
    )
    holdAuthorization = true
    const authorization = handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    await authorizationEntered.wait
    const staleReadFailed = fixtureValue.handlers.captureKeyReadInvalidation(fixtureValue.current())
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    if (!ref) throw new TypeError("Missing synthetic key ref")
    authorizationRelease.release()
    expect(await authorization).toMatchObject({ result: { authorized: true } })
    staleReadFailed(ref)
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
  } finally {
    authorizationRelease.release()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("a delayed background key failure cannot undo newer explicit authorization", async () => {
  const fixtureValue = await fixture("http://127.0.0.1:1/v1")
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "old-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    const ref = apiKeyRefOf(fixtureValue.current().providers[0])
    if (!ref) throw new TypeError("Missing synthetic key ref")
    const oldReadFailed = fixtureValue.handlers.captureKeyReadInvalidation(fixtureValue.current())

    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    oldReadFailed(ref)
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })

    const replacedReadFailed = fixtureValue.handlers.captureKeyReadInvalidation(
      fixtureValue.current(),
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "new-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    replacedReadFailed(ref)
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
  } finally {
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a newer authorized provider, when an old provider test key read fails, then new key status stays accessible", async () => {
  const keyEntered = gate()
  const keyRelease = gate()
  const fixtureValue = await fixture("http://127.0.0.1:1/v1", true, async () => {
    keyEntered.release()
    await keyRelease.wait
    throw new HelperCommandTimeoutError("synthetic-command")
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "old-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    const oldTest = handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    await keyEntered.wait
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: "http://127.0.0.1:2/v1", models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "new-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )

    keyRelease.release()
    expect(await oldTest).toMatchObject({ result: { ok: false } })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
  } finally {
    keyRelease.release()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a model removed during the provider key read, no completion is sent", async () => {
  const keyEntered = gate()
  const keyRelease = gate()
  let calls = 0
  const server = startServer(() => {
    calls++
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl, true, async () => {
    keyEntered.release()
    await keyRelease.wait
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: `synthetic-${randomUUID()}` }),
      fixtureValue.handlers,
    )
    const pending = handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    await keyEntered.wait
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: server.baseUrl, models: ["replacement-model"] }],
      }),
      fixtureValue.settings,
    )
    keyRelease.release()
    expect(await pending).toMatchObject({ result: { ok: false } })
    expect(calls).toBe(0)
  } finally {
    keyRelease.release()
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given an in-flight model-list key read and a replaced URL, the new key never reaches the old models URL", async () => {
  const keyEntered = gate()
  const keyRelease = gate()
  const oldAuthorizations: string[] = []
  const oldServer = startServer((request) => {
    oldAuthorizations.push(request.headers.get("authorization") ?? "")
    return Response.json({ data: [{ id: "old-model" }] })
  })
  const newServer = startServer(() => Response.json({ data: [{ id: "new-model" }] }))
  const fixtureValue = await fixture(oldServer.baseUrl, true, async () => {
    keyEntered.release()
    await keyRelease.wait
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: `old-${randomUUID()}` }),
      fixtureValue.handlers,
    )
    const pending = handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    await keyEntered.wait
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: newServer.baseUrl, models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: `new-${randomUUID()}` }),
      fixtureValue.handlers,
    )
    keyRelease.release()
    expect(await pending).toMatchObject({
      result: { status: "unavailable", models: [] },
    })
    expect(oldAuthorizations).toEqual([])
  } finally {
    keyRelease.release()
    oldServer.stop()
    newServer.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a newer authorized provider, when an old model-list key read fails, then new key status stays accessible", async () => {
  const keyEntered = gate()
  const keyRelease = gate()
  const fixtureValue = await fixture("http://127.0.0.1:1/v1", true, async () => {
    keyEntered.release()
    await keyRelease.wait
    throw new HelperCommandTimeoutError("synthetic-command")
  })
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "old-secret" }),
      fixtureValue.handlers,
    )
    const oldList = handleRpcBody(
      rpc("providers.listModels", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )
    await keyEntered.wait
    await handleRpcBody(
      rpc("settings.patch", {
        providers: [{ id: "synthetic", baseUrl: "http://127.0.0.1:2/v1", models: ["probe-model"] }],
      }),
      fixtureValue.settings,
    )
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: "new-secret" }),
      fixtureValue.handlers,
    )
    await handleRpcBody(
      rpc("providers.authorizeKey", { providerId: "synthetic" }),
      fixtureValue.handlers,
    )

    keyRelease.release()
    expect(await oldList).toMatchObject({
      result: { status: "unavailable", reason: "key-unavailable" },
    })
    expect(
      await handleRpcBody(
        rpc("providers.keyStatus", { providerId: "synthetic" }),
        fixtureValue.handlers,
      ),
    ).toMatchObject({ result: { stored: true, accessible: true } })
  } finally {
    keyRelease.release()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given occupied slots that never open, provider test returns a safe error and the slot queue recovers", async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reachedTwo: () => void = () => {}
  const twoStarted = new Promise<void>((resolve) => {
    reachedTwo = resolve
  })
  const server = startServer(async () => {
    calls++
    if (calls === 2) reachedTwo()
    if (calls <= 2) await gate
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl)
  const active: Promise<unknown>[] = []
  try {
    const configured = fixtureValue.current().providers[0]
    if (!configured) throw new TypeError("Missing synthetic provider")
    const model = { provider: configured, modelId: "probe-model" }
    const messages = [{ role: "user" as const, content: "Synthetic call" }]
    active.push(...Array.from({ length: 2 }, () => callSummaryCompletion(model, messages, {})))
    await twoStarted
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({ result: { ok: false, error: "Provider test failed" } })
    expect(calls).toBe(2)
    release()
    await Promise.all(active)
    const retry = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(retry).toMatchObject({ result: { ok: true } })
    expect(calls).toBe(3)
  } finally {
    release()
    await Promise.allSettled(active)
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
}, 15_000)

test("Given an evidence-disabled provider, when testing it, then one synthetic record_summary call uses the selected wire route", async () => {
  let calls = 0
  let path = ""
  let host = ""
  let auth = ""
  let body: unknown
  const server = startServer(async (request) => {
    calls++
    path = new URL(request.url).pathname
    host = request.headers.get("host") ?? ""
    auth = request.headers.get("authorization") ?? ""
    body = await request.json()
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl)
  const secret = `synthetic-${randomUUID()}`
  try {
    await handleRpcBody(
      rpc("providers.setKey", { providerId: "synthetic", apiKey: secret }),
      fixtureValue.handlers,
    )
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({
      result: { ok: true, toolChoiceSupported: true },
    })
    expect(response).toHaveProperty("result.latencyMs")
    expect(calls).toBe(1)
    expect(path).toBe("/v1/chat/completions")
    expect(host).toBe(new URL(server.baseUrl).host)
    expect(auth).toBe(`Bearer ${secret}`)
    expect(body).toMatchObject({
      model: "probe-model",
      tool_choice: { type: "function", function: { name: "record_summary" } },
      tools: [{ type: "function", function: { name: "record_summary" } }],
      messages: [{ role: "system" }, { role: "user" }],
    })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toContain("e:")
    expect(JSON.stringify(body)).not.toContain("s:")
    expect(JSON.stringify(response)).not.toContain(secret)
    expect(readFileSync(join(fixtureValue.directory, "settings.json"), "utf8")).not.toContain(
      secret,
    )
    expect(fixtureValue.commands.map((command) => command.name)).toEqual([
      "keychain.set",
      "keychain.get",
    ])
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a tool-choice-disabled provider, when testing, then a valid tool call does not claim forced support", async () => {
  let body: unknown
  const server = startServer(async (request) => {
    body = await request.json()
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl, false)
  try {
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({ result: { ok: true, toolChoiceSupported: false } })
    expect(body).toMatchObject({ tool_choice: "auto" })
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a model outside the provider list, when testing, then no completion is sent", async () => {
  let calls = 0
  const server = startServer(() => {
    calls++
    return toolResponse()
  })
  const fixtureValue = await fixture(server.baseUrl)
  try {
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "other-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({
      result: { ok: false, toolChoiceSupported: false, error: expect.any(String) },
    })
    expect(calls).toBe(0)
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a malformed summary, when testing, then no repair call is sent", async () => {
  let calls = 0
  const server = startServer(() => {
    calls++
    return Response.json({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "record_summary", arguments: JSON.stringify({ title: "" }) } },
            ],
          },
        },
      ],
    })
  })
  const fixtureValue = await fixture(server.baseUrl)
  try {
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({
      result: {
        ok: false,
        toolChoiceSupported: false,
        error: "record_summary response failed validation",
      },
    })
    expect(calls).toBe(1)
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})

test("Given a failing provider, when testing, then one call reports a safe error and no user activity", async () => {
  let calls = 0
  const server = startServer(() => {
    calls++
    return Response.json({ error: "synthetic secret should not be surfaced" }, { status: 401 })
  })
  const fixtureValue = await fixture(server.baseUrl)
  try {
    const response = await handleRpcBody(
      rpc("providers.test", { providerId: "synthetic", modelId: "probe-model" }),
      fixtureValue.handlers,
    )
    expect(response).toMatchObject({
      result: { ok: false, toolChoiceSupported: false, error: expect.any(String) },
    })
    expect(calls).toBe(1)
    expect(JSON.stringify(response)).not.toContain("synthetic secret should not be surfaced")
    expect(readFileSync(join(fixtureValue.directory, "settings.json"), "utf8")).not.toContain(
      "synthetic secret should not be surfaced",
    )
  } finally {
    server.stop()
    rmSync(fixtureValue.directory, { recursive: true, force: true })
  }
})
