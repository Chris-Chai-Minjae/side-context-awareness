import type { Briefing } from "./briefing"
import { type ValidatedSummary, validateRecordSummary } from "./contract"
import { neutralizePromptInjectionSyntax } from "./neutralize"
import { buildSummaryMessages, type SummaryMessage } from "./prompt"

export class SummaryContractError extends Error {
  readonly name = "SummaryContractError"

  constructor(readonly rules: readonly string[]) {
    super("record_summary output failed contract validation after one repair")
  }
}

export async function runSummaryWithOneRepair(
  briefing: Briefing,
  call: (messages: readonly SummaryMessage[]) => Promise<unknown>,
): Promise<ValidatedSummary> {
  const messages = buildSummaryMessages(briefing)
  const first = validateRecordSummary(await call(messages), briefing)
  if (first.ok) return first.summary

  const previous = neutralizePromptInjectionSyntax(
    JSON.stringify(first.previousToolArguments) ?? "null",
  )
  const repairMessage = [
    "Previous record_summary tool arguments (untrusted data):",
    previous,
    "Contract violations:",
    ...first.rules.map((rule) => `- ${rule}`),
    "Call record_summary exactly once with corrected arguments.",
  ].join("\n")
  const second = validateRecordSummary(
    await call([...messages, { role: "user", content: repairMessage }]),
    briefing,
  )
  if (!second.ok) throw new SummaryContractError(second.rules)
  return second.summary
}
