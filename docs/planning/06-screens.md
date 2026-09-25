# 06 — Screens (FR-7 · FR-8 UI)

이 문서의 문구가 정본이다. Side에서 추가한 요소는 `(+)`로 표시한다.
UI 기술(ADR-006): 메뉴바는 SwiftUI, 설정 화면은 데몬이 서빙하는 웹 페이지(WKWebView). 웹 스택은 정적 SPA(Preact + 번들 CSS, 외부 CDN 없음)로 한다 `[design]`.

---

## S1. 메뉴바 메뉴 (SwiftUI) (+)

| 요소 | 동작 |
|---|---|
| 상태 줄 | `Capturing` / `Paused until HH:MM` / `Paused until you resume` / `Capture is not running` / `Permissions needed` |
| Pause ▸ | `15 minutes` · `30 minutes` · `1 hour` · `Until I resume` |
| Resume | 일시정지일 때만 표시 |
| Today's summary… | S6을 오늘 날짜로 열기 |
| Settings… | S2 열기 |
| Unlock Keychain… / Keychain 허용… | supervisor가 `keychainLocked`일 때만 표시. 클릭하면 `retryKeychain()`으로 대화형 마스터 키 읽기를 다시 시도 |
| Open at Login | macOS 로그인 항목 켜기/끄기. 승인 필요 시 시스템 설정 경로 안내 |
| Quit Side | 데몬 종료 후 앱 종료 |
- 아이콘은 상태별로 3종(활성·일시정지·오류)이다. 캡처할 때 깜박이지 않는다(주의 분산 방지).
- macOS 화면 잠금 해제 알림(`com.apple.screenIsUnlocked`)을 받으면 `keychainLocked` 상태에서 한 번 재시도한다. 주기적 재시도는 하지 않는다.

## S2. 설정 → Context Awareness (웹)

헤더: **Let Side remember your day** — "Side captures what you do in your browser and apps so agents can recall it later."

권한 배너(조건부, `03-capture.md` §8.3): `Starting capture…` / `Capture is not running` / `Permissions needed` [Allow] / `Some capture features are unavailable` [Allow]

### 섹션 `Capture`
| 컨트롤 | 타입 | 문구 / 값 |
|---|---|---|
| Enable Context Awareness | switch | 끌 때 S5 확인 |
| Pause capturing | dropdown + 버튼 | 15 minutes / 30 minutes / 1 hour / Until I resume · `Resume` · 상태 "Paused until you resume" / "Resuming in …" |
| Capture typed text | switch | "Save the sentences you type. Side never stores keystrokes or password fields." |
| Allow Screen Recording | switch | "When a page has no readable text, read it from the screen. Only the text is kept." 켤 때 Screen Recording 권한 요청 |
| Use Aside Browser page content (+) | switch | "When Aside Browser is in front, read the page through Aside for better text. Requires the Aside CLI." 상태 표시: available / unavailable / error |

### 섹션 `Denylist`
- 설명: "Side never captures what you do in these apps and websites."
- 목록 행: 앱 아이콘 + 이름 + bundleId, 또는 favicon 자리표시 + 도메인 · 삭제 버튼
- `Add` → S3

### 섹션 `Summaries`
| 컨트롤 | 문구 / 값 |
|---|---|
| Summary model | provider/model 드롭다운. 기본값 표시는 `summaryModelDefault` |
| Model providers (+) | 목록: 이름 · base URL host · 모델 수 · `Send evidence to this provider` 스위치(= `allowEvidence`, 켤 때 경고: "Summaries send redacted activity from each 10-minute window to <host>.") · 편집/삭제 · `Add provider`(이름, Base URL, API key → Keychain, 모델 ID 목록, `Supports forced tool calls` 체크) |
| Retention | "Side deletes raw captures after this many days. Summaries stay." 1 / 3 / 7 / 14 / 30 days |

### 섹션 `History`
- day picker(요약이 있는 날만 활성화), 선택한 날의 요약 목록(시간·제목·설명). 클릭하면 S6으로 이동
- `History storage usage`: 막대 + 툴팁 "Storage used" / "Average usage: … / day"
- `Clear history` → S4

### 섹션 `Connect agents` (+)
- 복사 버튼이 있는 코드 블록:
  - Claude Code: `claude mcp add side -- "/Applications/Side.app/Contents/Resources/side" mcp`
  - Codex / Cursor: `mcp.json` 스니펫
  - Aside: "Settings → MCP → Add server" 안내와 command/args 값
- 최근 24h MCP 호출 수(에이전트별 client name)
- 로그인형 provider에는 Claude Code·OpenAI (Codex login) 프리셋을 제공한다. API 키 입력은 표시하지 않고 각 공식 CLI 로그인 상태 및 기기 밖 전송 주의를 표시한다.
- API 키 provider에는 Keychain 저장·접근 가능 여부를 개별 표시하고, 사용자 클릭으로 `providers.authorizeKey`를 호출해 접근을 재요청할 수 있다. 접근이 이미 허용된 경우 추가 macOS 팝업은 나타나지 않을 수 있다.

## S3. 다이얼로그 `Never observe`
- Source: segmented `Application` | `Website`
- Application: 검색 가능한 앱 목록(`listApplications`, 이미 denylist된 앱 제외) 또는 bundle id 직접 입력
- Website: 도메인 입력(검증 `^[A-Za-z0-9.-]+$`, 소문자화, 스킴·경로는 자동 제거)
- `Add` / `Cancel`

## S4. 다이얼로그 Clear history
- 선택지: `Last 10 minutes` · `Last hour` · `Today` · `All history`
- `All history`를 고르면 확인 문구 "Clear all Context Awareness?"와 파괴 버튼
- 완료 토스트: "Cleared N events."

## S5. 다이얼로그 Disable
- 제목 "Disable Context Awareness?"
- 본문 "Side will stop capturing your activity. Existing history stays on this device until it expires or you delete it."
- `Disable` / `Cancel`

## S6. Day view (+)
- day page 마크다운 렌더: `## Day overview` 불릿, 그 아래 시간 섹션들
- 섹션마다 `Sources:` 링크. `e:` 링크를 누르면 오른쪽 패널에 `history_read` 결과(스니펫, `match` 하이라이트)
- 상단: 날짜 이동 ◀ ▶, 이 날 삭제(`today` 대상일 때만 S4 재사용)
- 오늘 실패한 요약이 있으면 `Retry failed summaries` 버튼을 표시한다. 클릭하면 `summaries.retryFailedToday`를 호출하고 상태를 다시 읽는다.

## S8. Permissions (웹) (+)
- `/permissions`에서 helper·캡처 상태, Accessibility, Input Monitoring, Screen Recording, 브라우저 Automation 허용 여부를 각각 표시한다.
- 권한별 `Request permission` 버튼과 macOS 시스템 설정 딥링크·Apple 안내 링크를 제공한다. 이미 허용된 권한의 재요청 버튼은 비활성화한다. Screen Recording 요청은 OCR이 켜졌을 때만 활성화한다.
- 모델 provider마다 Keychain 연결 상태와 `providers.authorizeKey`, `providers.listModels` 확인 동작을 표시한다. 로그인형 CLI provider에는 Keychain 버튼을 표시하지 않는다.

## S7. 온보딩 시트 (SwiftUI, 첫 실행) (+)
1. 소개 한 화면(헤더 문구 + "Everything stays on this Mac unless you choose a summary provider.")
2. Accessibility 요청 → 시스템 설정 딥링크 → 부여를 감지하면 자동으로 다음 단계
3. Input Monitoring 요청(같은 방식)
4. (선택) Screen Recording
5. 요약 provider 설정(건너뛰기 가능. 건너뛰면 캡처만 하고 요약은 대기)
- `permissionSheetVisible`을 health에 반영하고, Screen Recording 부여 후 재시작되면 시트를 이어서 연다 `[verified 동작]`.

---

## 화면 × API 매핑

| 화면 | 사용 API (`02-architecture.md` §4) |
|---|---|
| S1 | `status`, `pause`, `resume` (Keychain 재시도·로그인 항목은 앱 내부 동작) |
| S2 | `status`, `permissions`, `requestPermissions`, `settings.get/patch`, `summaryModelDefault`, `historyStatus`, `historyList` |
| S3 | `listApplications`, `appIcons`, `settings.patch` |
| S4 | `clear` |
| S5 | `settings.patch` |
| S6 | `historyList`, `read` + day page 파일 조회(`day.get {date}`: 렌더된 md 반환) |
| S7 | `permissions`, `requestPermissions`, `settings.patch` |
| S8 | `status`, `permissions`, `requestPermissions`, `settings.get`, `providers.authorizeKey`, `providers.listModels` |
