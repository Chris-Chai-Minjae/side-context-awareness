# Phase 1 — M1 관찰 → ledger (진행 중)

기준: 2026-09-24, `phase-1-engine`에 macOS helper와 Bun daemon을 통합한 상태. `P1-V`의 물리 Mac 30분 사용과 TCC 권한 검증은 아직 완료하지 않았다.

## 구현과 자동 게이트

- P1-T1.1~T1.20의 코드와 단위 수용 검사를 구현했다. 앱은 Swift observer/AX/Vision/브라우저 URL·시크릿 게이트, Keychain·helper 프로토콜을 담당한다. Bun daemon은 reconcile, 스케줄링, 저장 전 마스킹, 암호화 ledger, frame·GC를 담당한다.
- `tests/integration/phase1.test.ts`: 합성 Chrome·편집기·secure input·denylist 흐름에서 ledger 이벤트 3건, URL suppression 1건, 차단 앱 출력 0건과 합성 비밀 원문 무잔존을 확인했다. 이 검사는 실제 TCC 또는 30분 사용을 증명하지 않는다.
- `bun test`: **402 pass, 0 fail** (31 files, 2,735 assertions). G6 DDL 비교(`tests/ledger/schema.test.ts`), G8 보존(`tests/ledger/gc.test.ts`), G9 격리 DB 권한(`tests/daemon/reconcile.test.ts`)을 포함한다.
- `swift test --package-path apps/side-mac`: **118 tests, 0 failures**. `npx tsc --noEmit`: exit 0. `npx biome check .`: 88 files, 오류 0.
- `apps/side-mac/scripts/build-app.sh`: Swift release와 Bun 실행 파일 번들링 완료. macOS가 Bun 컴파일 산출물을 SIGKILL한 원인은 무효한 ad hoc 서명으로 확인했다(`codesign --verify` 실패 → 격리 복사본 재서명 후 `side help` 성공). 빌드 후 실행 파일·앱 번들을 재서명하고 `codesign --verify --deep --strict` 및 번들 내부 `side help`를 검사한다. 수정 후 모두 exit 0.
- `git diff --check`, `plutil -lint`, `bash -n apps/side-mac/scripts/build-app.sh`: 모두 exit 0.
- Aside 어댑터를 켠 합성 환경에서 `browser.url` 사전 확인이 시크릿·알 수 없는 상태·URL 전환 때 REPL 호출을 막음을 RED→GREEN으로 확인했다. AX observer 등록 실패는 health에 반영되고 복구 시 해제됨을 합성 테스트로 확인했다. Keychain 읽기 실패가 데몬 spawn 이전에 일어날 때 메뉴에는 기존 `Capture is not running` 문구가 표시된다.

## 미결 및 실기기 게이트

- `P1-V`의 **G1**은 실제 Mac에서 30분 활동 후 `scripts/gates/g1-canary.ts`로 Side 데이터 루트를 스캔해야 한다. 테스트에는 합성 카나리아만 사용했다.
- **G2**는 차단 앱·도메인에서 실제 10분 사용하여 이벤트 0건과 suppression 증가를 확인해야 한다. 합성 URL 흐름은 통과했다.
- 합성 Keychain interposer에서는 Side.app의 `applicationDidFinishLaunching`에서 데몬이 실행되고 격리 ledger 파일이 생성됐다. 실제 Keychain 항목을 쓰는 `open -n --env SIDE_DATA_DIR=…` 실행에서는 GUI 프로세스가 살아 있어도 3초 후 격리 루트가 비어 있고 데몬 자식이 없었다. 기존 Keychain 항목 메타데이터는 있으나 암호 값이나 실제 OSStatus는 읽지 않았다. Keychain 권한 문제가 유력하며 사용자의 macOS 팝업 확인을 요청했다. 실제 캡처 성공으로 판정하지 않는다.
- 같은 점검 시점의 `ioreg -n Root -d1 -l`에서는 GUI 세션 `CGSSessionScreenIsLocked=Yes`였다. `WhenUnlockedThisDeviceOnly` Keychain 접근을 막았을 가능성이 있지만, 실제 OSStatus를 확인하지 못해 원인으로 확정하지 않는다. 화면 잠금 해제 후 앱을 다시 실행하여 Keychain·TCC 상태를 재확인해야 한다.
- 현재 기본 설정은 `enabled=false`이고 기능을 켜는 제품 UI는 Phase 4 태스크다. 30분 G1/G2 물리 검증은 앱 시작 문제와 활성화 경로가 풀려야 진행할 수 있다.
- Accessibility, Input Monitoring, Screen Recording, Automation 및 필요시 Keychain 허가는 실제 앱의 서명·권한 UI에서 사용자 수동 단계가 필요하다. 권한 게이트가 준비되면 사용자에게 요청한다.
- `clear('all')`의 key rotation은 ledger `rotateKey` 콜백과 Swift `rotateMasterKeyAfterClearAll`에 존재한다. 현재 승인된 App↔daemon command 목록에는 이를 호출할 명령이 없으므로 P4 로컬 API 연결 시까지 end-to-end 동작은 미검증이다. 정본 명세는 변경하지 않았다.
- Aside DOM 어댑터는 S-1 판정에 따라 기본 off이며 실제 `aside repl` 성공 응답을 읽지 않았다. Safari 비공개 창 차단은 S-4에서 승인된 한계다.

## 다음 단계

앱 시작 경로를 해결하고, Phase 1 물리 게이트를 완료한 뒤 `P1-V`와 이 보고서를 최종 갱신한다. 독립적인 Phase 2 queue·injection 작업은 명세 의존성에 따라 진행한다.
