import { expect, test } from "bun:test"
import type { Briefing } from "../../src/comprehension/briefing"
import {
  AllProvidersFailedError,
  callSummaryCompletion,
  EvidencePermissionRevokedError,
  resolveSummaryChain,
  summarizeBriefing,
} from "../../src/comprehension/providers"
import { SummaryContractError } from "../../src/comprehension/repair"
import { type Settings, SettingsSchema } from "../../src/contracts/settings"
import { HelperCommandFailureError } from "../../src/helper/client"

const ref = `e:${"0".repeat(26)}`
const briefing: Briefing = {
  text: `Synthetic Example page ${ref}`,
  evidenceIds: new Set([ref]),
  apps: new Set(["Example"]),
  domains: new Set(["example.com"]),
}
const valid = {
  title: "Example activity",
  description: ["Reviewed an example page."],
  memorySummary: "The user reviewed an example page.",
  apps: ["Example"],
  domains: ["example.com"],
  citations: [{ ref }],
  sourceIds: [ref],
}

function provider(
  id: string,
  baseUrl: string,
  allowEvidence = true,
  supportsToolChoice = true,
): Extract<Settings["providers"][number], { baseUrl: string }> {
  return { id, baseUrl, models: [id], allowEvidence, supportsToolChoice }
}

function settings(
  providers: ReturnType<typeof provider>[],
  summaryModel?: { provider: string; modelId: string },
  defaultModel?: { provider: string; modelId: string },
  modelOverrides: {
    match: string
    reasoningEffort: "low" | "medium" | "high"
    fastMode: boolean
  }[] = [],
) {
  return SettingsSchema.parse({
    version: 2,
    contextAwareness: { enabled: true, summaryModel },
    defaultModel,
    providers,
    summary: { modelOverrides },
  })
}

function startServer(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  return { baseUrl: `${server.url}v1`, stop: () => server.stop(true) }
}

function toolResponse(argumentsValue: object, usage?: object): Response {
  return Response.json({
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "record_summary", arguments: JSON.stringify(argumentsValue) } },
          ],
        },
      },
    ],
    usage,
  })
}

test("Given selected and default models, when resolving, then selected leads and first override wins", () => {
  const config = settings(
    [provider("second", "http://127.0.0.1:1/v1"), provider("first", "http://127.0.0.1:2/v1")],
    { provider: "first", modelId: "mimo-v2.6-pro" },
    { provider: "second", modelId: "second" },
    [
      { match: "^mimo-", reasoningEffort: "high", fastMode: true },
      { match: "v2\\.6", reasoningEffort: "low", fastMode: false },
    ],
  )
  const chain = resolveSummaryChain(config)
  expect(chain.map(({ provider, modelId }) => `${provider.id}/${modelId}`)).toEqual([
    "first/mimo-v2.6-pro",
    "second/second",
    "first/first",
  ])
  expect(chain[0]?.reasoningEffort).toBe("high")
  expect(chain[0]?.fastMode).toBe(true)
})

test("Given no configured model, when summarizing, then no-summary-model returns without HTTP", async () => {
  const result = await summarizeBriefing({ settings: settings([]), briefing })
  expect(result).toEqual({ state: "no-summary-model" })
})

test("Given only disallowed providers, when summarizing, then the evidence never reaches HTTP", async () => {
  let calls = 0
  const server = startServer(() => {
    calls++
    return toolResponse(valid)
  })
  try {
    const config = settings([provider("blocked", server.baseUrl, false)], {
      provider: "blocked",
      modelId: "blocked",
    })
    await expect(summarizeBriefing({ settings: config, briefing })).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    )
    expect(calls).toBe(0)
  } finally {
    server.stop()
  }
})

test.each([400, 401, 403, 408, 429, 500, 503])(
  "Given first provider HTTP %i, when summarizing, then second provider succeeds",
  async (status) => {
    const first = startServer(() => Response.json({ error: "synthetic" }, { status }))
    const second = startServer(() =>
      toolResponse(valid, { prompt_tokens: 12, completion_tokens: 7 }),
    )
    const logs: unknown[] = []
    try {
      const config = settings(
        [provider("first", first.baseUrl), provider("second", second.baseUrl)],
        { provider: "first", modelId: "first" },
      )
      const result = await summarizeBriefing({
        settings: config,
        briefing,
        log: (entry) => logs.push(entry),
      })
      expect(result.state).toBe("done")
      if (result.state !== "done") return
      expect(result.model).toBe("second/second")
      expect(result.summary.title).toBe(valid.title)
      expect(result.inputTokens).toBe(12)
      expect(result.outputTokens).toBe(7)
      expect(logs[0]).toMatchObject({ provider: "first", status })
    } finally {
      first.stop()
      second.stop()
    }
  },
)

test("a model key permission failure falls back before sending evidence", async () => {
  let firstCalls = 0
  let secondCalls = 0
  const first = startServer(() => {
    firstCalls++
    return toolResponse(valid)
  })
  const second = startServer(() => {
    secondCalls++
    return toolResponse(valid)
  })
  try {
    const config = settings(
      [
        { ...provider("first", first.baseUrl), apiKeyRef: "first-key" },
        { ...provider("second", second.baseUrl), apiKeyRef: "second-key" },
      ],
      { provider: "first", modelId: "first" },
    )
    const result = await summarizeBriefing({
      settings: config,
      briefing,
      getApiKey: async (ref) => {
        if (ref === "first-key") throw new HelperCommandFailureError("1", "keychain-unavailable")
        return "synthetic-only"
      },
    })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.model).toBe("second/second")
    expect(firstCalls).toBe(0)
    expect(secondCalls).toBe(1)
  } finally {
    first.stop()
    second.stop()
  }
})

test("Given bad response JSON and no usable JSON content, when summarizing, then later candidates are tried", async () => {
  let calls = 0
  const first = startServer(() => {
    calls++
    return new Response("{broken")
  })
  const second = startServer(() => {
    calls++
    return Response.json({ choices: [{ message: { content: "No structured data" } }] })
  })
  const third = startServer(() => {
    calls++
    return toolResponse(valid)
  })
  try {
    const config = settings(
      [
        provider("first", first.baseUrl),
        provider("second", second.baseUrl),
        provider("third", third.baseUrl),
      ],
      { provider: "first", modelId: "first" },
    )
    const result = await summarizeBriefing({ settings: config, briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.model).toBe("third/third")
    expect(calls).toBe(3)
  } finally {
    first.stop()
    second.stop()
    third.stop()
  }
})

test("Given tool_choice unsupported, when provider returns a JSON object in content, then it is validated", async () => {
  let requestBody: unknown
  const server = startServer(async (request) => {
    requestBody = await request.json()
    return Response.json({
      choices: [{ message: { tool_calls: null, content: `Result: ${JSON.stringify(valid)}` } }],
      usage: null,
    })
  })
  try {
    const config = settings([provider("mimo", server.baseUrl, true, false)], {
      provider: "mimo",
      modelId: "mimo-v2.6-pro",
    })
    const result = await summarizeBriefing({ settings: config, briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.summary.title).toBe(valid.title)
    expect(requestBody).toMatchObject({
      model: "mimo-v2.6-pro",
      tool_choice: "auto",
      max_tokens: 4096,
      temperature: 0.2,
    })
  } finally {
    server.stop()
  }
})

test.each(["duplicate", "wrong-name"])(
  "Given %s tool calls plus valid content, when summarizing, then content cannot bypass the tool contract",
  async (kind) => {
    let firstCalls = 0
    const invalid = startServer(() => {
      firstCalls++
      const call = { function: { name: "record_summary", arguments: JSON.stringify(valid) } }
      return Response.json({
        choices: [
          {
            message: {
              tool_calls:
                kind === "duplicate"
                  ? [call, call]
                  : [{ function: { ...call.function, name: "other_tool" } }],
              content: JSON.stringify(valid),
            },
          },
        ],
      })
    })
    const next = startServer(() => toolResponse(valid))
    try {
      const config = settings(
        [provider("invalid", invalid.baseUrl), provider("next", next.baseUrl)],
        { provider: "invalid", modelId: "invalid" },
      )
      const result = await summarizeBriefing({ settings: config, briefing })
      expect(result.state).toBe("done")
      if (result.state === "done") expect(result.model).toBe("next/next")
      expect(firstCalls).toBe(1)
    } finally {
      invalid.stop()
      next.stop()
    }
  },
)

test("Given one contract violation, when repaired, then two calls use the same model and aggregate usage", async () => {
  const bodies: unknown[] = []
  const server = startServer(async (request) => {
    bodies.push(await request.json())
    return toolResponse(bodies.length === 1 ? { ...valid, title: "" } : valid, {
      prompt_tokens: 4,
      completion_tokens: 2,
    })
  })
  try {
    const config = settings([provider("minimax", server.baseUrl)], {
      provider: "minimax",
      modelId: "MiniMax-M3",
    })
    const result = await summarizeBriefing({ settings: config, briefing })
    expect(result.state).toBe("done")
    if (result.state !== "done") return
    expect(result.model).toBe("minimax/MiniMax-M3")
    expect(result.inputTokens).toBe(8)
    expect(result.outputTokens).toBe(4)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({
      messages: [{ role: "system" }, { role: "user" }, { role: "user" }],
    })
  } finally {
    server.stop()
  }
})

test("Given two contract violations, when repaired once, then the attempt fails without another provider", async () => {
  let calls = 0
  const first = startServer(() => {
    calls++
    return toolResponse({ ...valid, title: "" })
  })
  const second = startServer(() => {
    calls++
    return toolResponse(valid)
  })
  try {
    const config = settings(
      [provider("first", first.baseUrl), provider("second", second.baseUrl)],
      { provider: "first", modelId: "first" },
    )
    await expect(summarizeBriefing({ settings: config, briefing })).rejects.toBeInstanceOf(
      SummaryContractError,
    )
    expect(calls).toBe(2)
  } finally {
    first.stop()
    second.stop()
  }
})

test("Given a refused connection, when summarizing, then the next fake endpoint is used", async () => {
  const second = startServer(() => toolResponse(valid))
  try {
    const config = settings(
      [provider("offline", "http://127.0.0.1:1/v1"), provider("second", second.baseUrl)],
      { provider: "offline", modelId: "offline" },
    )
    const result = await summarizeBriefing({ settings: config, briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.model).toBe("second/second")
  } finally {
    second.stop()
  }
})

test("Given a default model only, when summarizing, then its direct endpoint receives the approved wire payload", async () => {
  let seenPath = ""
  let seenAuth = ""
  const requests: unknown[] = []
  const logs: unknown[] = []
  let keyReads = 0
  const server = startServer(async (request) => {
    seenPath = new URL(request.url).pathname
    seenAuth = request.headers.get("Authorization") ?? ""
    requests.push(await request.json())
    return toolResponse(requests.length === 1 ? { ...valid, title: "" } : valid)
  })
  try {
    const config = settings(
      [{ ...provider("direct", server.baseUrl), apiKeyRef: "synthetic-ref" }],
      undefined,
      { provider: "direct", modelId: "MiniMax-M3" },
      [{ match: "^MiniMax-M3$", reasoningEffort: "medium", fastMode: true }],
    )
    const result = await summarizeBriefing({
      settings: config,
      briefing,
      getApiKey: async (keyRef) => {
        expect(keyRef).toBe("synthetic-ref")
        keyReads++
        return "synthetic-token"
      },
      log: (entry) => logs.push(entry),
    })
    expect(result.state).toBe("done")
    if (result.state === "done") {
      expect(result.model).toBe("direct/MiniMax-M3")
      expect(result.inputTokens).toBe(0)
      expect(result.outputTokens).toBe(0)
    }
    expect(keyReads).toBe(2)
    expect(seenPath).toBe("/v1/chat/completions")
    expect(seenAuth).toBe("Bearer synthetic-token")
    expect(requests[0]).toMatchObject({
      model: "MiniMax-M3",
      reasoning_effort: "medium",
      tool_choice: { type: "function", function: { name: "record_summary" } },
      tools: [{ type: "function", function: { name: "record_summary" } }],
    })
    expect(JSON.stringify(requests)).not.toContain("fast_mode")
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ provider: "direct", modelId: "MiniMax-M3", status: 200 })
    expect(JSON.stringify(logs)).not.toContain(briefing.text)
    expect(JSON.stringify(logs)).not.toContain("synthetic-token")
    expect(JSON.stringify(logs)).not.toContain(valid.memorySummary)
  } finally {
    server.stop()
  }
})

test("Given three simultaneous summaries, when HTTP calls overlap, then at most two are in flight", async () => {
  let active = 0
  let peak = 0
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let twoStarted: () => void = () => {}
  const reachedTwo = new Promise<void>((resolve) => {
    twoStarted = resolve
  })
  const server = startServer(async () => {
    active++
    calls++
    peak = Math.max(peak, active)
    if (calls === 2) twoStarted()
    await gate
    active--
    return toolResponse(valid)
  })
  try {
    const config = settings([provider("direct", server.baseUrl)], {
      provider: "direct",
      modelId: "direct",
    })
    const summaries = Array.from({ length: 3 }, () =>
      summarizeBriefing({ settings: config, briefing }),
    )
    await reachedTwo
    release()
    const results = await Promise.all(summaries)
    expect(results.map((result) => result.state)).toEqual(["done", "done", "done"])
    expect(calls).toBe(3)
    expect(peak).toBe(2)
  } finally {
    release()
    server.stop()
  }
})

test("Given two occupied call slots, an ordinary summary waits beyond the probe queue limit", async () => {
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
    await gate
    return toolResponse(valid)
  })
  const pending: Promise<unknown>[] = []
  try {
    const model = { provider: provider("direct", server.baseUrl), modelId: "direct" }
    const messages = [{ role: "user" as const, content: "Synthetic call" }]
    const active = Array.from({ length: 2 }, () => callSummaryCompletion(model, messages, {}))
    pending.push(...active)
    await twoStarted
    const config = settings([model.provider], { provider: "direct", modelId: "direct" })
    const queued = summarizeBriefing({ settings: config, briefing })
    pending.push(queued)
    let settled = false
    void queued.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(10_100)
    expect(settled).toBe(false)
    expect(calls).toBe(2)
    release()
    expect((await queued).state).toBe("done")
    await Promise.all(active)
    expect(calls).toBe(3)
  } finally {
    release()
    await Promise.allSettled(pending)
    server.stop()
  }
}, 15_000)

test("Given a queued summary, when evidence permission is revoked before its slot opens, then no third fetch starts", async () => {
  const config = settings([provider("direct", "http://127.0.0.1:1/v1")], {
    provider: "direct",
    modelId: "direct",
  })
  let current = config
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reachedTwo: () => void = () => {}
  const twoStarted = new Promise<void>((resolve) => {
    reachedTwo = resolve
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      calls++
      if (calls === 2) reachedTwo()
      await gate
      return toolResponse(valid)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const pending = Array.from({ length: 3 }, () =>
      summarizeBriefing({ settings: config, briefing, getCurrentSettings: () => current }),
    )
    await twoStarted
    current = {
      ...config,
      providers: config.providers.map((item) => ({ ...item, allowEvidence: false })),
    }
    release()
    const outcomes = await Promise.allSettled(pending)
    expect(calls).toBe(2)
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"])
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ reason: expect.any(EvidencePermissionRevokedError) })
  } finally {
    release()
    globalThis.fetch = originalFetch
  }
})

test("Given Context Awareness is disabled after a bad response, when repair starts, then no second fetch occurs", async () => {
  const config = settings([provider("direct", "http://127.0.0.1:1/v1")], {
    provider: "direct",
    modelId: "direct",
  })
  let current = config
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      calls++
      current = { ...config, contextAwareness: { ...config.contextAwareness, enabled: false } }
      return toolResponse({ ...valid, title: "" })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(
      summarizeBriefing({ settings: config, briefing, getCurrentSettings: () => current }),
    ).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
    expect(calls).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given consent is revoked after a valid response, when accepting it, then no summary is returned", async () => {
  const config = settings([provider("direct", "http://127.0.0.1:1/v1")], {
    provider: "direct",
    modelId: "direct",
  })
  let current = config
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      current = { ...config, contextAwareness: { ...config.contextAwareness, enabled: false } }
      return toolResponse(valid)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(
      summarizeBriefing({ settings: config, briefing, getCurrentSettings: () => current }),
    ).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given the first provider fails and fallback consent is revoked, when fallback starts, then no second fetch occurs", async () => {
  const config = settings(
    [provider("first", "http://127.0.0.1:1/v1"), provider("second", "http://127.0.0.1:2/v1")],
    { provider: "first", modelId: "first" },
  )
  let current = config
  const requests: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input))
      current = {
        ...config,
        providers: config.providers.map((item) =>
          item.id === "second" ? { ...item, allowEvidence: false } : item,
        ),
      }
      return Response.json({ error: "synthetic" }, { status: 500 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(
      summarizeBriefing({ settings: config, briefing, getCurrentSettings: () => current }),
    ).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
    expect(requests).toEqual(["http://127.0.0.1:1/v1/chat/completions"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given consent is revoked while fetching a provider key, when the key resolves, then evidence is not sent", async () => {
  const config = settings(
    [{ ...provider("direct", "http://127.0.0.1:1/v1"), apiKeyRef: "synthetic-ref" }],
    { provider: "direct", modelId: "direct" },
  )
  let current = config
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      calls++
      return toolResponse(valid)
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(
      summarizeBriefing({
        settings: config,
        briefing,
        getCurrentSettings: () => current,
        getApiKey: async () => {
          current = {
            ...config,
            providers: config.providers.map((item) => ({ ...item, allowEvidence: false })),
          }
          return "synthetic-token"
        },
      }),
    ).rejects.toBeInstanceOf(EvidencePermissionRevokedError)
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given a redirect to another host, when summarizing, then evidence is not forwarded", async () => {
  let redirectedCalls = 0
  const target = startServer(() => {
    redirectedCalls++
    return toolResponse(valid)
  })
  const source = startServer(() => Response.redirect(`${target.baseUrl}/chat/completions`, 307))
  try {
    const config = settings([provider("source", source.baseUrl)], {
      provider: "source",
      modelId: "source",
    })
    await expect(summarizeBriefing({ settings: config, briefing })).rejects.toThrow()
    expect(redirectedCalls).toBe(0)
  } finally {
    source.stop()
    target.stop()
  }
})
