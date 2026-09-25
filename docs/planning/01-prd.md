# 01 — PRD: Side (macOS Context Awareness)

## 1. 한 줄 정의

> **Let Side remember your day** — Side captures what you do in your browser and apps so agents can recall it later.

Mac에서 사용자가 하는 일(브라우저 탭, 앱 창, 입력한 문장, 선택한 텍스트, 클릭, 화면 OCR)을 수동으로 관찰한다. redaction과 암호화를 거쳐 로컬 ledger에 저장하고, 백그라운드 LLM이 10분 창 요약과 6시간 롤업을 쓴다. 결과는 일일 마크다운 페이지로 렌더되고, MCP를 통해 **모든 로컬 에이전트**(Claude Code·Codex·Cursor·Aside)가 "그때 뭐 하고 있었지 / 그 페이지 어디였지"를 인용과 함께 되찾는다.

## 2. 목표 / 비목표

**목표**
- G1 수동 관찰만으로 하루를 재구성한다. 수동 저널링은 없다.
- G2 원시 증거는 기기 안에 둔다. redaction은 저장 **전**에 하고, 모델에는 briefing만 보낸다.
- G3 에이전트가 시각·장소·내용을 `e:`/`s:` 인용과 함께 회수한다.
- G4 비용에 상한을 둔다. 모델 호출당 바이트 예산, 큐 상한, 디스크 상한(보존 기간 + vacuum)을 고정한다.
- G5 에이전트 중립: MCP 하나로 어떤 에이전트든 같은 기억을 읽는다.

**비목표**
- 화면 녹화기나 전체 이력 아카이브가 아니다. 원시 캡처는 보존 기간이 지나면 삭제하고 요약만 남긴다.
- 원시 캡처를 클라우드에 업로드하지 않는다. 원격 동기화도 없다.
- Windows를 지원하지 않는다. 플랜 게이트도 없다.
- 멀티 유저·멀티 기기를 지원하지 않는다. 계정 개념은 로컬 1인으로 고정한다.

## 3. 사용자·행위자

| 행위자 | 책임 |
|---|---|
| 사용자 | 켜기/일시정지, 보존 기간·denylist 설정, OS 권한 부여, 이력 열람·삭제 |
| Side.app (Swift) | TCC 권한 주체, 네이티브 관찰(AX·event tap·Vision OCR·AppleScript), 데몬 감독, 설정 창 |
| side-daemon (Bun) | 스케줄러, redaction, ledger, 요약 큐, 다이제스트, GC, 인덱스, 로컬 API, 웹 설정 UI |
| Aside 어댑터 (optional) | Aside Browser 활성 탭의 ARIA 스냅샷 제공(`source='aside_dom'`) |
| 요약 모델 | 창마다 `record_summary` 1회 호출 |
| 에이전트 | `side mcp`로 `history_search`·`history_read`·`memory_search` 사용 |

## 4. 설계 선택

| 영역 | 선택 | 근거 |
|---|---|---|
| 플랫폼 | macOS(darwin)만 | ADR-002 |
| 계정·플랜 게이트 | 없음(로컬 단독 실행) | ADR-002 |
| 캡처 소스 | `mac_ax`, 브라우저 URL, OCR, 선택적 `aside_dom` 어댑터 | ADR-001/011 |
| 프로세스 | App → daemon | ADR-007 |
| 에이전트 도구 | MCP stdio(`side mcp`) 세 도구 | ADR-003 |
| 모델 | OpenAI 호환 provider 체인 | ADR-004 |
| 시맨틱 인덱스 | MOSS (독점) | sqlite-vec + multilingual MiniLM | ADR-005 |
| OCR | 온디바이스(구현 불명) | Apple Vision | ADR-009 |
| 저장 암호화 | evidence content만 | + window_title·url·target·payload, term index 해시 | ADR-008 |
| 설정 UI | Electron renderer | WKWebView 안의 로컬 웹 | ADR-006 |

## 5. 기능 요구사항 (FR ↔ 상세 문서)

| FR | 이름 | 상세 문서 | 핵심 수용 기준 |
|---|---|---|---|
| FR-1 | 캡처 스케줄링 | `03-capture.md` §3 | §11 상수 일치, 트리거 승격, 동시 2, 스윕 8 |
| FR-2 | 저장 전 redaction | `03-capture.md` §6 | 카나리아 비밀이 ledger 바이트에 0회 등장 |
| FR-3 | 로컬 증거 저장소 | `04-data-model.md` | 정본 DDL, 봉인 컬럼, frame 압축 |
| FR-4 | 요약 파이프라인 | `05-comprehension.md` | 10분/6h, lease·재시도·repair, 인젝션 무력화 |
| FR-5 | 일일 페이지 + 인덱스 | `07-recall-index.md` §1–3 | 렌더 v3 포맷, write fence, 하이브리드 검색 |
| FR-6 | 에이전트 회수 도구 | `07-recall-index.md` §4–5 | MCP 3종, lexical 랭킹 공식 일치 |
| FR-7 | 설정 화면 | `06-screens.md` | 섹션·문구는 `06-screens.md` 정본 |
| FR-8 | 권한·헬스 | `03-capture.md` §8, `06-screens.md` §2 | health 필드 정본(Windows 필드 제외) |
| FR-9 | 보존·삭제·저장량 | `04-data-model.md` §5–6 | GC 6h, vacuum 16MB, delete-wins |
| FR-10 | Denylist | `03-capture.md` §7 | 규칙 유니온, legacy 마이그레이션 |

## 6. 성공 지표 (수용 시나리오)

- **S1 하루 재구성**: 8시간 사용 후 day page에 10분 섹션이 활동 시간만큼 생긴다(활동 없는 창은 섹션 없음). 섹션마다 `Sources:` 인용이 1개 이상 있다.
- **S2 회수**: "어제 오후에 보던 sqlite 확장 문서"를 Claude Code에서 물으면 `history_search` 상위 5개 안에 해당 URL이 나오고, `history_read e:<id>`로 원문 스니펫을 볼 수 있다.
- **S3 프라이버시**: 비밀번호 필드 입력, 카드번호, AWS 키가 들어간 세션을 거친 뒤 ledger.db·day page·인덱스 파일 바이트를 검색하면 해당 문자열이 0건이다.
- **S4 삭제 우선**: "Last hour" 삭제 직후 진행 중이던 요약·렌더가 끝나도, 삭제 구간의 요약·페이지 섹션이 부활하지 않는다.
- **S5 비용**: 요약 1회 입력은 briefing 49,152B + 오버헤드 4,096토큰 이하이고, 동시에 도는 요약 작업은 6개 이하다.
- **S6 에이전트 중립**: Claude Code와 Aside에서 같은 질의에 같은 결과 id가 나온다.

## 7. 릴리스 단위 (마일스톤)

| M | 내용 | 종료 기준 |
|---|---|---|
| M0 | Spike S-1~S-5 | `00-decisions.md` 표 갱신 |
| M1 | 관찰 → ledger | Side.app + 데몬 + FR-1/2/3/8/10, 이벤트가 쌓이고 health가 뜸 |
| M2 | 요약 → day page | FR-4/5(렌더까지), provider 체인 |
| M3 | 회수 | FR-5 인덱스 + FR-6 MCP·CLI, 에이전트 등록 가이드 |
| M4 | 설정·운영 | FR-7/9 전체, 삭제·보존·저장량 UI, 서명/공증 |
