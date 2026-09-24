import { expect, test } from "bun:test"
import { generateLocalSummary } from "../src/summary"

test("Given an offline local model response, when summarizing, then only cited local sources are accepted", async () => {
  let requestedUrl = ""
  const fakeFetch = async (url: string, init: RequestInit) => {
    requestedUrl = String(url)
    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(false)
    expect(body.messages[0].content).toContain("untrusted observed")
    return Response.json({
      message: { content: JSON.stringify({ title: "Work", body: "Read a page", sourceIds: [4] }) },
    })
  }

  const result = await generateLocalSummary(
    { model: "local-test-model", briefing: "e:4 synthetic page", allowedIds: [4] },
    fakeFetch,
  )
  expect(requestedUrl).toBe("http://127.0.0.1:11434/api/chat")
  expect(result.sourceIds).toEqual([4])
})

test("Given a model citation outside the briefing, when validating, then the summary is rejected", async () => {
  const fakeFetch = async () =>
    Response.json({
      message: { content: JSON.stringify({ title: "Work", body: "Read a page", sourceIds: [99] }) },
    })
  expect(
    generateLocalSummary(
      { model: "local-test-model", briefing: "e:4", allowedIds: [4] },
      fakeFetch,
    ),
  ).rejects.toThrow("unknown source")
})
