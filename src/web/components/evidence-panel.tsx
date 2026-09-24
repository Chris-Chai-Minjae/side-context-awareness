import type { z } from "zod"
import type { EvidenceSchema } from "../../contracts/rpc-resources"
import { t, type UiLanguage } from "../i18n"
import { UntrustedTextView } from "./untrusted-text-view"

type Evidence = z.infer<typeof EvidenceSchema>
export type EvidenceLoad =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly value: Evidence | null; readonly match: string }
export type Selection = { readonly ref: string; readonly summaryRef: string | null }

interface EvidencePanelProps {
  readonly language: UiLanguage
  readonly date: string
  readonly evidence: EvidenceLoad
  readonly selection: Selection | null
  readonly matchInput: string
  readonly onMatchInput: (value: string) => void
  readonly onMatchSubmit: () => void
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

function citingSummary(text: string): string | null {
  return /Citing summaries:\s*(s:[0-9A-HJKMNP-TV-Z]{26})/u.exec(text)?.[1] ?? null
}

export function EvidencePanel({
  language,
  date,
  evidence,
  selection,
  matchInput,
  onMatchInput,
  onMatchSubmit,
}: EvidencePanelProps) {
  const value = evidence.kind === "ready" ? evidence.value : null
  const external = safeExternalUrl(value?.url ?? null)
  const cited = value?.expired ? (citingSummary(value.text) ?? selection?.summaryRef) : null
  const evidenceText =
    value?.expired && language === "ko"
      ? value.text
          .replace(/^Original event expired\./u, t(language, "Original event expired."))
          .replace(/^Citing summaries:/mu, t(language, "Citing summaries:"))
      : (value?.text ?? "")
  return (
    <aside class="evidence-panel" aria-label={t(language, "Evidence panel")}>
      <h2>{t(language, "Evidence")}</h2>
      {selection && <p class="evidence-ref">{selection.ref}</p>}
      {evidence.kind === "idle" && (
        <p class="supporting-text">{t(language, "Select a source to view its evidence.")}</p>
      )}
      {evidence.kind === "loading" && <p role="status">{t(language, "Loading evidence…")}</p>}
      {evidence.kind === "error" && <p role="alert">{t(language, "Could not load evidence.")}</p>}
      {evidence.kind === "ready" && value === null && <p>{t(language, "Evidence unavailable.")}</p>}
      {value && (
        <>
          {value.expired && <p>{t(language, "Original evidence expired.")}</p>}
          {value.app && <p class="evidence-meta">{value.app}</p>}
          {value.title && <h3>{value.title}</h3>}
          <time dateTime={new Date(value.occurred_at).toISOString()} class="evidence-meta">
            {new Date(value.occurred_at).toLocaleString(language === "ko" ? "ko-KR" : "en-US")}
          </time>
          {external && (
            <a href={external} target="_blank" rel="noopener noreferrer">
              {t(language, "Open source")}
            </a>
          )}
          <UntrustedTextView
            language={language}
            text={evidenceText}
            match={evidence.kind === "ready" ? evidence.match : ""}
          />
          {cited && <a href={`#/history/${date}#${cited}`}>{t(language, "View citing summary")}</a>}
          {!value.expired && (
            <form
              class="evidence-match"
              onSubmit={(event) => {
                event.preventDefault()
                onMatchSubmit()
              }}
            >
              <label for="evidence-match">{t(language, "Match in evidence")}</label>
              <input
                id="evidence-match"
                value={matchInput}
                onInput={(event) => onMatchInput(event.currentTarget.value)}
              />
              <button class="button button-secondary" type="submit">
                {t(language, "Find")}
              </button>
            </form>
          )}
        </>
      )}
    </aside>
  )
}
