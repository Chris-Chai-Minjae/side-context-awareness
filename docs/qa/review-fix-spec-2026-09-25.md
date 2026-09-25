# Side 수정안 스펙시트 (리뷰 기준 HEAD `bb8b5d6`, 2026-09-25)

- 작성: Claude(읽기 전용 리뷰어). 수신: Sol(구현 소유자).
- **범위 제외(사용자 결정):** Apple Developer 서명·공증·바이너리 배포, 실기기·clean-Mac·TCC·장시간 검증. Side는 MIT 소스 배포이며 빌드·실기기 검증은 각 사용자 몫이다. 이 항목들로 태스크를 막거나 되살리지 않는다.
- **공통 규칙:** 기존 HANDOFF 하드 룰을 따른다. 항목마다 RED 테스트 → 구현 → `bun test`, `bun run check`, `swift test --package-path apps/side-mac` 청결. 실제 사용자 데이터·키·ledger는 읽지 않는다.
- **명세 반영:** `[명세 개정]` 표시 항목은 사용자가 이 스펙시트로 요청했다. 코드보다 먼저 `docs/planning/`·`specs/`에 반영하고, 커밋 메시지에 `per user fix spec 2026-09-25`를 남긴다.

## 우선순위 요약

| ID | 심각도 | 제목 | 명세 개정 |
|---|---|---|---|
| F1 | High | redaction 패턴 누락 보강 | 예 (03 §6.2) |
| F2 | High | `side doctor`가 CLI provider에서 항상 FAIL | 아니오 (버그) |
| F3 | Medium | `side_day_counters.suppressions`에 mask 수 기록 | 아니오 (버그) |
| F4 | Medium | `aside_dom` ARIA 스냅샷 필드 단위 차단 | 아니오 (03 §88-89 이행) |
| F5 | Medium | 하드 차단 앱 목록 보강 + 단일 정본화 | 예 (03 §7) |
| F6 | Medium | `history_read` injection 무력화를 search와 통일 | 아니오 |
| F7 | Medium | Keychain 실패(`keychainLocked`) 복구 경로 | 예 (06-screens 메뉴바) |
| F8 | Medium | 명세 밖 구현을 정본 문서에 반영 | 예 (02 §3·§4·§6, specs) |
| F9 | Low | 브라우저 방문기록 title redaction | 아니오 |
| F10 | Low | 레거시 v0.2 프로토타입 모듈 제거 | 아니오 (09 이행) |
| F11 | Low | 온보딩 소개 헤더 문구 | 아니오 (S7 이행) |
| F12 | Low | Codex `auth.json` symlink 갱신 시 토큰 손실 위험 조사 | 아니오 |
| F13 | Low | 71초 실시간 대기 테스트에 시계 주입 | 아니오 |
| F14 | Low | 문서: 빌드 사전 요구, 평문 파생본 고지, doctor 설명 | 아니오 |

---

## F1 [High] redaction 패턴 누락 보강 `[명세 개정: 03-capture.md §6.2]`

**근거(재현함):** 가짜 문자열로 `src/redact/index.ts`의 `redact()`를 돌린 결과, 아래 값이 그대로 남았다. AWS 키·카드번호는 가려졌다.
- `sk-ant-api03-…`, `github_pat_…`, `glpat-…`, `Authorization: Bearer …`, `900101-1234567`
- 서브에이전트 보고(미재현): `-`/`_`가 섞인 `sk-proj-…`, `ya29.…`, `password is X`

`api-key` 규칙(`src/redact/index.ts:33-37`)의 `[A-Za-z0-9]{20,}`는 `-`/`_`를 허용하지 않고 접두어가 `sk|pk|rk`와 `gh[pousr]_`로 한정된다.

**변경 명세**
1. `RedactionRule`에 `bearer-token`, `kr-rrn`을 추가한다. `api-key`는 확장한다. 새 규칙 이름은 masks 카운터와 테스트에 그대로 노출된다.
2. 패턴(JS `u` 플래그, **`\p{…}` 금지**, ADR-004 MiMo 제약):
   - `api-key` 확장:
     - `\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}`
     - `\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{20,}`
     - `\bgithub_pat_[A-Za-z0-9_]{22,}`
     - `\bgh[pousr]_[A-Za-z0-9]{36,}\b`
     - `\bglpat-[A-Za-z0-9_-]{20,}`
     - `\bya29\.[A-Za-z0-9_-]{20,}`
     - `\bAIza[0-9A-Za-z_-]{35}\b`
     - `\bxai-[A-Za-z0-9]{20,}`
     - `\bhf_[A-Za-z0-9]{30,}`
   - `bearer-token`: `\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]{16,}`, 대소문자 무시.
   - `kr-rrn`: `\b\d{6}-?[1-4]\d{6}\b`. 앞 6자리는 유효한 YYMMDD여야 한다(월 01–12, 일 01–31). 카드 Luhn처럼 검증 함수를 둔다.
   - `labeled-secret` 확장: 구분자 `\s*[:=]\s*` 외에 `\s+(?:is|=)\s+`를 허용한다(영문). 한국어 `(?:토큰|비밀번호|암호|인증번호)\s*(?:[:=]|은|는)\s*\S+`.
3. 겹침 처리는 기존 `Match` 병합 규칙을 그대로 따른다. 긴 매치가 이긴다.
4. `03-capture.md` §6.2 표를 위 목록으로 먼저 고친다.

**수용 기준**
- `tests/fixtures/redaction-corpus.{en,ko}.json`의 `positive`에 위 유형을 가짜 값으로 각 2개 이상 추가하고, 테스트가 RED인 것을 먼저 확인한다.
- `negative`에 오탐 방지 예 5개 이상을 추가한다: 일반 날짜 `2026-09-25`, 전화번호 `010-1234-5678`, 9자리 주문번호, "Bearer of bad news", `sk-` 뒤 짧은 단어.
- `tests/gates/g1-canary.test.ts` 카나리아에 `sk-ant-`·`github_pat_`·Bearer를 추가해 ledger 바이트 0회를 확인한다.
- GitHub push protection에 걸리지 않도록 픽스처 바이트를 기존 방식대로 인코딩한다(`docs/qa/publication-history.md` 참조).

## F2 [High] `side doctor`가 CLI provider에서 항상 FAIL

**근거(확인함):** `src/cli/doctor.ts:124-131`은 provider마다 `has_key !== true`면 `allPassed = false`로 처리한다. 그런데 CLI provider(`claude-code-cli`, `codex-cli`)는 `src/api/resources/settings.ts:61`에서 항상 `has_key:false`다.

또 모든 provider가 통과해야 PASS가 되므로, 키 없는 대체 provider가 하나만 있어도 FAIL이 된다.

**변경 명세**
1. provider 판정:
   - `kind`가 `claude-code-cli` 또는 `codex-cli`면 `has_key` 조건을 건너뛰고 `providers.test`를 호출한다.
   - 키 기반 provider에서 `has_key !== true`면 FAIL로 치지 않고, 해당 provider만 `SKIP`(사유: "API key not set")으로 둔다.
2. 결과 집계:
   - 현재 `summaryModel.provider`(없으면 `default_model`)에 해당하는 provider가 test ok → `PASS`.
   - 요약 모델이 지정되지 않음 → `SKIP`.
   - 지정된 provider가 실패 → `FAIL`.
   - 나머지 provider의 실패는 `WARN` 줄로 따로 출력하고 exit code에 반영하지 않는다.
3. 출력 줄에 provider id와 kind만 적는다. host, 키, 모델 응답 본문은 출력하지 않는다.

**수용 기준:** `tests/cli/doctor.test.ts`에 합성 케이스를 추가한다.
- (a) codex-cli 단독 + test ok → PASS, exit 0
- (b) 요약 provider는 ok, 대체 provider는 키 없음 → PASS + SKIP 줄, exit 0
- (c) 요약 provider test 실패 → FAIL, exit 1
- (d) provider 0개 → SKIP (기존 유지)

## F3 [Medium] `suppressions` 카운터에 mask 수가 기록됨

**근거(확인함):** `src/ledger/write.ts:206-215`의 `INSERT INTO side_day_counters (day, events, blobs, raw_bytes, suppressions, masks)`가 `.run(day, newBlobs, newBlobBytes, maskTotal, maskTotal)`로 실행된다.

그 결과 suppressions 열에 mask 수가 들어간다. G2 "suppression > 0" 판정과 설정 화면 통계(`src/ledger/stats.ts:101-103`)가 오염된다.

**변경 명세**
1. 이벤트 쓰기 경로의 suppressions 값은 `0`으로 한다. 저장된 이벤트는 억제된 것이 아니다.
2. 실제 억제(denylist·하드 차단·secure input·필드 차단으로 저장하지 않은 캡처)를 기록하는 경로를 확인한다. 억제 시점에 `side_day_counters.suppressions += 1` 또는 `side_suppressions`를 기록하도록 연결한다. 이미 연결돼 있으면 그 경로만 유지한다.
3. 기존 DB 마이그레이션은 하지 않는다. 오염된 과거 값은 보존 기간이 지나면 자연히 사라진다. 이 사실을 QA 문서에 한 줄 남긴다.

**수용 기준**
- mask 2개가 포함된 이벤트 1건 → `masks=2, suppressions=0`
- denylist 앱 캡처 1건 → `suppressions=1, events=0`

## F4 [Medium] `aside_dom` ARIA 스냅샷 필드 단위 차단

**근거:** `src/capture/aside-adapter.ts:12-24`가 `aria.tree`를 그대로 받는다. `src/daemon/index.ts:515-525` 경로에는 정규식 redaction만 있다. 반면 Swift AX 경로는 `FieldLabels.blockedRule`로 텍스트 필드를 제외한다(`AXSnapshot.swift:63-65`). 명세 03-capture.md §88-89는 ARIA에도 같은 규칙을 요구한다. 어댑터는 기본 off라 영향은 제한적이다.

**변경 명세**
1. `src/capture/aria-fields.ts`(신규)에 `suppressAriaFields(tree: string): { tree: string; suppressed: number }`를 둔다.
2. Playwright ARIA snapshot의 YAML형 줄(`- textbox "Label": value`, `- searchbox`, `- combobox`, `- spinbutton`)을 줄 단위로 파싱한다.
   - 역할이 입력류이고 `src/redact/fields.ts`의 규칙(`field-label`, `autocomplete`, `input-type`)에 이름이 걸리면 값을 `[redacted:field]`로 치환한다.
   - 이름을 알 수 없으면 입력류 값은 **항상 제거**하고 이름만 남긴다. 기본값은 fail-closed다.
3. 일반 텍스트(`- text:`, `- heading`, `- link` 등)는 유지한다.
4. REPL 코드에서 가능하면 `snapshot` 옵션으로 입력값을 빼는 방법을 먼저 검토한다. 없으면 위 후처리만 한다.
5. 치환 수는 masks에 합산한다(F3과 일관).

**수용 기준:** 합성 ARIA 픽스처에서 확인한다.
- password·OTP·카드 라벨 textbox 값 0회
- 일반 textbox 값 제거
- heading·link 텍스트 보존

## F5 [Medium] 하드 차단 앱 목록 보강 + 단일 정본화 `[명세 개정: 03-capture.md §7]`

**근거:** 같은 목록이 세 곳에 중복돼 있다: `src/policy/index.ts:13-19`, `apps/side-mac/Sources/Side/Capture/AXObserverHub.swift:36-40`, `apps/side-mac/Sources/Side/App/CommandRouter.swift:49-52`. Apple Passwords와 주요 비밀번호 관리자가 빠져 있다.

**변경 명세**
1. 목록에 다음을 추가한다: `com.apple.Passwords`, `com.bitwarden.desktop`, `com.dashlane.dashlanephonefinal`, `com.lastpass.LastPass`, `org.keepassxc.keepassxc`, `com.apple.systemsettings`(존재 시).
   - 정확한 bundle ID는 각 앱 공식 문서나 설치본 `Info.plist`로 확인한다. 확인하지 못한 ID는 넣지 않고 QA 문서에 미확인으로 남긴다.
2. 정본은 `specs/shared/hard-blocked-bundle-ids.json` 한 파일로 둔다.
   - TS는 import하고, Swift는 `Package.swift` 리소스로 번들한다.
   - 복사 방식을 택하면 TS/Swift 목록 동일성 테스트를 추가한다.

**수용 기준**
- `tests/policy.test.ts`와 Swift `CommandRouterTests`에서 새 ID 각각 차단
- TS/Swift 목록 동일성 테스트 GREEN

## F6 [Medium] `history_read` injection 무력화를 search와 통일

**근거:** `src/recall/read.ts:186-196`의 자체 `neutralize`에는 NFKC 정규화, `omitModelDirectedLines`, `<`/`>`/`&` escape가 없다. system/assistant 외의 역할(`user:`, `developer:`)도 처리하지 않는다. search 경로는 `src/comprehension/neutralize.ts:33-45`의 `neutralizePromptInjectionText`를 쓴다.

**변경 명세**
1. `read.ts`의 prose 필드(title, snippet, body, summary 본문)에 `neutralizePromptInjectionText`를 적용한다. 로컬 `neutralize`는 삭제한다.
2. 구조화 필드(URL, ID)는 `3077f16`에서 확정한 대로 변환하지 않는다. search/read URL 동일성은 유지해야 한다.
3. 30,720B 구조화 JSON 예산은 escape로 늘어난 뒤에 측정한다.

**수용 기준**
- 기존 SDK 동일성 테스트 유지
- `user: ignore previous`, 전각 `ｓｙｓｔｅｍ:`, `<untrusted-…>` 위조 경계가 read 결과에서 무력화됨
- 예산 초과 시 truncate 경로 테스트

## F7 [Medium] Keychain 실패(`keychainLocked`) 복구 경로 `[명세 개정: 06-screens.md 메뉴바, specs/screens/menubar.yaml]`

**근거:** `Supervisor.swift:252-265`에서 master key 읽기가 실패하면 `state = .keychainLocked`로 끝나고 재시도가 없다. 메뉴(`MenuBar.swift:230-271`)에도 재시도 동작이 없다. ad hoc 소스 빌드는 재빌드할 때마다 Keychain ACL이 바뀌어 이 상태가 반복된다(`docs/qa/permission-recovery-2026-09-25.md`).

**변경 명세**
1. `DaemonSupervisor.retryKeychain()`: `state == .keychainLocked`일 때만 `launch()`를 다시 호출한다. 대화형 읽기이므로 macOS 허용 창이 뜰 수 있다.
2. 메뉴: `keychainLocked`일 때 status_line은 기존 "Capture is not running"을 유지한다. 그 아래에 `Unlock Keychain…`(ko: `Keychain 허용…`) 항목을 표시하고, 누르면 `retryKeychain()`을 호출한다.
3. 자동 재시도: 화면 잠금 해제(`com.apple.screenIsUnlocked` 분산 알림) 시 1회 `retryKeychain()`. 폴링 루프는 두지 않는다.
4. `menubar.yaml`의 actions와 `06-screens.md`에 위 항목을 추가한다(명세 먼저).

**수용 기준**
- `SupervisorTests`: 가짜 KeyStore가 1회 실패 후 성공 → `retryKeychain()` 뒤 `running`, 실패 중에는 재시도 없음
- `MenuStateTests`: `keychainLocked`에서만 항목 노출

## F8 [Medium] 명세 밖 구현을 정본 문서에 반영 `[명세 개정]`

**근거:** 하드 룰 4("문서를 먼저 고친다")가 지켜지지 않았다. 코드와 QA 문서에만 있는 항목:
- RPC: `providers.keyStatus`, `providers.authorizeKey`, `summaries.retryFailedToday` (`src/contracts/rpc.ts:134,162,166`)
- helper 명령: `keychain.status`, `keychain.authorize` (`Supervisor.swift:227-233`)
- provider `kind: "codex-cli"` (`src/contracts/settings.ts:37-42`) — `resources.yaml:76`에는 `claude-code-cli`만 있음
- CLI provider `host` 값: 명세는 `null`, 코드는 `"Claude Code service"` / `"OpenAI (Codex login)"` (`src/api/resources/settings.ts:57`)
- 화면: `/permissions` 페이지, Day view 실패 요약 재시도 UI, Codex 로그인 preset, 메뉴 `Open at Login` 항목(P5-T5.3 명세에는 있으나 menubar.yaml에는 없음)

**변경 명세:** 코드는 바꾸지 않고, 사용자 요청에 따라 문서를 현행 구현에 맞춘다.
1. `02-architecture.md` §4 표에 RPC 3개를 추가한다. 인증, 반환 형태(boolean·count만), 호출 화면을 적는다.
2. §3 HelperCommand 목록에 `keychain.status`/`keychain.authorize`를 추가한다.
3. §6 설정 스키마와 `resources.yaml`에 `codex-cli`를 추가한다. 격리 규칙은 `docs/qa/codex-login-provider.md`에서 옮긴다.
4. CLI provider `host`: 명세를 코드 값으로 개정한다. 설정 UI의 "전송 대상 표시"(ADR-004)에 더 맞다.
5. `specs/screens/index.yaml`에 `permissions` 화면을 추가하고 `specs/screens/permissions.yaml`을 신설한다(필드는 현 `src/web/pages/permissions.tsx` 기준).
6. `day-view.yaml`에 retry 컴포넌트를, `menubar.yaml`에 `Open at Login`을 추가한다.
7. `tests/contracts/rpc.test.ts:36`의 메서드 목록을 문서 표에서 생성하거나 대조하는 테스트로 바꿔 재발을 막는다.

**수용 기준:** 문서 표와 `RpcMethods` 키 집합이 같다(자동 테스트). 화면 yaml `needs`의 필드 커버리지 테스트(P0-T0.9 계약 테스트) GREEN.

## F9 [Low] 브라우저 방문기록 title redaction

**근거:** `src/recall/browser-history.ts:170-183`이 `row.title`을 그대로 반환한다. 저장되지는 않지만 MCP `history_search`로 에이전트에게 전달된다.

**변경:** 반환 전에 `redact(title).text`와 `neutralizePromptInjectionText`를 적용한다. URL은 기존 `normalizePageUrl` 경로를 유지한다.

**수용:** 합성 History DB에서 title에 가짜 `sk-ant-…`를 넣으면 결과에서 가려진다.

## F10 [Low] 레거시 v0.2 프로토타입 모듈 제거

**근거:** `src/{runtime,summary,memory-search,recall,day-pages,store,observe}.ts`(약 888줄, Ollama `127.0.0.1:11434` 호출 포함)는 daemon·CLI·MCP 진입점에서 import되지 않고 테스트에서만 쓰인다.

추가로 `"../policy"`는 `src/policy/index.ts`가 아니라 `src/policy.ts`로 해석된다. 현재 5곳(`ledger/write.ts:6`, `daemon/index.ts:48`, `capture/aside-adapter.ts:8`, `recall/search.ts:11`, `recall/browser-history.ts:14`)은 `normalizePageUrl`만 가져오므로 정상이다. 그러나 두 파일에 이름은 같고 시그니처가 다른 `isDeniedHost`/`isDeniedApp`가 있다(`policy.ts:15,23`은 문자열 배열, `policy/index.ts`는 규칙). 레거시 `shouldCapture`에는 하드 차단도 없어 잘못 import될 위험이 있다.

**변경**
1. 위 7개 파일과 대응 테스트(`tests/{day-pages,memory-search,observe,store,summary}.test.ts`, 그리고 `mcp.test.ts`·`typed.test.ts`가 레거시만 검사하면 포함)를 삭제한다.
2. `src/policy.ts`의 현행 사용 함수(`normalizePageUrl` 등)는 `src/policy/url.ts`로 옮기고 import를 명시 경로로 바꾼다.
3. `src/typed.ts`, `src/redact/fields.ts`, `src/redact.ts`, `src/crypto.ts`, `src/config.ts` 중 레거시 전용인 것만 삭제한다. 현행 경로가 쓰는지는 import 그래프로 확인한다.
4. `package.json`의 `@modelcontextprotocol/server` 의존성은 현행 코드가 쓰지 않으면 제거한다. 07 §6 정본은 `@modelcontextprotocol/sdk@1.30.0`이다. dev의 `@modelcontextprotocol/client`도 같은 기준으로 판단한다.
5. `09-prototype-migration.md`의 해당 행을 "제거됨"으로 갱신한다.

**수용:** `bun test`·`bun run check` 청결, `bun run build` 성공, 제거된 경로를 import하는 파일 0개(`grep`).

## F11 [Low] 온보딩 소개 헤더 문구

**근거:** 06-screens S7-1은 소개 화면에 헤더 문구 **"Let Side remember your day"**와 "Everything stays on this Mac unless you choose a summary provider."를 요구한다. 코드는 "Set up Side"다(`apps/side-mac/Sources/Side/UI/OnboardingView.swift:95`).

**변경:** 헤더를 명세 문구로 바꾼다(ko는 웹과 같은 "Side가 하루를 기억하도록", `src/web/i18n.ts:44`). 보조 문구가 있는지 확인한다. Swift와 웹의 한국어 문구가 다른 곳(`MenuBar.swift:66` vs `i18n.ts:41`)도 웹 기준으로 맞춘다.

**수용:** `OnboardingFlowTests` 또는 스냅샷 수준 문자열 테스트.

## F12 [Low] Codex `auth.json` symlink 갱신 시 토큰 손실 위험 조사

**근거(추론, 미재현):** `src/comprehension/codex-cli.ts:161`은 임시 CODEX_HOME에 사용자 `auth.json` symlink를 둔다. Codex가 토큰 갱신을 atomic rename으로 하면 symlink가 일반 파일로 바뀐다. 그러면 Side가 실행을 거부하고 `rmSync`(:248)로 임시 디렉터리를 지우면서 **갱신된 토큰도 삭제**되어, 원본 CODEX_HOME에는 만료 토큰만 남을 수 있다.

**변경**
1. 합성 stub으로 "login 단계에서 symlink를 새 파일로 교체"하는 케이스를 재현한다. 기존 `replace-auth-link` 테스트의 결과에서 원본 `auth.json` 내용이 보존되는지 확인한다.
2. 위험이 재현되면 삭제 전에 교체된 파일이 있는지 확인한다. 소유자·0600·JSON 형식 검증을 통과하면 원본 위치로 atomic 이동(rename)하고, 실패하면 임시본을 지우지 않고 오류로 남긴다.
3. 재현되지 않으면 테스트만 추가하고 종결한다.

**수용:** 교체 시나리오에서 원본 `auth.json`이 최신 합성 내용으로 남는다.

## F13 [Low] 71초 실시간 대기 테스트에 시계 주입

**근거:** `OnboardingRPCTests.testProviderTestAcceptsQueuedResponseAfterSeventyOneSeconds`가 실제로 71초, 11초 테스트 2개가 각 11초를 기다린다. 이 때문에 전체 Swift 테스트가 약 105초로 느리다.

**변경:** `OnboardingRPC`의 타임아웃·대기를 `Clock` 프로토콜(또는 주입 가능한 sleep/deadline 함수)로 받는다. 테스트에서 가상 시계로 71s·11s·10s 경계를 검증한다. 운영 기본값은 그대로 둔다.

**수용:** 같은 세 경계를 검증하면서 해당 테스트가 각각 1초 이내에 끝난다.

## F14 [Low] 문서 정확성

1. **빌드 사전 요구:** `README.md`/`README.en.md`의 설치 절과 `docs/manual.md` §1–2에 `brew install sqlite`(또는 `SIDE_SQLITE_LIBRARY` 지정)를 명시한다. `apps/side-mac/scripts/build-app.sh:21-30`이 Homebrew 경로를 기대한다.
   - "실행하는 Mac에는 Homebrew가 필요하지 않습니다"는 사실이다(번들 dylib가 시스템 라이브러리만 참조). 다만 소스 배포에서는 빌드 Mac이 곧 실행 Mac이므로, 빌드 시 필요하다는 점을 먼저 적는다.
   - `swift test`에는 전체 Xcode가 필요하다는 점도 개발자 절에 적는다.
2. **평문 파생본 고지:** README 프라이버시 절에 적는다. day page(인용 제목·주소 포함)와 검색 색인(`index.db`)은 암호화되지 않은 로컬 파일이고, 원본 보존 기간(기본 14일)이 지나도 요약·색인에 남는다. 전체 삭제로만 제거된다. ADR-008의 설계와 일치한다.
3. **doctor:** F2 이후 provider 줄의 PASS/SKIP/WARN 의미를 manual §5에 적는다.
4. **서명·배포:** "Developer ID 서명·공증은 아직 남아 있습니다" 류 문구를 "소스 배포 정책상 사전 빌드 앱은 제공하지 않습니다"로 정리한다. 미완 과제처럼 읽히지 않게 하되, ad hoc 서명의 재빌드 시 권한 재허용 안내는 유지한다.

---

## 제외 확인

다음은 사용자 결정으로 이 스펙시트에서 다루지 않는다: P5-T5.2 서명·공증, clean-Mac 설치(P5-T5.1 수용 중 clean-Mac 부분), P5-T5.3 재부팅 검증, P1-V/P2-V 실기기 항목, P4-S3/S4 네이티브 스크린샷·TCC 녹화, NFR 실기기 측정.

`06-tasks.md`에서 이 항목들을 어떻게 표기할지(예: "소스 배포 정책으로 사용자 몫" 주석)는 사용자에게 확인한 뒤 반영한다.
