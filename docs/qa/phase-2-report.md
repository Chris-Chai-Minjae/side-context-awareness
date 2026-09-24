# Phase 2 — M2 요약·day page (자동 검증 완료, 실사용 게이트 진행 중)

기준: 2026-09-24, `phase-2-comprehension`. P2-T2.1~T2.7 코드를 구현했다. `P2-V`의 실제 provider 1시간 실사용 확인은 아직 완료하지 않았다.

## 구현·검증 범위

- 5초 미만 glance 제외, 10분 창과 6시간 rollup 작업 생성, lease·최대 3회 재시도, 2개 동시 모델 호출, briefing 예산·인용 집합, `record_summary` 계약·repair, 허용된 provider 체인, day page v3 렌더와 dirty day digest를 연결했다.
- 데몬의 60초 타이머가 enqueue 후 요약 pass를 실행하고, 매 정시에도 digest를 재시도한다. 삭제 epoch가 provider 응답 중 바뀌면 `withFence`가 커밋을 폐기한다.
- `tests/integration/phase2.test.ts`의 가짜 HTTP provider로 같은 날 활동 10분 창 2개가 인용을 가진 섹션 2개가 되는 것, 위반 출력의 repair 1회·3차 실패, 응답 대기 중 삭제된 증거의 폐기를 확인했다. `tests/daemon/reconcile.test.ts`는 데몬 타이머부터 day page까지 확인한다.
- G3: `tests/memory/render.test.ts`에서 렌더 직전 `clear(lastHour)` 주입을 100회 반복해 삭제된 섹션 재등장 0건. G11: `tests/comprehension/providers.test.ts`에서 `allowEvidence=false`일 때 가짜 서버 요청 0건.
- G7: 최초 MiniMax M3 직접 호출 10종에서 1건 계약 실패(저장 없음), 다음 관측에서 `chatml` 1건의 본문에 `PWNED`가 들어와 게이트가 실패했다. RED 테스트를 추가하고 모델 대상 명령 줄을 입력에서 무력화했다. 최종 `bun run scripts/gates/g7-injection.ts`는 합성 페이지 10종 모두 `done`, title·body의 `PWNED` 0건, 인용 ID가 briefing ID의 부분집합으로 종료 코드 0이었다. 해당 스크립트는 Aside credential 파일을 읽기만 하고 키·프롬프트·응답 본문을 출력하지 않는다. 이 관측은 그 10종과 호출 시점의 MiniMax 응답에 한정된다.

## 자동 게이트

| 명령 | 결과 |
|---|---|
| `bun test` | 516 pass, 0 fail, 1 snapshot, 3,477 assertions, 40 files |
| `npx tsc --noEmit` | exit 0 |
| `npx biome check .` | 111 files, 오류 0 |
| `swift test --package-path apps/side-mac` | 118 tests, 0 failures |
| `git diff --check` | exit 0 |
| `bun run scripts/gates/g7-injection.ts` | MiniMax M3 직접 호출 10/10 검증 성공, exit 0 |

## 미결과 증거 경계

- `P2-V` 마지막 항목의 G3·G11 자동 부분은 통과했지만, 실제 Side.app으로 1시간 캡처 후 실제 provider 요약을 확인하는 단계는 남았다. P1의 Keychain 앱 시작·TCC·30분 G1/G2도 실기기 단계로 남아 있어 P2-V 전체 체크박스는 미체크다.
- G7 입력 줄 무력화는 모델에게 지시하는 형태로 판별된 줄을 생략한다. 실제 문서가 그런 문구를 인용해도 그 줄은 요약 입력에서 빠질 수 있다. 프롬프트 인젝션 전반에 대한 완전한 차단 증거로 해석하지 않는다.
- `settings.providers` 기본값과 provider별 `allowEvidence` 기본값은 비어 있음/false다. 화면에서 사용자가 provider와 반출 허용을 설정하기 전에는 실제 활동 briefing을 전송하지 않는다.
- 요약이 성공한 뒤 day page 인덱스 동기화는 P3-T3.3의 범위다. `clear all`의 Keychain 키 회전 end-to-end도 승인된 helper 명령 경로가 연결될 때까지 미검증이다.
