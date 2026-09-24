import { useState } from "preact/hooks"
import { HOUR_MS, PAUSE_INDEFINITE } from "../../constants"
import { t, type UiLanguage } from "../i18n"

export type PauseRequest = { readonly durationMs: number } | { readonly until: number }

interface PauseControlProps {
  readonly language: UiLanguage
  readonly pausedUntil: number | null
  readonly onPause: (request: PauseRequest) => void
  readonly onResume: () => void
  readonly busy?: boolean
}

export function PauseControl({
  language,
  pausedUntil,
  onPause,
  onResume,
  busy = false,
}: PauseControlProps) {
  const [choice, setChoice] = useState("15m")
  const paused = pausedUntil !== null
  return (
    <section class="pause-control" aria-label={t(language, "Capture pause controls")}>
      <div class="control-cluster">
        <label for="pause-duration">{t(language, "Pause capturing")}</label>
        <select
          id="pause-duration"
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value)}
          disabled={paused || busy}
        >
          <option value="15m">{t(language, "15 minutes")}</option>
          <option value="30m">{t(language, "30 minutes")}</option>
          <option value="1h">{t(language, "1 hour")}</option>
          <option value="indefinite">{t(language, "Until I resume")}</option>
        </select>
        {paused ? (
          <button type="button" class="button button-primary" onClick={onResume} disabled={busy}>
            {t(language, "Resume")}
          </button>
        ) : (
          <button
            type="button"
            class="button button-primary"
            onClick={() =>
              onPause(
                choice === "indefinite"
                  ? { until: PAUSE_INDEFINITE }
                  : {
                      durationMs:
                        choice === "1h" ? HOUR_MS : choice === "30m" ? HOUR_MS / 2 : HOUR_MS / 4,
                    },
              )
            }
            disabled={busy}
          >
            {t(language, "Pause")}
          </button>
        )}
      </div>
      {paused && (
        <p class="supporting-text" role="status">
          {pausedUntil === PAUSE_INDEFINITE
            ? t(language, "Paused until you resume")
            : t(language, "Resuming in …")}
        </p>
      )}
    </section>
  )
}
