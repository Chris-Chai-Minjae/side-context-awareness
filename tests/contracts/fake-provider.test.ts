import { expect, test } from "bun:test"
import { RecordSummaryArgumentsSchema } from "../../src/contracts/summary"
import { type FakeProviderMode, startFakeProvider } from "../mocks/fake-provider"

async function responseFor(mode: FakeProviderMode): Promise<Response> {
  const provider = startFakeProvider(mode)
  try {
    return await fetch(provider.url, { method: "POST", body: "{}" })
  } finally {
    provider.stop()
  }
}

test("Given a normal provider, when chat completion is requested, then a valid record_summary tool call returns", async () => {
  const response = await responseFor("normal")
  expect(response.status).toBe(200)
  const body = await response.json()
  const call = body.choices[0].message.tool_calls[0]
  expect(call.function.name).toBe("record_summary")
  expect(RecordSummaryArgumentsSchema.safeParse(JSON.parse(call.function.arguments)).success).toBe(
    true,
  )
})

test.each(["400", "429"] as const)(
  "Given mode %s, when requested, then its HTTP status returns",
  async (mode) => {
    const response = await responseFor(mode)
    expect(response.status).toBe(Number(mode))
  },
)

test("Given invalid JSON mode, when requested, then the response cannot be decoded as JSON", async () => {
  const response = await responseFor("invalid-json")
  expect(response.status).toBe(200)
  expect(response.json()).rejects.toThrow()
})

test("Given contract violation mode, when requested, then the tool arguments fail the contract", async () => {
  const response = await responseFor("contract-violation")
  const body = await response.json()
  const call = body.choices[0].message.tool_calls[0]
  expect(RecordSummaryArgumentsSchema.safeParse(JSON.parse(call.function.arguments)).success).toBe(
    false,
  )
})
