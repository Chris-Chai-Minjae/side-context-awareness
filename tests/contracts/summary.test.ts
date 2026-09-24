import { expect, test } from "bun:test"
import { RecordSummaryArgumentsSchema, RecordSummaryTool } from "../../src/contracts/summary"

const ref = `e:${"0".repeat(26)}`
const valid = {
  title: "Work session",
  description: ["Reviewed a document"],
  memorySummary: "Reviewed a document and noted the next step.",
  apps: ["Aside"],
  domains: ["example.com"],
  citations: [{ ref }],
  sourceIds: [ref],
}

test("Given a valid record_summary call, when parsed, then all contract fields survive", () => {
  const result = RecordSummaryArgumentsSchema.safeParse(valid)
  expect(result.success).toBe(true)
  if (result.success) expect(result.data).toEqual(valid)
})

test.each([
  [{ ...valid, title: " " }, "blank title"],
  [{ ...valid, description: [] }, "empty description"],
  [{ ...valid, memorySummary: "x".repeat(2001) }, "oversized memory summary"],
  [{ ...valid, apps: Array(21).fill("Aside") }, "too many apps"],
  [{ ...valid, citations: [{ ref: "e:invalid" }] }, "invalid citation ID"],
  [{ ...valid, sourceIds: ["s:invalid"] }, "invalid source ID"],
  [{ ...valid, unexpected: true }, "unknown property"],
])("Given %s, when record_summary arguments are parsed, then %s is rejected", (value) => {
  expect(RecordSummaryArgumentsSchema.safeParse(value).success).toBe(false)
})

test("Given the provider tool declaration, when read, then its JSON Schema matches the required fields", () => {
  expect(RecordSummaryTool.name).toBe("record_summary")
  expect(RecordSummaryTool.parameters).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "description",
      "memorySummary",
      "apps",
      "domains",
      "citations",
      "sourceIds",
    ],
  })
  expect(JSON.stringify(RecordSummaryTool.parameters)).not.toContain("pattern")
})
