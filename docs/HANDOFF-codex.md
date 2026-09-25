# HANDOFF → Codex: Side 구현 전체

- 작성: Claude(기획 담당), 2026-09-24
- 이 문서부터 **구현의 소유자는 Codex**다. Claude는 기획까지만 했고 감독하지 않는다. 완료 보고는 사용자에게 직접 한다.

## 무엇을 만드나
Mac에서 사용자의 작업 맥락을 로컬에 기록하고 요약해 두었다가 에이전트가 다시 찾게 해주는 메뉴바 앱 **Side**다(Windows 미지원). 네가 만든 프로토타입 `local-context-awareness` v0.1.0(테스트 21개 통과) 위에 증축한다.

## 읽는 순서 (정본)
1. `docs/planning/00-decisions.md`: ADR 12개와 Spike S-1~S-5. **결정을 바꾸려면 먼저 사용자에게 묻는다**
2. `docs/planning/01-prd.md`: 범위·설계 선택·수용 시나리오·마일스톤
3. `docs/planning/06-tasks.md`: **실행 순서 정본**(75개, 의존성 그래프 포함)
4. 태스크가 가리키는 상세 문서 `02~05, 07~09`와 `specs/`(화면 4개 + `domain/resources.yaml`)

## 하드 룰
0. **명세가 최종 기준이다.** `docs/planning/`과 `specs/`는 사용자가 검토·승인한 정본이다. 코드를 명세에 맞추고, **명세를 코드에 맞춰 고치지 않는다.** 명세에 정의된 기능은 바꾸지 않는다. 라이브러리 교체나 방식 변경은 **기능이 같고 명확한 개선일 때만** 제안할 수 있고, 반드시 사용자 승인을 받은 뒤 사용자가 명세를 고치게 한다. 승인 전에는 명세대로 구현한다.
1. **순서**: P0 → P1 → P2 → P3 → P4 → P5. Phase 안에서는 `06-tasks.md`의 의존/병렬 표를 따른다. Spike(P0-T0.4~T0.8)는 **해당 기능 구현 전에** 결과를 `00-decisions.md` Spike 표에 기록한다.
2. **TDD**: 모든 Phase 1+ 태스크는 테스트를 먼저 쓰고(RED) → 구현(GREEN) → 정리한다.
3. **완료 판정은 증거로**: 태스크의 G/W/T 수용 기준과 연결 게이트(`08-nfr-test-gates.md` §4)를 명령 출력으로 확인한 뒤에만 `06-tasks.md`의 `[ ]`를 `[x]`로 바꾼다. 매 태스크마다 `bun test`, `npx tsc --noEmit`, `npx biome check .`을 청결하게 유지하고, Swift가 있으면 `swift test --package-path apps/side-mac`도 돌린다.
4. **API 헌법**: 로컬 API는 `02-architecture.md` §4 표에 있는 메서드만 만든다. 필요한 메서드가 생기면 **문서를 먼저 고치고** 커밋 메시지에 남긴다.
5. **상수**: 모든 수치는 `src/constants.ts`에서 가져온다(G5). `[verified]` 값을 임의로 바꾸지 않는다.
6. **프라이버시·보안**
   - 캡처 원문, 키, API 키를 로그·테스트 스냅샷·커밋에 남기지 않는다.
   - `~/.aside/` 아래는 **읽기만** 한다. Aside 메모리 디렉터리에 쓰는 것은 금지다.
   - 실제 사용자 ledger(`~/.aside/u/0/context-awareness/ledger.db`)의 행 내용은 읽지 않는다(스키마는 이미 `04-data-model.md`에 있다).
7. **외부 입력이 필요한 지점에서는 멈추고 사용자에게 묻는다**:
   - S-5: MiMo, MiniMax API 키와 엔드포인트
   - P5-T5.2: Developer ID 인증서
   - TCC 권한 부여 같은 실기기 수동 단계
   위 셋에 걸리지 않는 태스크는 먼저 계속 진행한다.
8. **범위**: 태스크에 없는 기능을 추가하지 않는다. 인접 코드를 개선하고 싶으면 보고서에 제안만 적는다.
9. **git**: P0-T0.1에서 `git init` 후 태스크 단위로 커밋한다(메시지에 태스크 ID). push는 하지 않는다. 원격이 없다.
10. **병렬화**: 구현 소유자는 너 하나다. 병렬 작업이 필요하면 네 판단으로 하위 워커(서브에이전트나 Orca 워커)를 직접 띄우고, 그 워커에게도 이 하드 룰을 그대로 전달한다.
11. **표기**: 이 저장소는 Side를 독립 프로젝트로 서술한다. Aside는 연동 대상(Aside Browser 어댑터, MCP 클라이언트)일 때만 언급하고, 개발 동기나 다른 제품을 재현·차용했다는 표현은 쓰지 않는다.

## 진행 표시와 보고
- 의미 있는 지점마다 `orca worktree set --worktree active --comment "<P?-T? 상태>" --json`으로 상태를 남긴다.
- 각 Phase가 끝나면 `docs/qa/phase-<N>-report.md`를 쓴다: 완료 태스크, 게이트 결과, 증거 명령과 출력 요약, 미결 사항.
- 막히면 막힌 태스크와 이유를 보고서의 "미결"에 적고, 의존하지 않는 다음 태스크로 넘어간다.

## 현재 상태 (인수 시점, 2026-09-24 00:29 실측)
- git 저장소가 아니다(커밋 0).
- `src/` 14모듈·1,304줄, 테스트 27개 통과, `tsc` 0 오류. 명세 작성 도중 네가 v0.2 모듈을 추가했다.
- **v0.2 코드는 명세 이전에 만든 것이라 명세와 다른 곳이 있다. 전부 명세에 맞춰 고친다**(하드 룰 0):

| 네 v0.2 모듈 | 현재 방식 | 명세 기준 (그대로 따름) |
|---|---|---|
| `src/summary.ts` | Ollama `/api/chat` 고정, 출력 `{title, body, sourceIds:number[]}` | `05-comprehension.md` 전체: `record_summary` 계약, OpenAI 호환 provider 체인(ADR-004) → P2 |
| `src/memory-search.ts` | Ollama `/api/embed`, 벡터를 `ContextStore`에 저장 | ADR-005: 프로세스 내 `paraphrase-multilingual-MiniLM-L12-v2` + `index.db` sqlite-vec → P3-T3.2~T3.4 |
| `src/mcp.ts` | `@modelcontextprotocol/server@2.0.0`, 런타임 직접 오픈 | `07` §6: `@modelcontextprotocol/sdk@1.30.0`, 데몬 UDS 클라이언트, `memory_search` 포함 → P3-T3.8 |
| `src/runtime.ts` | `context.sqlite` + 키 직접 로드 | ledger `context-awareness/ledger.db`(P1-T1.5), 키는 helper `hello`로 수신(P1-T1.10) |
| `src/recall.ts`, `src/day-pages.ts`, `src/cli.ts` | 기본 동작 | `07` §4–5·§1·§7 명세대로 확장 → P3-T3.5·T3.6, P2-T2.7, P3-T3.9 |

- MCP v2 패키지가 더 낫다고 판단되면 **구현하지 말고 먼저 사용자에게 제안**한다(근거: 기능 동일성, 개선 내용).
- 기획 산출물:
  - `docs/planning/00~09`, `06-tasks.md`
  - `specs/`
  - `.stargate/state.json` (current_phase 4 = 빌드, build_mode = codex-delegation)
- 직전 대화가 "Conversation interrupted"로 끊겨 있었다. 그 작업은 이 브리프로 대체한다.
