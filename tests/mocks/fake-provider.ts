export type FakeProviderMode = "normal" | "400" | "429" | "invalid-json" | "contract-violation"

const validArguments = {
  title: "Example session",
  description: ["Reviewed an example document."],
  memorySummary: "Reviewed an example document.",
  apps: ["Example"],
  domains: ["example.com"],
  citations: [],
  sourceIds: [],
}

function toolResponse(argumentsValue: object): Response {
  return Response.json({
    id: "fake-completion",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "fake-call",
              type: "function",
              function: {
                name: "record_summary",
                arguments: JSON.stringify(argumentsValue),
              },
            },
          ],
        },
      },
    ],
  })
}

export function startFakeProvider(mode: FakeProviderMode): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response(null, { status: 404 })
      }
      switch (mode) {
        case "normal":
          return toolResponse(validArguments)
        case "400":
          return Response.json({ error: { message: "Bad request" } }, { status: 400 })
        case "429":
          return Response.json(
            { error: { message: "Rate limited" } },
            { status: 429, headers: { "Retry-After": "1" } },
          )
        case "invalid-json":
          return new Response("{invalid", { headers: { "Content-Type": "application/json" } })
        case "contract-violation":
          return toolResponse({ ...validArguments, title: "" })
        default:
          return mode satisfies never
      }
    },
  })
  return { url: `${server.url}v1/chat/completions`, stop: () => server.stop(true) }
}
