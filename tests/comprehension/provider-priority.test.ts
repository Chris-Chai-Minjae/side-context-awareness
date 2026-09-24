import { expect, test } from "bun:test"
import type { Briefing } from "../../src/comprehension/briefing"
import { resolveSummaryChain, summarizeBriefing } from "../../src/comprehension/providers"
import { SettingsSchema } from "../../src/contracts/settings"

const ref = `e:${"0".repeat(26)}`
const briefing: Briefing = {
  text: `Synthetic Example page ${ref}`,
  evidenceIds: new Set([ref]),
  apps: new Set(["Example"]),
  domains: new Set(["example.com"]),
}
const validSummary = {
  title: "Example activity",
  description: ["Reviewed an example page."],
  memorySummary: "The user reviewed an example page.",
  apps: ["Example"],
  domains: ["example.com"],
  citations: [{ ref }],
  sourceIds: [ref],
}

function summaryResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "record_summary", arguments: JSON.stringify(validSummary) } },
          ],
        },
      },
    ],
  })
}

test("MiMo 2.6 Pro is primary and MiniMax M3 is the first fallback", async () => {
  const requests: string[] = []
  const mimo = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push("mimo")
      expect((await request.json()).model).toBe("mimo-v2.6-pro")
      return Response.json({ error: "synthetic rate limit" }, { status: 429 })
    },
  })
  const minimax = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push("minimax")
      expect((await request.json()).model).toBe("MiniMax-M3")
      return summaryResponse()
    },
  })
  try {
    const settings = SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        summaryModel: { provider: "xiaomi-mimo", modelId: "mimo-v2.6-pro" },
      },
      providers: [
        {
          id: "xiaomi-mimo",
          baseUrl: `${mimo.url}v1`,
          models: ["mimo-v2.6-pro"],
          supportsToolChoice: false,
          allowEvidence: true,
        },
        {
          id: "minimax",
          baseUrl: `${minimax.url}v1`,
          models: ["MiniMax-M3"],
          supportsToolChoice: true,
          allowEvidence: true,
        },
      ],
    })
    expect(resolveSummaryChain(settings).map(({ modelId }) => modelId)).toEqual([
      "mimo-v2.6-pro",
      "MiniMax-M3",
    ])
    const result = await summarizeBriefing({ settings, briefing })
    expect(result.state).toBe("done")
    if (result.state === "done") expect(result.model).toBe("minimax/MiniMax-M3")
    expect(requests).toEqual(["mimo", "minimax"])
  } finally {
    mimo.stop(true)
    minimax.stop(true)
  }
})
