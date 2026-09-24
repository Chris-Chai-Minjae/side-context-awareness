import { randomBytes } from "node:crypto"
import { UNTRUSTED_EVIDENCE_NONCE_BYTES } from "../constants"

const fakeBoundaryTag = /<\s*\/?\s*untrusted[^>]*>/giu
const chatRoleMarker = /<\|\s*im_(?:start|end|sep)\s*\|>/giu
const instructionMarker = /\[\s*\/?\s*inst\s*\]|<<\s*\/?\s*sys\s*>>/giu
const toolCallTag = /<\s*\/?\s*(?:tool[_-]?call|function[_-]?call)\b[^>]*>/giu
const jsonToolName = /\\*["']name\\*["']\s*:\s*\\*["']record_summary\\*["']/giu
const functionCallMarker = /\bfunction_call\b/giu
const rolePrefix = /\b(system|assistant|developer|user|tool)\s*:/giu
const roleLine = /^\s*(?:system|assistant|developer|user|tool)\s*:/iu
const controlLine =
  /<\|\s*im_(?:start|end|sep)\s*\|>|\[\s*\/?\s*inst\s*\]|<<\s*\/?\s*sys\s*>>|<\s*\/?\s*(?:tool[_-]?call|function[_-]?call)\b/iu
const toolInstructionLine = /record_summary/iu
const modelDirectiveLine =
  /\b(?:ignore|disregard|override|rewrite|replace|call|invoke|put|set|make|output|respond|return)\b[^\n]*\b(?:instructions?|evidence|summary|tool|title|answer|activity)\b/iu

function omitModelDirectedLines(evidence: string): string {
  return evidence
    .split(/\r?\n/u)
    .map((line) => {
      const role = roleLine.exec(line)
      if (role) return `${role[0]} [untrusted instruction omitted]`
      return controlLine.test(line) ||
        toolInstructionLine.test(line) ||
        modelDirectiveLine.test(line)
        ? "[untrusted instruction omitted]"
        : line
    })
    .join("\n")
}

export function neutralizePromptInjectionText(evidence: string): string {
  return omitModelDirectedLines(evidence.normalize("NFKC"))
    .replace(fakeBoundaryTag, "")
    .replace(chatRoleMarker, "⟦chat role marker⟧")
    .replace(instructionMarker, "⟦instruction marker⟧")
    .replace(toolCallTag, "⟦tool call marker⟧")
    .replace(jsonToolName, "⟦record_summary tool name⟧")
    .replace(functionCallMarker, "⟦function call⟧")
    .replace(rolePrefix, (_marker, role: string) => `⟦${role}⟧`)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function neutralizePromptInjectionSyntax(evidence: string): string {
  const safeEvidence = neutralizePromptInjectionText(evidence)
  const nonce = randomBytes(UNTRUSTED_EVIDENCE_NONCE_BYTES).toString("hex")
  return `<untrusted-evidence nonce="${nonce}">${safeEvidence}</untrusted-evidence nonce="${nonce}">`
}
