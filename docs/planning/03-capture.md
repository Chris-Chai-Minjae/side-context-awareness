# 03 — Capture (FR-1 · FR-2 · FR-8 · FR-10)

## 1. 소스와 이벤트 종류 `[verified]` 종류 목록 / 생산 방식은 `[design]`

| kind | source | 생산자 (Side.app) | 저장 내용 |
|---|---|---|---|
| `session.started` / `session.ended` | mac_ax | NSWorkspace `didWake`/`willSleep`, `sessionDidBecomeActive`/`ResignActive`, 화면 잠금 | 사유 |
| `window.changed` | mac_ax | `didActivateApplication` + AXObserver `kAXFocusedWindowChanged`·`kAXTitleChanged` | app, title, url |
| `mouse.click` / `mouse.context_menu` / `mouse.drag` | mac_ax | CGEventTap listen-only (`leftMouseDown`, `rightMouseDown`, `leftMouseDragged` 시작점) | 포인터 아래 요소의 role·label(`AXUIElementCopyElementAtPosition`)만 저장. **좌표 저장 안 함** |
| `keyboard.shortcut` | mac_ax | EventTap `keyDown`에 ⌘/⌃/⌥가 있을 때만 | 코드 표기(`⌘S`). 수식키 없는 문자키는 **폐기** |
| `keyboard.submit` | mac_ax | 텍스트 필드 포커스 중 Return/⌘Return | 필드 label |
| `keyboard.text_input` | mac_ax | AX 포커스 요소 `kAXValueChanged` diff → TypedSentenceTracker | 완성된 문장(§5) |
| `selection.changed` | mac_ax/aside_dom | `kAXSelectedTextChanged` → `kAXSelectedTextAttribute` | ≤ `SELECTION_BYTES`(600) |
| `content.snapshot` | mac_ax/aside_dom | `capture.request` 실행 결과 | AX 텍스트 또는 ARIA 트리 → blob |
| `screen.ocr` | mac_ax | Vision OCR | OCR 텍스트 → blob |

- **캡처 모양** `[verified]`: `TEXT_KINDS = {keyboard.text_input, selection.changed, screen.ocr}`는 `text`, `mac_ax` 스냅샷은 `ax`, `aside_dom` 스냅샷은 `aria`다.
- **Input Monitoring 최소화**: event tap은 **트리거 신호**로만 쓴다. 문자 내용은 key 이벤트에서 절대 복원하지 않는다. 입력 문장은 오직 AX 값 diff로 얻는다. UI 문구가 약속하는 "never stores keystrokes" 원칙을 지키기 위함이다.

## 2. Target 모델

- `targetKey = bundleId + "|" + (windowId ?? "-") + "|" + (normalizedUrl ?? "-")`
- 추적 상한은 `TRACKED_TARGET_LIMIT = 512`다. 넘으면 `lastSeenAt`이 가장 오래된 target부터 LRU로 제거한다.
- target 상태: `{lastCaptureAt, lastUrl, pending?: {trigger, deadline}, lastInputAt, pointerConfirmedUntil, audibleConfirmedUntil, typedFieldCache}`

## 3. 스케줄러 (FR-1)

상수 `[verified]`: `MIN_CAPTURE_INTERVAL_MS=2000`, `ACTIVATION_INTERVAL_MS=15000`, `UNCHANGED_URL_INTERVAL_MS=60000`, `MAX_CONCURRENT_CAPTURES=2`, `SWEEP_INTERVAL_MS=120000`, `MAX_SWEEP_TARGETS=8`, `TAB_STALE_AFTER_MS=600000`, `TRIGGER_STRENGTH={interaction:4, activation:3, navigation:2, sweep:1, discovery:0}`.
`CAPTURE_DEBOUNCE_MS`는 외부에서 확인된 값이 없다(`[unknown]`). Side는 이 값을 디바운스 하한 **500으로 정의**한다 `[design]`.

```ts
function interval(t: Target, trigger: Trigger, url: string | null): number {
  if (trigger === "interaction" || trigger === "activation") return ACTIVATION_INTERVAL_MS
  if (url !== null && url === t.lastUrl) return UNCHANGED_URL_INTERVAL_MS
  return MIN_CAPTURE_INTERVAL_MS
}
function schedule(t: Target, trigger: Trigger, now: number) {
  const delay = Math.max(500, interval(t, trigger, t.currentUrl) - (now - t.lastCaptureAt))   // [verified] 공식
  const deadline = now + delay
  if (!t.pending) return (t.pending = { trigger, deadline })
  if (STRENGTH[trigger] > STRENGTH[t.pending.trigger]) t.pending.trigger = trigger           // 승격
  t.pending.deadline = Math.min(Math.max(t.pending.deadline, deadline), t.pending.deadline + 500) // 최대 500ms 연장 [inferred]
}
// 타이머가 deadline 도달 target을 semaphore(2)로 실행. 실행 전 policy 재평가(pause·denylist·secureInput·idle).
```

- **트리거 원천** `[design]`:
  - `interaction`: click, shortcut, submit, selection, text_input
  - `activation`: 앱 활성화, 포커스 창 변경
  - `navigation`: 창 제목 변경, 브라우저 URL 변경(1s 폴링은 브라우저가 전경일 때만)
  - `sweep`: 120s마다 최근 target 최대 8개
  - `discovery`: 처음 본 target
- **스윕**: `lastSeenAt`이 `TAB_STALE_AFTER_MS`를 넘은 target은 제거한다. 나머지 중 어텐션 점수(§4) 상위 8개를 sweep으로 예약한다.
- **실행**(`capture.request`):
  1. AX 텍스트를 추출한다. 한도는 노드 400·문자 12,000으로 기존 `observe.swift`를 유지하되, `CONTENT_BYTE_BUDGET` 안에서 조정한다.
  2. 전경이 Aside이고 어댑터가 켜져 있으면 Aside ARIA 스냅샷을 **우선** 쓴다.
  3. AX 텍스트가 `EMPTY_TREE_BYTES`(2048B) 미만이고 `screenOcr`가 켜져 있으며 Screen Recording 권한이 있으면 Vision OCR로 넘어간다.
  4. 스냅샷을 찍는 도중 전경 앱·창·URL이 바뀌었으면 결과를 **폐기**한다. 기존 `observe.ts`의 이중 확인 로직을 유지한다.

## 4. 어텐션 모델 `[verified 상수 / design 의미]`

| 상수 | 값 | Side에서의 의미 |
|---|---|---|
| `ATTENTION_INPUT_FRESH_S` | 180 | `CGEventSourceSecondsSinceLastEventType(.combinedSessionState, .any)`가 180을 넘으면 `idle=true`. activation·interaction 캡처를 중지하고 sweep만 돈다 |
| `ATTENTION_STALE_MS` | 45000 | 전경 target에 45s 동안 입력이 없으면 어텐션 점수가 감쇠하기 시작한다 |
| `POINTER_CONFIRM_TTL_MS` | 20000 | 배경 창 위의 click·hover가 그 target의 어텐션을 20s 확인한다 |
| `AUDIBLE_CONFIRM_TTL_MS` | 1800000 | 재생 중인 앱·탭은 입력이 없어도 30분간 어텐션을 인정한다(영상 시청). 감지 방법은 Spike S-3 |
| `TYPED_FIELD_CACHE_MS` | 300000 | 필드별 직전 값 캐시 유지 시간 |
| `GLANCE_MS` | 5000 | 5s 미만 체류는 glance로 분류한다. 기록은 하되 briefing에서 한 줄로 합친다 |
| `STAY_MAX_MS` | 3600000 | 같은 페이지·앱 재방문을 1h까지 하나의 stay로 병합한다 |
| `DWELL_GAP_MS` | 600000 | 10분 넘게 끊기면 새 dwell로 본다 |
| `DRAFT_IDLE_MS` | 300000 | 입력 중인 초안이 5분 idle이면 flush한다 |
| `SELECTION_BURST_MS` | 2000 | 2s 안에 연속 선택하면 마지막 하나만 남긴다 |

- **세션**: `session.started`부터 `session.ended`(잠금·슬립)까지를 하나의 `session_id`(ULID)로 묶는다. idle 180s는 세션을 끊지 않는다.
- **secureInput**: `IsSecureEventInputEnabled()`가 true면(암호 입력 대화상자 등) keyboard·text·selection 캡처를 전부 중지하고, health `secureInput=true`로 보고한다.

## 5. 입력 문장 캡처 (`captureTypedText`)

- UI 문구: "Save the sentences you type. Side never stores keystrokes or password fields."
- 기존 `src/typed.ts`의 `TypedSentenceTracker`를 유지한다. 앞부분이 같은 상태로 늘어난 값만 누적하고, 문장 종결자 `. ! ? 。 ！ ？ \n`에서 방출한다.
- **flush 조건 추가**: `keyboard.submit`, 포커스 이탈(blur), `DRAFT_IDLE_MS` 경과. 누적 한도는 `TYPED_RUN_BYTES`(4096B)다.
- **제외 필드**: subrole `AXSecureTextField`, §6.1의 label 정규식에 걸리는 필드, denylist 앱, `secureInput` 활성 상태.

## 6. Redaction (FR-2, 저장 전 필수 단계)

### 6.1 필드 단위 차단 `[verified 목록]`
- autocomplete 토큰: `current-password, new-password, one-time-code, cc-number, cc-csc, cc-exp, cc-exp-month, cc-exp-year, cc-name`. ARIA 스냅샷에 `autocomplete` 정보가 있으면 적용하고, AX에는 없으므로 아래 label 규칙으로 대체한다.
- input type: `password`, `tel`. AX `AXSecureTextField`와 ARIA `textbox` 중 type 정보가 있는 경우에 적용한다.
- label 정규식 (AXTitle / AXDescription / AXPlaceholderValue / ARIA name에 적용):
  `/(^|[^a-z])(cvv|cvc|csc|otp|one[- ]?time|pin|passcode|password|passwd|ssn|social security|security[- ]?code|card[- ]?number|카드\s*번호|비밀\s*번호|인증\s*번호|주민\s*(등록)?\s*번호|보안\s*코드)([^a-z]|$)/i`
  (한국어 라벨 추가는 `[design]`)
- 차단된 필드는 값 자체를 읽지 않는다. 이벤트에는 `{redactedField: rule}`만 남긴다.

### 6.2 패턴 마스킹 → `[redacted:capture]` `[verified 규칙 이름]`
기존 `src/redact.ts`를 확장해 `redact(text) → {text, masks: {rule, count}[]}`를 반환하게 한다.

| rule | 패턴 (요지) |
|---|---|
| `private-key-block` | `-----BEGIN (RSA|EC|OPENSSH )?PRIVATE KEY-----…END…` |
| `aws-access-key` | `\b(AKIA|ASIA)[A-Z0-9]{16}\b` |
| `jwt` | `\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b` |
| `slack-token` | `\bxox[abprs]-[\w-]{10,}\b` |
| `api-key` | `\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}`, `\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{20,}`, `\bgithub_pat_[A-Za-z0-9_]{22,}`, `\bgh[pousr]_[A-Za-z0-9]{36,}\b`, `\bglpat-[A-Za-z0-9_-]{20,}`, `\bya29\.[A-Za-z0-9_-]{20,}`, `\bAIza[0-9A-Za-z_-]{35}\b`, `\bxai-[A-Za-z0-9]{20,}`, `\bhf_[A-Za-z0-9]{30,}` |
| `bearer-token` | `\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]{16,}` (대소문자 무시) |
| `kr-rrn` | `\b\d{6}-?[1-4]\d{6}\b`; YYMMDD의 월 01–12, 일 01–31 검증 |
| `field` | ARIA 입력 필드의 값을 저장 전에 제거한 건수. payload `masks`와 오늘 `masks`에 합산 |
| `labeled-secret` | 영문 `(api[_ -]?key|access[_ -]?token|secret|password|passwd)\s*(?:[:=]|\s+is|\s+=)\s*\S+`, 한국어 `(?:토큰|비밀번호|암호|인증번호)\s*(?:[:=]|은|는)\s*\S+` |
| `otp-numeric` | OTP·인증 문맥(`otp|code|인증`) 뒤 40자 이내의 `\b\d{4,8}\b` |
| `card-number` | `\b(?:\d[ -]?){12,18}\d\b` + Luhn 통과 시(13–19자리) |

- 적용 대상: 이벤트의 모든 텍스트 필드(title, url 쿼리 제거 후 경로, target label, blob 본문, typed, selection, OCR).
- URL 정규화: 기존 `normalizePageUrl`을 유지한다(`http(s)`만 허용, userinfo·query·hash 제거). 쿼리를 통째로 버리므로 토큰이 담긴 URL도 안전하다.
- 마스킹 결과는 payload `masks`에 규칙별 개수로 남기고, 오늘 카운터 `masks`에 반영한다. 저장하지 않은 캡처만 `suppressions`에 반영한다.

### 6.3 프롬프트 인젝션 무력화 (저장 시점 표시, 요약 시점 적용)
- 저장 원문은 redaction만 거친다. 무력화(`neutralizePromptInjectionSyntax`)는 briefing을 조립할 때 적용한다(`05-comprehension.md` §3).

## 7. Denylist (FR-10)

- 규칙 유니온은 `02-architecture.md` §6에 있다. 평가 순서: 명시적 `observe` 규칙은 이 버전에서 **denylist 예외(allow)를 뜻하지 않고** 무시한다. UI는 `do_not_observe`만 만든다.
- **app 규칙**: `observer.configure`로 Side.app에 전달한다. 앱은 해당 bundle의 AX 관찰자 등록, event tap 메타 수집, OCR을 **아예 하지 않는다**(1차 차단).
- **url 규칙**: 데몬이 URL을 해석한 뒤 host가 `domain`과 같거나 `.domain`으로 끝나면 폐기한다(기존 `isDeniedHost` 유지, 2차 차단).
- 차단할 때마다 `suppressions[hourBucket][scope:key] += 1`을 올린다(`SUPPRESSION_BUCKET_MS = 3600000`).
- **기본 denylist** `[design]`: 비어 있음. Side.app 자신과 비밀번호 관리자·Keychain Access·System Settings는 항상 차단한다. 하드 차단 bundle ID의 단일 정본은 `specs/shared/hard-blocked-bundle-ids.json`이며 Swift 번들 복사본과 동일성 테스트로 맞춘다. 확인된 추가 대상은 Apple Passwords, Bitwarden, KeePassXC다. 확인되지 않은 앱 ID는 추측해 넣지 않는다.
- **시크릿 창**: Chrome 계열은 AppleScript로 `mode of front window = "incognito"`이면 캡처하지 않는다. Spike S-4에서 Chrome·Aside의 일반/시크릿 전환은 확인했다. Safari는 AX 창 제목 마커만 관찰되었고 안정적인 비공개 신호는 확인하지 못했다. 따라서 Safari 비공개 창의 캡처 차단을 보장할 수 없다(`docs/qa/spike-s4.md`).
- **앱 피커**: `do_not_observe`로 지정된 bundleId는 추가 다이얼로그의 후보 목록에서 뺀다 `[verified]`.

## 8. 권한·헬스 (FR-8)

### 8.1 HelperHealth (필드 정본, Windows 전용 제외)
```ts
type HelperHealth = {
  platform: "darwin"; protocolVersion: 1
  nativeCaptureAvailable: boolean; inputCaptureAvailable: boolean
  screenOcrAvailable: boolean; screenOcrLanguages: string[]
  accessibilityTrusted: boolean; inputMonitoringTrusted: boolean; screenRecordingTrusted: boolean
  eventTapHealthy: boolean; inputTapRunning: boolean; observerRegistrationFailures: number
  secureInput: boolean; permissionSheetVisible: boolean; systemSessionActive: boolean; idle: boolean
  pid: number; observerPid: number; responsibleSelf: true
  state: "starting" | "running" | "paused" | "stopped"
  asideAdapter: "off" | "available" | "unavailable" | "error"      // 추가
  perApp: Record<string, { chromeOnly: boolean; maxTreeBytes: number }> // helper capture-health
}
```

### 8.2 권한 매트릭스
| 권한 | 필요 조건 | API | 부여 후 동작 |
|---|---|---|---|
| Accessibility | 항상 | `AXIsProcessTrustedWithOptions` | observer 재등록 |
| Input Monitoring | 항상(event tap) | `CGPreflightListenEventAccess` / `CGRequestListenEventAccess` | tap 재생성 |
| Screen Recording | `screenOcr=true`일 때만 `[verified]` | `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess` | helper를 재시작하고 중단된 권한 시트를 재개한다 |
| Automation(브라우저별) | 해당 브라우저가 처음 전경에 올 때 | `AEDeterminePermissionToAutomateTarget` | URL 해석 활성화 |

### 8.3 배너 상태 (UI 문구 `[verified]`)
- `Starting capture…`: `state=starting`
- `Capture is not running`: 데몬 또는 helper가 죽었거나 `nativeCaptureAvailable=false`
- `Permissions needed`: Accessibility 또는 Input Monitoring 미부여 → `Allow` 버튼
- `Some capture features are unavailable`: 필수 권한은 있으나 Screen Recording(OCR 켜짐)·Automation 누락, `eventTapHealthy=false`, `observerRegistrationFailures>0`
- 오류 문구: "The capture helper is not available on this device.", "Context Awareness settings are unavailable. Update and restart Side, then try again."
