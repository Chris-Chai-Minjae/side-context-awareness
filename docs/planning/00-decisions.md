# 00 — Architecture Decision Record (Side)

Side = Mac에서의 작업 맥락을 로컬에 기록하고, 나중에 출처와 함께 되찾는 로컬 우선 기억 계층.
요구사항 정본: `docs/planning/01-prd.md`(이하 "PRD 정본").

신뢰 등급: `[verified]` 제품 요구사항에서 확정된 값 · `[measured]` 이 프로젝트에서 2026-09-23~24 실측 · `[decided]` 사용자 결정 · `[design]` 이 spec에서 새로 정한 설계 · `[spike]` 구현 전 실험으로 확정해야 함.

---

## ADR-001 독립 데몬, Aside는 브라우저 소스 어댑터로만 `[decided]`

- **결정**: Side는 Aside 없이 단독 동작한다. Aside Browser가 있을 때만 브라우저 본문을 `aside repl`로 가져오는 optional 어댑터(`source='aside_dom'`)를 붙인다.
- **근거** `[measured]`
  - `aside mcp`가 노출하는 툴은 `exec`, `repl` 2개뿐이다. Context Awareness 제어·기록 API가 없다.
  - `aside memory`는 read-only(search/list/show/path)이고, `aside guide`는 "Never edit memory files yourself"라고 명시한다.
  - Aside와의 접점은 `aside repl` 어댑터 하나로 제한한다. 내부 데몬·ledger에는 의존하지 않는다.
  - 어댑터가 꺼져 있거나 실패해도 캡처는 다른 소스로 계속된다.
- **결과**: 네이티브 관찰·입력·OCR·ledger·요약 큐는 Side가 직접 구현한다.

## ADR-002 스코프 = macOS 전용, 단일 사용자 `[decided]`

- `01-prd.md`의 FR-1~FR-10과 `03-capture.md`·`04-data-model.md`·`05-comprehension.md`·`07-recall-index.md`의 상수 계약을 구현 대상으로 삼는다. 전체 값의 회귀 기준은 `tests/constants.test.ts`에 고정한다.
- **제외**: Windows(`win32`, `win_uia` source, Windows 전용 문구). 플랜·계정 게이트는 두지 않는다(로컬 단독 실행).
- 설계 선택과 근거는 각 ADR과 `01-prd.md` §4에 모아 둔다.

## ADR-003 소비 표면 = MCP stdio 서버 + CLI `[decided]`

- `side mcp`가 stdio MCP 서버로 `history_search`, `history_read`, `memory_search`를 노출한다.
- 대상: Claude Code(`claude mcp add`), Codex, Cursor, **Aside**. Aside `settings.json`의 `mcp.servers`에 context7·blender·magnific이 이미 등록돼 있어 커스텀 MCP 서버를 지원하는 것이 확인됐다 `[measured]`.
- Aside 메모리 디렉터리(`~/.aside/u/0/memory/`)에는 **쓰지 않는다**. 가이드가 금지하고 있고, Aside 자체 CA 렌더러와 파일명(`episodic/context-awareness-*.md`)이 충돌할 수 있기 때문이다.

## ADR-004 요약 LLM = OpenAI 호환 chat.completions, provider 체인 `[decided]`

- 후보: MiMo 2.6 Pro, MiniMax M3, LAN LiteLLM 프록시(`192.168.1.141:8500` 체인; 사용자 확정 2026-09-24). 모두 OpenAI 호환 엔드포인트로 호출한다.
- `record_summary`는 function calling으로 받는다. `tool_choice` 강제를 지원하지 않는 게이트웨이를 위해 "JSON 본문 파싱 + repair turn" 폴백을 둔다.
- **제약** `[measured, 2026-09-09 메모]`: MiMo 게이트웨이는 JSON Schema `pattern`의 `\p{...}`를 400으로 거부한다. 따라서 툴 스키마에 유니코드 프로퍼티 이스케이프를 쓰지 않는다.
- **데이터 반출**: 기기 밖으로 나가는 것은 briefing(redaction을 거친 10분 창 증거)뿐이다. MiMo·MiniMax는 제3자 클라우드이므로, 설정 UI에 전송 대상 host를 표시한다(`06-screens.md`).

## ADR-005 시맨틱 인덱스 = sqlite-vec + 다국어 MiniLM `[decided + measured]`

- `@moss-js/moss-core`는 `license = Proprietary`라 사용할 수 없다 `[measured: npm view 0.29.0]`.
- **스택**: `sqlite-vec@0.1.9`(MIT/Apache)와 `@huggingface/transformers@4.3.0`을 쓰고, 모델은 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`(q8)로 한다.
- **실측** (Bun 1.3.5, M-series): 384차원, 모델 로드 304ms(캐시 후), 3건 임베딩 7ms, 디스크 144MB. 교차언어 검증에서 "어제 본 sqlite 확장 로딩 문서"와 "Bun loadExtension custom SQLite dylib"의 코사인 유사도는 **0.514**, 무관한 문장과는 **0.075**였다.
- 영어 전용인 `all-MiniLM-L6-v2`는 쓰지 않는다. 캡처 콘텐츠에 한국어 비중이 높기 때문이다.
- **필수 조건** `[measured]`: Bun 기본 SQLite는 `This build of sqlite3 does not support dynamic extension loading` 에러를 낸다. 따라서 `Database.setCustomSQLite(<번들 libsqlite3.dylib>)`를 **어떤 Database 생성보다 먼저** 호출해야 한다. 이 경로로 vec0 KNN이 동작함을 확인했다.

## ADR-006 UI = SwiftUI 메뉴바 앱 + 로컬 웹 설정(WKWebView) `[decided]`

- `Side.app`(LSUIElement 메뉴바 앱)이 설정 창을 열면 앱 내부 `WKWebView`가 데몬이 서빙하는 설정 UI(`127.0.0.1:<random port>`)를 띄운다.
- 토큰은 앱이 WKWebView에 주입하므로 외부 브라우저로 새지 않는다.
- 설정 UI의 섹션과 문구는 PRD 정본 FR-7을 따른다.

## ADR-007 프로세스 구조: App → daemon `[design]`

- **Side.app이 부모**가 되어 TCC 권한(Accessibility·Input Monitoring·Screen Recording·Automation)의 주체가 되고, `side-daemon`(`bun build --compile` 산출물, `Contents/Resources/`)을 child로 spawn한다.
- 이유: private API(`responsibility_spawnattrs_setdisclaim`) 없이도 권한이 서명된 .app 번들에 안정적으로 붙는다. 또 AppleScript(브라우저 URL)의 Automation 프롬프트도 "Side"로 뜬다.
- 프로토콜은 JSON-lines(`health|event|result|protocol-error`)를 쓴다(`02-architecture.md` §3).

## ADR-008 저장 스키마 = 정본 DDL + 민감 컬럼 봉인 `[decided]`

- 테이블·컬럼·인덱스는 `04-data-model.md` §2의 정본 DDL을 따른다. PK는 TEXT(ULID)다.
- **봉인 대상**: `window_title`, `url`, `target`, `payload`, `blobs.content`는 AES-256-GCM으로 봉인한 값을 저장한다. 필터용인 `occurred_at, source, kind, app_name, bundle_id, domain, session_id`만 평문으로 둔다.
- 검색 색인은 기존 프로토타입의 keyed-hash term index를 보조 테이블로 유지한다. 디스크에 평문 토큰이 남지 않는다.
- summaries는 평문이다. redaction과 LLM 정제를 거쳤고, 어차피 평문 day page로 렌더되기 때문이다.

## ADR-009 OCR = Apple Vision (tesseract 폐기) `[design]`

- `VNRecognizeTextRequest`(`recognitionLanguages = ["ko-KR","en-US"]`, `.accurate`)를 쓰고, 창 이미지는 `SCScreenshotManager`(macOS 14+)로 얻는다.
- health의 `screenOcrLanguages` 필드와 대응한다. 외부 의존성(brew tesseract)이 없어진다.

## ADR-010 Chromium 계열은 AX로 웹 본문 확보 `[design, spike]`

- Chromium/Electron 앱 요소에 `AXManualAccessibility = true`(Chrome은 `AXEnhancedUserInterface`도)를 설정해 웹 콘텐츠 AX 트리를 활성화한다. 이렇게 하면 Chrome·Arc·Brave·Edge·Aside의 본문을 확장 없이 얻을 수 있다.
- AX 트리가 `EMPTY_TREE_BYTES(2048)` 미만이면 같은 조건에서 `chromeOnly`로 health에 보고하고 OCR 폴백 후보가 된다.
- **Spike S-2**: 브라우저별 활성화 여부와 CPU 비용을 확인한다.

## ADR-011 Aside DOM 어댑터 = `aside repl` per-capture spawn `[measured, spike]`

- 전경 앱이 `at.studio.AsideBrowser`이고 `aside` CLI가 있으면 `listBrowserTabs()` → `attachActiveBrowserTab()` → `snapshot(page)`를 실행한다. 결과는 `shape='aria'`, `source='aside_dom'`로 저장한다.
- 실측: `listBrowserTabs()` 1회 호출이 0.11~0.18s였다. 최소 캡처 간격 2s에 들어온다.
- **Spike S-1**: (a) attach+snapshot이 Aside 세션 기록을 남기는지(`~/.aside/u/0/sessions/`가 이미 614개다), (b) 사용자 탭에 디버깅 표식·포커스 변화가 생기는지 (c) p95 지연. 하나라도 불합격이면 어댑터는 기본 off로 두고 AX 경로(ADR-010)를 쓴다.

## ADR-012 모델별 추론 강도 오버라이드를 설정으로 일반화 `[design]`

- 추론 모델 두 계열(`gpt-*-luna`, `claude-haiku-*`)에는 높은 추론 단계를 쓰는 관행이 있다.
- Side는 `summary.modelOverrides: [{match: <regex>, reasoningEffort, fastMode}]`로 일반화하고 그 두 규칙을 기본값으로 넣는다.

---

## Spike 목록 (빌드 전 확정)

| ID | 질문 | 합격 기준 | 불합격 시 | 실측 결과 |
|---|---|---|---|---|
| S-1 | Aside repl 어댑터의 부작용·지연 | 세션 기록 0, 포커스 변화 0, p95 ≤ 800ms | 어댑터 기본 off | **불합격** `[measured 2026-09-24]`: 100/100 snapshot 성공, 세션 항목 +100, Aside 외 전경 활성화 1회, 프로세스 포함 p95 194.47ms. 개별 세션 증가의 원인과 일시적 UI 표식은 미확인. 상세: [spike-s1](../qa/spike-s1.md). 따라서 기본 off 유지. |
| S-2 | Chromium `AXManualAccessibility` 본문 확보 | Chrome/Arc/Aside에서 본문 ≥ 2048B, 추가 CPU ≤ 1% | 해당 브라우저는 OCR 폴백 | **활성화 불합격** `[measured 2026-09-24]`: Chrome 4,347B·CPU −0.158pp, Aside 단일 AXWebArea 5,599B·+0.266pp였으나 두 트리는 이미 있었고 `AXManualAccessibility` 설정은 양쪽에서 unsupported. Arc·Brave·Edge 미설치. 속성 활성화에 의존하지 않고 기존 AX 본문이 ≥2,048B일 때만 사용하며 부족하면 OCR 후보로 둔다. 상세: [spike-s2](../qa/spike-s2.md). |
| S-3 | 오디오 재생 감지(`AUDIBLE_CONFIRM_TTL_MS`) 방법 | 브라우저 탭/앱 재생 상태를 1s 내 판별 | audible 신호 없이 어텐션 모델 운용 | **미채택** `[measured 2026-09-24]`: CoreAudio runningOutput 조회 78ms, Aside 탭 audible 필드 없음, Chrome 미실행. 실제 재생 시작·정지와 비교한 1s 감지 증거가 없어 신호를 쓰지 않음. 상세: [spike-s3](../qa/spike-s3.md). |
| S-4 | 시크릿 창 감지 | Chrome 계열 `mode of window = incognito` 판별, Safari 비공개 판별 가능 여부 | Safari 비공개는 캡처 차단 불가를 문서화 | **부분 확인** `[measured 2026-09-24]`: Chrome·Aside 일반/시크릿 전환에서 AppleScript `window.mode`가 false/true로 바뀜. Arc·Brave·Edge는 미설치. Safari AX 제목 마커는 변했으나 페이지 제목과 혼동 가능하고 Automation 권한이 없어 안정적 차단 신호는 미확인. 상세: [spike-s4](../qa/spike-s4.md). |
| S-5 | OpenAI 호환 게이트웨이별 `tool_choice` 강제 지원 | MiMo·MiniMax·LAN 각각 `record_summary` 1회 호출 성공 | JSON 폴백 경로로 운용 | **확인** `[measured 2026-09-24]`: MiMo 2.6 Pro direct, MiniMax M3 direct, 사용자 확정 LAN `:8500`의 Grok 4.7 모두 HTTP 200·유효한 tool call 1회씩. MiMo 공식 문서상 강제 선택은 무시되므로 `supportsToolChoice=false`와 JSON 폴백; MiniMax·LAN은 단발 관측에서 `true`. 상세: [spike-s5](../qa/spike-s5.md). |
