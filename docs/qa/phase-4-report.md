# Phase 4 — GUI integration status (open)

기준: 2026-09-24. 이 보고서는 Phase 4의 현재 증거를 모은 것이며 완료 판정은 아니다. `docs/planning/06-tasks.md`의 미체크 항목은 그대로 둔다.

## 완료한 범위

- 설정 화면과 Day view의 계약, 인증, 이동, 입력 정규화와 XSS 시나리오는 [직접 TCP E2E](p4-direct-tcp-e2e.md) 및 각 화면 테스트로 확인했다. P4-S1과 P4-S2 항목은 작업표에서 완료 처리됐다.
- SwiftUI 메뉴바, 설정 창, 온보딩의 소스와 상태 모델을 구현했다. 온보딩은 작은 창 크기를 640×470으로 수정했고, 창을 닫아도 같은 프로세스에서 다시 열 수 있게 했다. 설정과 네이티브 UI에 한국어/English 선택을 추가했다.
- History의 빈 상태 카드 크기와 간격을 맞췄다. 웹 화면의 데스크톱·모바일 시각 확인과 자동 테스트 증거는 해당 작업 커밋에 있다.

## 최근 자동 검증

- `bun test`: 794 pass, 0 fail, 1 snapshot, 5,139 assertions, 78 files.
- `bun run check`: TypeScript 통과, Biome 208 files, no fixes.
- `swift test --package-path apps/side-mac`: 168 SideCaptureKit + 23 SideApp 테스트 통과. 앞선 실행에서 `SupervisorTests.testQuitForcesDaemonAfterFiveSecondsWhenTermIgnored`의 합성 데몬 출력 파일을 1초 안에 찾지 못하는 간헐 실패가 있었다. 해당 테스트의 파일 대기만 5초로 늘린 뒤 전체 스위트가 통과했다. 최초 지연의 근본 원인은 확정하지 않았다.
- `bun run build`, `bun run scripts/gates/p5-bundle-smoke.ts`, 서명 사전검사, `codesign --verify --deep --strict`: 종료 코드 0. 번들 웹, SQLite vec0, MiniLM 로딩을 확인했다.
- Astra high 리뷰가 Claude Code 실행 파일 탐색과 제공자 테스트 RPC 제한 시간 결함을 재현했다. 각각 `0b7f405`, `3d0cd56`으로 수정했다. 후속 Astra high 리뷰에서 데몬의 `USER`/`LOGNAME` 누락과 두 요약 호출이 슬롯을 점유할 때의 테스트 대기를 재현했다. 각각 `2dfcc14`, `90f0491`으로 수정했고 합성 회귀 테스트를 통과했다.
- 그 재검토에서 대기 중 provider URL·Keychain 키가 교체되면 새 키가 이전 URL로 전송되는 결함을 발견했다. `b3f5413`은 슬롯 획득 뒤와 비동기 키 조회 뒤에 제공자·모델의 현재 설정을 다시 확인하고, 모델 목록 조회에도 같은 검사를 추가했다. 두 로컬 서버를 이용한 회귀 테스트 4개가 수정 전 실패하고 수정 뒤 통과했다.
- 다음 Astra high 재검토에서 중복 provider ID를 두 URL에 등록하면 키 참조가 섞이는 경로를 재현했다. `f1d30b1`은 설정과 패치의 중복 ID를 거부하고 provider RPC의 모호한 조회를 차단했다. `c898980`은 URL별 안정적인 Keychain 참조를 사용해 다른 URL로의 키 덮어쓰기와 같은 URL의 키 교체 때 생기는 불필요한 항목 증가를 막았다. `589c7ec`은 기존 통합 테스트의 정확한 참조 검증을 새 형식으로 맞췄다. 최종 Astra high 재검토는 소스와 공개용 페이지를 **SHIP**으로 판정했다. 실기기·배포 게이트는 여전히 열려 있다.
- 최신 `bun run scripts/gates/run-all.ts`는 종료 코드 2, 상태 `BLOCKED`였다. G0와 G3–G6, G7b–G11의 모든 하위 명령은 종료 코드 0으로 통과했고 G1/G2와 러너 범위의 G7은 증거 범위상 차단됐다.

이 결과는 소스와 합성 환경의 증거다. 새로 빌드된 `Side.app`의 실제 온보딩 화면, 메뉴바 이동, TCC 권한, 잠금/재시작 뒤 동작을 대신하지 않는다.

## 미결

- P4-S3-T1/T2/V: 실제 새 빌드에서 메뉴 상태 5종, Settings/Today 이동, WKWebView 토큰 URL 비노출을 수동 확인해야 한다.
- P4-S4-T2/V: 새 macOS 계정 또는 TCC 초기화 상태에서 권한 안내와 재시작 복귀를 기록해야 한다. 사용자가 실기기 장시간 검증을 맡기로 했다.
- 현재 `/Applications/Side.app`은 이전 빌드이고 실행 중이지 않다. 새 빌드를 교체했을 때 권한 요청이 다시 뜬 원인과 복원 기록은 [TCC 진단](local-tcc-signature-2026-09-24.md)에 있다. 새 빌드의 물리 검증을 마치기 전에는 이 차이를 완료로 표시하지 않는다.

실제 사용자 캡처 본문, Aside ledger 행, API 키는 이 보고서에 사용하지 않았다.
