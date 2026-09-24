import type { UiLanguage } from "../i18n"
import type { RpcClient } from "../rpc-client"
import { RpcError } from "../rpc-client"

export type DayDemoState = "loading" | "error" | "empty" | "normal" | "expired-evidence"

export const DEMO_SOURCE = "e:01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z7" as const
export const DEMO_SUMMARY = "s:01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6" as const

export function createDayDemoClient(
  state: DayDemoState,
  date: string,
  language: UiLanguage,
): RpcClient {
  const markdown =
    language === "ko"
      ? `---
render: '3'
updated_at: 2026-09-24T09:41:00+09:00
---
# 상황 인식 — ${date}

_Side가 이 기기의 활동을 요약했습니다. 원본 캡처는 14일 후 만료됩니다._

## 하루 개요
- 로컬 메모를 검토함  ${DEMO_SUMMARY}

### 09:10 – 09:20 — 로컬 메모를 검토함  ${DEMO_SUMMARY}
참고 자료를 열고 sqlite 메모를 요약했습니다.

출처: [참고 자료](https://example.com/notes) — ${DEMO_SOURCE} | ${DEMO_SUMMARY}
`
      : `---
render: '3'
updated_at: 2026-09-24T09:41:00+09:00
---
# Context awareness — ${date}

_Captured by Side from on-device activity. Summaries only; raw captures expire after 14 days._

## Day overview
- Reviewed local notes  ${DEMO_SUMMARY}

### 09:10 – 09:20 — Reviewed local notes  ${DEMO_SUMMARY}
Opened a reference and summarized the sqlite notes.

Sources: [Reference](https://example.com/notes) — ${DEMO_SOURCE} | ${DEMO_SUMMARY}
`
  return {
    async call(method) {
      if (state === "loading") return new Promise<unknown>(() => {})
      if (state === "error") throw new RpcError("Demo day unavailable")
      switch (method) {
        case "historyStatus":
          return {
            store_bytes: 1024,
            average_bytes_per_day: 512,
            days_with_summaries: state === "empty" ? [] : [date],
            today_summary_states: { pending: 0, running: 0, done: 1, failed: 0, skipped: 0 },
          }
        case "day.get":
          return state === "empty"
            ? null
            : { date, markdown, updated_at: "2026-09-24T09:41:00+09:00" }
        case "read":
          return {
            id: DEMO_SOURCE,
            occurred_at: Date.parse("2026-09-24T09:15:00+09:00"),
            app: language === "ko" ? "브라우저" : "Browser",
            title: language === "ko" ? "참고 자료" : "Reference",
            url: "https://example.com/notes",
            text:
              state === "expired-evidence"
                ? `Original event expired.\nCiting summaries: ${DEMO_SUMMARY}`
                : "sqlite notes",
            expired: state === "expired-evidence",
          }
        case "clear":
          return { deleted_events: 0, deleted_summaries: 0, deletion_epoch: 1 }
        default:
          throw new RpcError("Unsupported Day view demo method")
      }
    },
  }
}
