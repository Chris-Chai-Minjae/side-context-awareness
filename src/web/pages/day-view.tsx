import { useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks"
import { RpcMethods } from "../../contracts/rpc"
import {
  ClearOperationSchema,
  DayPageSchema,
  EvidenceSchema,
  HistoryStatusSchema,
} from "../../contracts/rpc-resources"
import { ConfirmDialog } from "../components/confirm-dialog"
import { DayPageMarkdown } from "../components/day-page-markdown"
import type { EvidenceLoad, Selection } from "../components/evidence-panel"
import { EvidencePanel } from "../components/evidence-panel"
import { t, type UiLanguage } from "../i18n"
import type { RpcClient } from "../rpc-client"
import type { DayDemoState } from "./day-view-demo"
import { createDayDemoClient, DEMO_SOURCE } from "./day-view-demo"

interface DayViewProps {
  readonly language: UiLanguage
  readonly browser: Window
  readonly rpc: RpcClient
  readonly date: string
  readonly demoState?: DayDemoState
}

type DayLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready"
      readonly days: readonly string[]
      readonly markdown: string | null
      readonly failedToday: number
    }
function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export function DayViewPage({ browser, rpc, date, demoState, language }: DayViewProps) {
  const client = useMemo(
    () => (demoState ? createDayDemoClient(demoState, date, language) : rpc),
    [date, demoState, language, rpc],
  )
  const [load, setLoad] = useState<DayLoad>({ kind: "loading" })
  const [evidence, setEvidence] = useState<EvidenceLoad>({ kind: "idle" })
  const [selection, setSelection] = useState<Selection | null>(null)
  const [matchInput, setMatchInput] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retryBusy, setRetryBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    setLoad({ kind: "loading" })
    setEvidence({ kind: "idle" })
    setSelection(null)
    Promise.all([client.call("historyStatus"), client.call("day.get", { date })])
      .then(([statusValue, dayValue]) => {
        const status = HistoryStatusSchema.parse(statusValue)
        const page = DayPageSchema.nullable().parse(dayValue)
        return {
          days: [...status.days_with_summaries].sort(),
          markdown: page?.markdown ?? null,
          failedToday: status.today_summary_states.failed,
        }
      })
      .then(
        (data) => {
          if (!active) return
          setLoad({ kind: "ready", ...data })
        },
        () => {
          if (active) setLoad({ kind: "error" })
        },
      )
    return () => {
      active = false
    }
  }, [client, date, reload])

  useLayoutEffect(() => {
    if (load.kind !== "ready") return
    const scrollToSummary = () => {
      const match = /^#\/history\/(\d{4}-\d{2}-\d{2})#s:([0-9A-HJKMNP-TV-Z]{26})$/u.exec(
        browser.location.hash,
      )
      if (match?.[1] === date) browser.document.getElementById(`s:${match[2]}`)?.scrollIntoView()
    }
    scrollToSummary()
    browser.addEventListener("hashchange", scrollToSummary)
    return () => browser.removeEventListener("hashchange", scrollToSummary)
  }, [browser, date, load])

  useLayoutEffect(() => {
    if (demoState !== "expired-evidence" || load.kind !== "ready") return
    void readSource({ ref: DEMO_SOURCE, summaryRef: "s:01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6" })
  }, [demoState, load.kind])

  async function readSource(next: Selection, match = ""): Promise<void> {
    setSelection(next)
    setEvidence({ kind: "loading" })
    try {
      const params = match ? { id: next.ref, match, contextLines: 10 } : { id: next.ref }
      const value = EvidenceSchema.nullable().parse(await client.call("read", params))
      setEvidence({ kind: "ready", value, match })
    } catch {
      setEvidence({ kind: "error" })
    }
  }

  async function clearToday(): Promise<void> {
    setBusy(true)
    try {
      const result = ClearOperationSchema.parse(await client.call("clear", { target: "today" }))
      setNotice(
        language === "ko"
          ? `${t(language, "Cleared")} ${result.deleted_events}${t(language, "events.")}`
          : `Cleared ${result.deleted_events} events.`,
      )
      setDialogOpen(false)
      setReload((value) => value + 1)
    } catch {
      setNotice(t(language, "Could not clear history."))
    } finally {
      setBusy(false)
    }
  }

  async function retryFailedToday(): Promise<void> {
    if (retryBusy) return
    setRetryBusy(true)
    try {
      const result = RpcMethods["summaries.retryFailedToday"].output.parse(
        await client.call("summaries.retryFailedToday"),
      )
      const count = result.requeued
      setNotice(
        language === "ko"
          ? count > 0
            ? `요약 작업 ${count}개를 다시 대기열에 넣었습니다.`
            : "다시 시도할 수 있는 요약 작업이 없습니다."
          : count > 0
            ? `${count} summary job${count === 1 ? "" : "s"} queued for retry.`
            : "No eligible summary jobs to retry.",
      )
      setReload((value) => value + 1)
    } catch {
      setNotice(
        language === "ko" ? "요약을 다시 시도할 수 없습니다." : "Could not retry summaries.",
      )
    } finally {
      setRetryBusy(false)
    }
  }

  const days = load.kind === "ready" ? load.days : []
  const previous = days.filter((day) => day < date).at(-1)
  const next = days.find((day) => day > date)
  return (
    <div class="day-view">
      <header class="day-heading">
        <div>
          <a href="#/settings/context-awareness" class="day-back-link">
            {t(language, "Settings")}
          </a>
          <h1>
            {t(language, "History")} · {date}
          </h1>
        </div>
        {date === localToday() && (
          <button
            type="button"
            class="button button-secondary"
            data-action="clear-today"
            onClick={() => setDialogOpen(true)}
          >
            {t(language, "Clear today")}
          </button>
        )}
      </header>
      {load.kind === "error" ? (
        <div class="state-message" role="alert">
          <p>{t(language, "Could not load day view.")}</p>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => setReload(reload + 1)}
          >
            {t(language, "Retry")}
          </button>
        </div>
      ) : load.kind === "loading" ? (
        <p class="state-message" role="status">
          {t(language, "Loading…")}
        </p>
      ) : (
        <>
          <nav class="day-nav" aria-label={t(language, "Day navigation")}>
            {previous && (
              <a data-action="previous-day" href={`#/history/${previous}`}>
                ← {t(language, "Previous day")}
              </a>
            )}
            <time dateTime={date}>{date}</time>
            {next && (
              <a data-action="next-day" href={`#/history/${next}`}>
                {t(language, "Next day")} →
              </a>
            )}
            <button
              type="button"
              class="button button-secondary"
              data-action="refresh-day"
              onClick={() => setReload((value) => value + 1)}
            >
              {language === "ko" ? "요약 새로고침" : "Refresh summaries"}
            </button>
          </nav>
          {notice && (
            <p role="status" class="supporting-text">
              {notice}
            </p>
          )}
          {date === localToday() && load.failedToday > 0 && (
            <div class="state-message" role="status">
              <p>
                {language === "ko"
                  ? `오늘 요약 작업 ${load.failedToday}개가 실패했습니다. 모델 연결을 확인한 뒤 다시 시도하세요.`
                  : `${load.failedToday} summary job${load.failedToday === 1 ? "" : "s"} failed today. Check the model connection, then retry.`}
              </p>
              <button
                type="button"
                class="button button-secondary"
                data-action="retry-failed-today"
                disabled={retryBusy}
                onClick={() => void retryFailedToday()}
              >
                {language === "ko" ? "실패한 요약 다시 시도" : "Retry failed summaries"}
              </button>
            </div>
          )}
          <div class="day-columns">
            {load.markdown ? (
              <DayPageMarkdown
                language={language}
                date={date}
                markdown={load.markdown}
                onSource={(ref, summaryRef) => {
                  setMatchInput("")
                  void readSource({ ref, summaryRef })
                }}
              />
            ) : (
              <p class="state-message">{t(language, "No summaries for this day.")}</p>
            )}
            <EvidencePanel
              language={language}
              date={date}
              evidence={evidence}
              selection={selection}
              matchInput={matchInput}
              onMatchInput={setMatchInput}
              onMatchSubmit={() => {
                if (selection) void readSource(selection, matchInput.trim())
              }}
            />
          </div>
        </>
      )}
      <ConfirmDialog
        language={language}
        open={dialogOpen}
        title={t(language, "Clear history")}
        body={t(language, "Clear today's Context Awareness history?")}
        confirmLabel={t(language, "Clear today")}
        busy={busy}
        onConfirm={() => void clearToday()}
        onCancel={() => setDialogOpen(false)}
      />
    </div>
  )
}
