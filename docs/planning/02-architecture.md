# 02 — Architecture

## 1. 구성도

```
┌──────────────────────── Side.app (Swift, LSUIElement, 서명·공증) ───────────────────────┐
│ Supervisor ── spawn/재시작 ──┐                                                          │
│ PermissionCoordinator        │ stdio JSON-lines (§3)                                    │
│ CaptureHelper                │                                                          │
│  ├ AXObserver (포커스·제목·선택·값 변경)                                                 │
│  ├ EventTap (listen-only: mouse/keyboard 메타만)                                        │
│  ├ NSWorkspace (activate/launch/sleep/wake/lock)                                        │
│  ├ Vision OCR + SCScreenshotManager                                                     │
│  ├ BrowserURL (NSAppleScript, 6개 브라우저)                                              │
│  └ Keychain (마스터 키 32B)                                                              │
│ SettingsWindow (WKWebView → 127.0.0.1:<port>/?t=<token>)                                │
└──────────────────────────────┼──────────────────────────────────────────────────────────┘
                               ▼
┌──────────────── side-daemon (bun build --compile, Contents/Resources/side) ─────────────┐
│ HelperClient ─► CaptureScheduler ─► Redactor ─► Ledger (ledger.db) ─► TermIndex         │
│      ▲              │                                   │                               │
│      │              └► AsideAdapter (spawn `aside repl`)│                               │
│ Reconciler                                              ▼                               │
│ ComprehensionWorker (60s) ─► ProviderChain (OpenAI 호환) ─► summaries                    │
│ Digest ─► DayPageRenderer ─► memory/episodic/*.md ─► MemoryIndex (index.db: FTS5+vec0)  │
│ GC (6h) · Footprint (5m TTL)                                                            │
│ ApiServer: JSON-RPC over HTTP ── UDS run/daemon.sock (CLI·MCP) + 127.0.0.1 (웹 UI)      │
│ WebUI static (설정 화면)                                                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ UDS                                ▲ UDS
  `side <cmd>` CLI                    `side mcp` (stdio MCP, 에이전트가 spawn)
                                        ├ Claude Code / Codex / Cursor
                                        └ Aside (settings → MCP servers)
```

- 하나의 컴파일 바이너리 `side`가 서브커맨드로 역할을 나눈다: `side daemon`(앱이 spawn), `side mcp`, `side status|search|read|pause|resume|clear|digest|doctor`.
- CLI와 MCP는 데몬 **클라이언트**일 뿐이다. ledger를 직접 열지 않는다. 락 경합과 키 노출을 막기 위해서다.

## 2. 파일 레이아웃

루트 `~/Library/Application Support/Side/` (0700, 환경변수 `SIDE_DATA_DIR`로 재정의 가능. 기존 `LCA_DATA_DIR`는 마이그레이션 때 읽기만 한다)

| 경로 | 내용 | 권한 |
|---|---|---|
| `settings.json` | §6 스키마 | 0600 |
| `context-awareness/ledger.db` (+wal/shm) | 정본 DDL + 보조 테이블 | 0600 |
| `memory/episodic/context-awareness-YYYY-MM-DD.md` | day page (파일 이름 규칙 고정. 루트가 Side 전용이라 충돌 없음) | 0600 |
| `memory/memory-index.json` | 인덱스 manifest | 0600 |
| `index.db` | chunks + FTS5 + vec0 | 0600 |
| `models/` | transformers.js 캐시(multilingual MiniLM q8, ~144MB) | 0700 |
| `run/daemon.sock` | UDS | 0600 |
| `run/web.json` | `{port, tokenHash}` (토큰 원문은 저장하지 않음) | 0600 |
| `logs/daemon.log` | 회전 로그 5MB×3, **캡처 내용은 로그 금지** | 0600 |

앱 번들: `Side.app/Contents/Resources/{side, lib/libsqlite3.dylib, lib/vec0.dylib, web/}`.

## 3. App ↔ daemon 프로토콜 (stdio JSON-lines)

helper 프로토콜의 메시지 타입을 다음으로 고정하고 방향은 App → daemon으로 둔다(ADR-007). 한 줄에 JSON 하나, UTF-8, 한 줄 최대 4MB(`FRAME_MAX_RAW_BYTES`).

```ts
// App → daemon
type Hello   = { type: "hello"; protocolVersion: 1; key: string /* base64 32B, 이 메시지로만 전달 */; appVersion: string }
type Health  = { type: "health"; health: HelperHealth }            // 상태가 바뀔 때마다 + 30s마다
type Event   = { type: "event"; event: RawObservation }            // §03 관찰 원본
type Result  = { type: "result"; id: string; ok: true; data: unknown } | { type: "result"; id: string; ok: false; error: string }
// daemon → App
type Command = { type: "command"; id: string; name: HelperCommand; args?: unknown }
type ProtocolError = { type: "protocol-error"; message: string }    // 양방향
```

`HelperCommand` = `health` · `permissions` · `requestPermissions {kinds}` · `applications.list` · `applications.icons {bundleIds}` · `capture.request {targetKey, shape, trigger}` · `ocr.window {windowId}` · `browser.url {bundleId}` · `observer.configure {deniedBundleIds, captureTypedText, screenOcr, paused}` · `settings.open` · `web.session {port, token}` · `keychain.set {ref, secret}` · `keychain.get {ref}` · `keychain.rotate` (`keychain.set/get`은 provider API 키 전용. `keychain.get`은 요약 호출 직전에만 쓰고 결과를 캐시하지 않음).

- 명령에는 id를 붙여 응답과 짝짓고, 10s가 지나면 타임아웃으로 처리한다. 타임아웃 3회 연속이면 데몬이 `protocol-error`를 보내고 앱이 helper 계층을 재초기화한다.
- **키 전달**: 초기 마스터 키는 `hello` 한 번으로만 전달한다. 전체 삭제 후 `keychain.rotate`의 성공 `result.data={key:<base64 32B>}`가 교체 키를 한 번 전달한다. 앱은 원래 Keychain 항목을 교체한 뒤에만 성공을 응답한다. 데몬은 길이를 검증하고 이전 메모리 키를 지운 뒤 교체 키로 바꾼다. 환경변수와 argv는 `ps`로 보일 수 있어 쓰지 않는다. 데몬은 메모리에만 들고 HKDF로 subkey를 파생한다(`04-data-model.md` §4).
- **웹 세션 전달**: TCP listener가 열리고 `hello`를 받은 뒤 데몬은 `web.session {port, token}`을 앱에 한 번 보내고 `null` 성공 응답을 확인한다. 앱은 세션을 메모리에만 보관하며 데몬이 종료·재시작하면 즉시 버린다. `settings.open`은 기존처럼 설정 창을 열고 `null`을 반환한다. 새 데몬이 새 토큰을 전달하기 전에는 WKWebView를 인증된 상태로 열지 않는다.
- **프로세스 감독**: 데몬이 비정상 종료하면 1s·2s·4s… 최대 60s 간격으로 백오프해 재시작한다. 1분에 5회를 넘으면 중단하고 메뉴바에 "Capture is not running"을 표시한다.

## 4. 데몬 로컬 API (JSON-RPC 2.0 over HTTP)

- **전송**: UDS `run/daemon.sock`(CLI·MCP)와 `127.0.0.1:<ephemeral>`(웹 UI 전용).
- **TCP 방어**: 모든 요청에 `Authorization: Bearer <token>`을 요구하고, `Host`는 `127.0.0.1:<port>`와 정확히 일치해야 한다(DNS rebinding 차단). `Origin`이 있으면 같은 origin만 허용한다. 토큰은 데몬이 시작할 때 32B 난수로 만들어 `web.session` 명령으로 앱에 전달한다. 앱은 최초 WKWebView 요청의 Bearer 헤더와 `?t=` 부트스트랩에 같은 토큰을 넣고, 웹 셸은 첫 RPC 전에 `history.replaceState`로 URL에서 제거한다. 원문 토큰은 앱 메모리 외에 브라우저 히스토리·로그·디스크에 남기지 않는다.
- **절차** (라우터 계약 + 렌더러 소비분):

| 메서드 | 입력 | 출력 |
|---|---|---|
| `status` | `{url?}` | enabled/paused/state, health 요약, 오늘 카운터, 현재 URL denylist 여부 |
| `permissions` | – | `{accessibility, inputMonitoring, screenRecording, automation:{[bundleId]:bool}}` |
| `requestPermissions` | `{kinds?}` | 앱에 `requestPermissions` 위임 |
| `events` | `{from,to,limit,offset}` | 이벤트 메타(복호화된 title/url, 본문 제외) |
| `search` | FR-6 파라미터 | `history_search` 결과 |
| `read` | `{id, match?, contextLines?}` | `history_read` 결과 |
| `memorySearch` | `{query, limit?, from?, to?}` (`limit≤20`) | `07-recall-index.md` §3 하이브리드 결과 `{chunkId, day, windowFrom, windowTo, heading, snippet, summaryId, score}` 목록 |
| `pause` | `{until?}` 또는 `{durationMs?}` | `pausedUntil` |
| `resume` | – | – |
| `clear` | `{target: 'last10m'|'lastHour'|'today'|'all'}` | 삭제 건수, 새 deletion epoch |
| `historyList` | `{from,to}` | 해당 기간 summaries(10min) 목록 |
| `historyStatus` | – | 저장량·평균/일·오늘 요약 상태 |
| `listApplications` / `appIcons` | – / `{bundleIds}` | 앱 피커용 |
| `summaryModelDefault` | – | 해석된 기본 모델 ref |
| `settings.get` / `settings.patch` | – / 부분 객체 | zod 검증 후 저장·reconcile |
| `digest` | `{day?}` | `{days, summaries, failed}` |
| `day.get` | `{date}` | 렌더된 day page 마크다운(없으면 `null`) |
| `providers.setKey` | `{providerId, apiKey}` | 앱에 `keychain.set` 위임 → `{apiKeyRef}`. 키는 데몬 메모리·로그·settings.json에 남기지 않음 |
| `providers.listModels` | `{providerId}` | 저장된 Side provider의 Base URL에 Keychain 키로 `GET /models` → `{status:'available', models:string[]}` 또는 `{status:'unavailable', models:[], reason, httpStatus?}`. 모델 ID만 정규화해 반환하며 키·원시 응답은 반환하지 않음 |
| `providers.test` | `{providerId, modelId}` | 증거 없는 고정 프롬프트로 `record_summary` 1회 호출 → `{ok, latencyMs, toolChoiceSupported, error?}` (Spike S-5를 UI에서 재현) |
| `mcp.usage` | `{sinceMs}` | client name별 도구 호출 수·평균 지연 |

`providers.listModels`는 Side에 사용자가 설정한 OpenAI 호환 Base URL만 사용한다. 끝의 `/`를 제거하고 `/models`를 붙이며, Keychain에서 해당 provider의 키를 읽어 Bearer로 보낸다. 리다이렉트는 따라가지 않아 다른 origin으로 키가 전달되지 않는다. 응답의 `data[].id`만 공백 제거·중복 제거해 반환한다. `unavailable.reason`은 `provider-not-found`, `key-not-configured`, `key-unavailable`, `invalid-base-url`, `redirect-blocked`, `endpoint-unavailable`(HTTP 404/405), `http-error`, `invalid-response`, `request-failed` 중 하나이고, HTTP 응답이 있으면 `httpStatus`를 포함한다. MiniMax/OpenAI는 호환 `GET /models`로 목록을 조회할 수 있다. MiMo 등 목록 API가 없는 provider는 `endpoint-unavailable`을 표시하고 기존 수동 Model ID 입력을 사용한다. 목록 조회는 설정된 모델을 자동 저장하지 않으며 사용자가 편집·저장한다.

Provider 추가 화면에는 `Xiaomi MiMo Token Plan Singapore`(`https://token-plan-sgp.xiaomimimo.com/v1`, `mimo-v2.6-pro`, `supportsToolChoice=false`), `MiniMax M3`(`https://api.minimax.io/v1`, `MiniMax-M3`, `supportsToolChoice=true`), `OpenAI API`(`https://api.openai.com/v1`, 모델 ID는 조회·선택)의 입력 프리셋을 이 순서로 둔다. 사용자는 Base URL·Model ID를 수정하거나 일반 OpenAI 호환 URL을 직접 입력할 수 있다. 프리셋은 키를 포함하지 않으며 키는 기존 `providers.setKey` 경로로만 저장한다. Model ID를 비워 provider를 먼저 저장할 수 있고, 이후 목록 조회 또는 수동 입력으로 채운다.

사용자 승인 확장: `kind: "claude-code-cli"`는 설치된 Claude Code CLI와 기존 로그인을 사용하는 **선택적 요약 provider**다. `kind`가 없는 기존 항목은 `openai-compatible`로 읽는다. CLI 항목은 `id`, 수동 지정한 `models`, `allowEvidence`만 저장하며 Base URL·API 키·실행 파일 경로·임의 인수를 받지 않는다. 기존 체인 해석에 따라 선택된 `summaryModel`/`defaultModel` 또는 후순위 fallback 모델로만 호출된다. 선택 모델이 실패하면 기존 순서대로 다음 허용 provider/model을 시도한다. OpenAI 호환 항목의 URL·Keychain·요청 계약은 그대로 유지한다.

CLI 호출 전 `claude auth status --json`을 출력 비공개·시간 제한으로 확인한다. 요약 호출은 고정 실행 파일 이름 `claude`를 shell 없이 실행하고, `-p`와 stdin, `--restricted --safe-mode --tools '' --strict-mcp-config --no-session-persistence --output-format json --json-schema <record_summary schema> --model <명시적 modelId>`를 사용한다. `--bare`는 기존 로그인을 우회하므로 사용하지 않는다. CLI 자식의 환경에서 `ANTHROPIC_API_KEY` 등 API 키 우선 경로를 제거하되 기존 로그인에 필요한 `USER`·`LOGNAME`·Claude 설정 경로는 유지한다. 프롬프트·응답·인증 결과 원문은 기록하지 않는다. 인증과 요약을 합쳐 `SUMMARY_PROVIDER_TIMEOUT_MS=60_000` 안에 끝내고, stdout+stderr는 `SUMMARY_CLAUDE_MAX_OUTPUT_BYTES=1_048_576`으로 제한한다. 실행 중에는 `SUMMARY_CLAUDE_CONSENT_POLL_MS=100`마다 동의를 확인하며 timeout·동의 철회 때 프로세스를 종료한다. 실행 직전과 결과 수용 직전에 `allowEvidence` 및 설정 동일성을 재확인한다. `--json-schema`에는 `record_summary`의 구조를 전달하고 구조화 출력에서 지원하지 않는 길이·배열 개수 제약은 기존 Zod 검증에서 적용한다. JSON의 `structured_output`만 `record_summary`·citation 검증과 1회 repair 경로에 넣는다. 인증 실패, CLI 부재, 비정상 종료, 형식 오류는 기존 provider 폴백으로 처리한다. 요약 승인 없이 CLI에 실제 캡처를 보내지 않는다. [Claude Code CLI 문서](https://code.claude.com/docs/en/headless)

CLI 항목의 `settings.get` resource는 `kind=claude-code-cli`, `base_url=null`, `host=null`, `has_key=false`, `supports_tool_choice=false`로 표현한다. `providers.setKey`는 CLI 항목에 적용하지 않는다. `providers.listModels`는 CLI에 원격 목록 API가 없으므로 `endpoint-unavailable`을 반환하고 수동 Model ID를 유지한다. `providers.test`는 증거 없는 합성 프롬프트로 동일한 제한된 CLI 경로와 계약을 시험한다. 웹 UI는 CLI 항목에서 Base URL·API 키 입력을 요구하지 않으며 로컬 로그인과 기기 밖 전송을 명확히 표시한다.

## 5. Reconcile

```
reconcile():
  if settings.enabled and platform == 'darwin' and helper.health.nativeCaptureAvailable:
      start scheduler; send observer.configure(...)
      if pausedUntil in future or == PAUSE_INDEFINITE: scheduler.pause()
  else:
      stop scheduler; send observer.configure({paused:true})
      if transitioned enabled→disabled: deletionEpoch unchanged (비활성화는 이력을 지우지 않음)
triggers: 시작 시, settings.patch 후, health 변화 시, pausedUntil 만료 타이머
```

- 켤 때 `pausedUntil`을 지우고, 없는 권한은 자동으로 요청한다(FR-9).

## 6. 설정 스키마 (`settings.json`, zod)

```ts
const Rule = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("app"), behavior: z.enum(["observe","do_not_observe"]), bundleId: z.string().regex(/^[A-Za-z0-9.-]+$/) }),
  z.object({ scope: z.literal("url"), behavior: z.enum(["observe","do_not_observe"]), urlDomain: z.string().regex(/^[A-Za-z0-9.-]+$/) }),
])
const ModelRef = z.object({ provider: z.string(), modelId: z.string() })
const OpenAIProvider = z.object({
  id: z.string(), kind: z.literal("openai-compatible").optional(),
  baseUrl: z.string().url(), apiKeyRef: z.string().optional(), // Keychain 항목명. 키 원문 저장 금지
  models: z.array(z.string()), supportsToolChoice: z.boolean().default(true), allowEvidence: z.boolean().default(false),
})
const ClaudeCodeProvider = z.object({
  id: z.string(), kind: z.literal("claude-code-cli"), models: z.array(z.string().regex(/^claude-[A-Za-z0-9-]+$/)),
  allowEvidence: z.boolean().default(false),
})
const Provider = z.union([OpenAIProvider, ClaudeCodeProvider])
export const Settings = z.object({
  version: z.literal(2),
  contextAwareness: z.object({                          // 정본 키
    enabled: z.boolean().default(false),
    pausedUntil: z.number().int().nullable().default(null), // PAUSE_INDEFINITE = Number.MAX_SAFE_INTEGER
    rules: z.array(Rule).max(500).default([]),
    retentionDays: z.number().int().min(1).max(30).default(14),
    captureTypedText: z.boolean().default(true),
    screenOcr: z.boolean().default(true),
    summaryModel: ModelRef.optional(),
    asideAdapter: z.boolean().default(false),           // 추가: ADR-011, S-1 통과 후 기본값 재검토
  }),
  defaultModel: ModelRef.optional(),
  providers: z.array(Provider).default([]),
  summary: z.object({ modelOverrides: z.array(z.object({ match: z.string(), reasoningEffort: z.enum(["low","medium","high"]), fastMode: z.boolean() })).default([
    { match: "^gpt-\\d+(\\.\\d+)*-luna(-\\d{8})?$", reasoningEffort: "high", fastMode: false },
    { match: "^claude-haiku-", reasoningEffort: "high", fastMode: false },
  ]) }).default({}),
})
```

- **`allowEvidence`**: provider 단위로 켜야만 briefing을 보낼 수 있다. 기본값은 false라서, 사용자가 명시적으로 허용하기 전에는 증거가 기기 밖으로 나가지 않는다.
- **마이그레이션 v1 → v2**: 프로토타입의 `deniedApps`는 app 규칙으로, `deniedWebsites`는 url 규칙(`do_not_observe`)으로 옮긴다(legacy `excludedDomains` 처리와 같은 방식). `pausedUntil: "indefinite"`는 `PAUSE_INDEFINITE`로 바꾸고, `intervalSeconds`는 버린다(스케줄러 상수로 대체).
- 저장은 원자적으로 한다: `tmp`에 쓰고 `rename`한 뒤 `chmod 0600`. 기존 `config.ts` 패턴을 유지한다.
