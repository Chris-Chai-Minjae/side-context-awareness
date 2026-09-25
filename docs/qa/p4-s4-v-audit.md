# P4-S4-V 온보딩 연결점 감사

- 확인일: 2026-09-24
- 범위: `specs/screens/onboarding.yaml`, `docs/planning/06-tasks.md`의 P4-S4-V, Swift 온보딩/메뉴바 연결, daemon RPC 계약과 관련 테스트
- 변경 경계: 이 보고서만 추가. 승인된 `docs/planning/` 및 `specs/`와 앱 코드는 수정하지 않았고, `06-tasks.md` 체크박스도 바꾸지 않았다.

## 판정

권한·설정 필드와 다섯 P4-S4-V endpoint는 Swift source에서 daemon RPC handler까지 연결되어 있으며, 관련 Swift/Bun 테스트가 통과했다. Finish 이후의 `enabled=true` 저장, 온보딩 창 닫기, 메뉴 상태 조회·표시는 source와 분리된 unit 테스트에서 확인했지만, 실제 Side 앱에서 연결된 흐름은 관찰하지 않았다. 따라서 이 결과는 source/unit/handler-contract 증거이며, native TCC 권한 전환 및 실제 앱의 `finish → 메뉴바 Capturing` 수동 확인은 남아 있다.

## Field coverage

| 승인된 요구 | 연결 근거 | 판정 및 증거 한계 |
|---|---|---|
| `permissions`: `accessibility`, `input_monitoring`, `screen_recording` | 요구는 `specs/screens/onboarding.yaml:8-12`. Swift DTO가 세 값을 선언하고 `input_monitoring`, `screen_recording` 키를 명시적으로 decode한다 (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:3-12`). daemon 응답 schema는 이 세 값과 추가 `automation`을 포함한다 (`src/contracts/rpc-resources.ts:31-36`). | 필드 연결은 source 대조로 확인. `tests/api/status.test.ts:222-255`는 실제 handler의 출력 형태와 permission 요청 위임을 fixture로 검증한다. `tests/contracts/rpc.test.ts:53-69`의 화면 needs 자동 검사는 onboarding 화면을 목록에 넣지 않으므로 onboarding YAML 자체를 검사한 자동 증거는 아니다. |
| `settings`: `enabled`, `screen_ocr`, `providers` | 요구는 `specs/screens/onboarding.yaml:11-12`. Swift `SettingsResource`는 `enabled`, `screen_ocr`, `providers`를 decode하고 온보딩용 타입으로 옮긴다 (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:23-27,63-70`). daemon `SettingsResourceSchema`에도 세 필드가 있다 (`src/contracts/rpc-resources.ts:58-68`). | Source 대조와 RPC decode unit test 통과. `OnboardingRPCTests.testSettingsGetUsesUDSAndDecodesDaemonResource`는 `settings.get`의 synthetic UDS 응답을 decode한다 (`apps/side-mac/Tests/SideCaptureKitTests/OnboardingRPCTests.swift:111-129`). 실동작 daemon에서 얻은 응답은 아니다. |

## Endpoint 연결

| P4-S4-V endpoint | Swift 사용 | daemon/계약 연결 및 실행 증거 |
|---|---|---|
| `permissions` | `getPermissions()`가 `permissions`를 호출한다 (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:108-110`). 온보딩 진입/폴링/Enable 직전에 사용한다 (`apps/side-mac/Sources/Side/UI/Onboarding.swift:63-75,91-99,181-190`). | Handler가 helper의 `permissions` command를 호출하고 응답 필드를 매핑한다 (`src/api/resources/status.ts:92-100,139-145`). `tests/api/status.test.ts`의 “permissions and requestPermissions delegate…”가 출력 모양을 확인했다. |
| `requestPermissions` | 현재 권한 kind만 `kinds`로 요청한다 (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:112-114`, flow call site `apps/side-mac/Sources/Side/UI/Onboarding.swift:102-114`). | Bun RPC schema의 method/input이 등록되어 있다 (`src/contracts/rpc.ts:68-75`); status handler가 요청을 helper에 위임한다 (`src/api/resources/status.ts:146-157`). 위 Bun test가 kind 지정과 미지정 기본 목록을 확인했다. |
| `settings.patch` | Screen Recording skip은 `{screenOcr:false}` (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:116-119`); provider 목록 저장, summary model 선택/초기화, Enable은 각각 patch한다 (`apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:121-133,146-163`). | Patch schema는 대응 camelCase 필드를 받는다 (`src/contracts/settings.ts:70-82`). daemon handler는 patch를 merge·저장·reconcile한다 (`src/api/resources/settings.ts:91-102`). Swift skip/clear UDS tests와 Bun settings API tests가 통과했다. |
| `providers.setKey` | non-empty API key일 때만 저장된 provider 뒤에 key RPC를 호출한다 (`apps/side-mac/Sources/Side/UI/Onboarding.swift:160-168`; client `apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:135-140`). | Handler는 provider 존재/빈 값 검증 후 helper Keychain에 secret을 보내고 참조만 settings에 연결한다 (`src/api/resources/providers.ts:57-83`). `tests/api/providers.test.ts:94-218`의 key 저장·실패 케이스와 `tests/api/settings.test.ts:149-175`의 settings patch 비노출 테스트가 통과했다. |
| `providers.test` | provider 저장 및 선택적 key 저장 이후 테스트하고, `ok`일 때만 model 선택 patch를 보낸다 (`apps/side-mac/Sources/Side/UI/Onboarding.swift:164-175`; client `apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:142-144`). | Handler는 설정된 provider/model을 검사하고 probe 결과를 반환한다 (`src/api/resources/providers.ts:85-129`). Bun providers suite의 성공·미설정 model·오류 케이스가 통과했다. 테스트 provider는 synthetic local fixture다. |

추가로 앱 시작 시 `settings.get`과 `permissions`를 불러오는 연결은 `apps/side-mac/Sources/Side/UI/Onboarding.swift:63-77`에 있다. 전체 RPC handler 집합은 daemon에서 status/settings/provider handler를 조합한다 (`src/daemon/index.ts:553-579`); Unix socket `/rpc` 요청은 `src/api/server.ts:79-86,102-107`에서 공통 RPC dispatcher로 전달된다. `tests/contracts/rpc.test.ts:6-33`의 exact method set에는 P4-S4-V의 다섯 method가 있다.

## Finish → 메뉴바 상태

1. 화면 spec은 `finish_step`에서 Enable 후 시트를 닫고 메뉴 상태를 갱신하도록 하고, 연결 목적지를 `native://menubar`로 정한다 (`specs/screens/onboarding.yaml:37-45`). Finish 버튼은 `flow.enable()`을 호출한다 (`apps/side-mac/Sources/Side/UI/OnboardingView.swift:52-60`).
2. `enable()`은 최신 권한을 확인하고 `settings.patch({enabled:true})`를 기다린 뒤 완료 처리한다 (`apps/side-mac/Sources/Side/UI/Onboarding.swift:181-199`; client patch `apps/side-mac/Sources/Side/UI/OnboardingRPC.swift:160-163`). 완료 처리는 resume key와 permission sheet 상태를 정리하고 `onComplete`를 호출한다 (`apps/side-mac/Sources/Side/UI/Onboarding.swift:214-220`). Controller의 callback은 온보딩 창을 닫는다 (`apps/side-mac/Sources/Side/UI/OnboardingWindowController.swift:14-19,54-57`).
3. 앱은 별도 `MenuBarState`와 UDS menu service를 만들고 label task에서 status polling을 시작한다 (`apps/side-mac/Sources/Side/SideApp.swift:5-18`). 메뉴 열기 시 즉시 refresh하며 (`apps/side-mac/Sources/Side/UI/MenuBar.swift:181-207`), 평시 polling/cache 주기는 30초다 (`apps/side-mac/Sources/Side/UI/MenuBar.swift:108-110,125-151`). UDS 서비스는 `status` RPC를 읽는다 (`apps/side-mac/Sources/Side/UI/MenuBarRPC.swift:22-25`). enabled 상태에서 daemon status가 `running`이면 표시 문구는 `Capturing`이다 (`apps/side-mac/Sources/Side/UI/MenuBar.swift:43-75,181-189`).

**Unit 증거:** `OnboardingFlowTests.testProviderSkipThenEnableStartsCaptureWithoutModel`은 fake service에 `clearModel`, `enabled:true` 순서가 기록되고 flow 완료 callback이 호출되는 것을 확인한다 (`apps/side-mac/Tests/SideCaptureKitTests/OnboardingFlowTests.swift:159-179`). `MenuStateTests.testFiveStatusStringsAndThreeIconsWhenCaptureStateChanges`는 주어진 `running` 응답의 표시가 `Capturing`임을 확인하고, `testThirtySecondCacheAndMenuOpenForcesStatusRefresh`는 주기 및 메뉴 열기 refresh를 확인한다 (`apps/side-mac/Tests/SideAppTests/MenuStateTests.swift:34-78`). daemon reconciler의 fake-helper 테스트는 권한 health가 충족되면 state가 `running`, scheduler가 시작됨을 확인한다 (`tests/daemon/reconcile.test.ts:84-114`).

이 테스트들은 각각 fake service/helper 및 입력된 status를 사용한다. 온보딩 completion이 메뉴 state를 직접 refresh하도록 연결하지는 않으며, source상 표시 갱신은 다음 polling 또는 메뉴 열기 때 일어난다. 실제 앱에서 Enable 뒤 daemon status가 running으로 전환되고 메뉴 표시까지 반영되는 cross-component 연결은 아직 관찰되지 않았다.

## 실행한 확인

```text
swift test --package-path apps/side-mac --filter OnboardingFlowTests
Executed 13 tests, 0 failures.

swift test --package-path apps/side-mac --filter 'OnboardingRPCTests|MenuStateTests'
OnboardingRPCTests: 3 passed; MenuStateTests: 6 passed; 0 failures.

bun test tests/contracts/rpc.test.ts tests/api/status.test.ts tests/api/settings.test.ts tests/api/providers.test.ts
24 pass, 0 fail, 255 expect() calls across 4 files.

bun test tests/daemon/reconcile.test.ts --test-name-pattern='Given enabled settings and missing permissions'
1 pass, 0 fail; 30 filtered out; 5 expect() calls.
```

Swift flow/RPC/menu 테스트는 unit 또는 local synthetic UDS test다. Bun API/contract 테스트는 fixture 기반이고 reconcile 테스트는 fake helper를 사용한다. 실제 Side.app launch, 실제 daemon socket/helper 통신, 실제 provider credential, native 권한 변경은 이번 감사에서 수행하지 않았다.

## 남은 native/manual 관찰

`specs/screens/onboarding.yaml:20-28,47-56`에 적힌 실제 System Settings 이동, Accessibility 부여 후 2초 내 자동 진행, Screen Recording 부여로 인한 앱 재시작 뒤 provider 단계 resume, provider skip 후 capture 시작/summary pending 동작은 native macOS 환경에서 확인해야 한다. 계획상 `P4-S4-T2`는 새 macOS 계정 또는 `tccutil reset` 후 수동 실행 및 화면 녹화 증거가 요구되고 아직 `[ ]`다 (`docs/planning/06-tasks.md:530-532`); handoff도 TCC 권한 부여를 실기기 수동 단계로 지정한다 (`docs/HANDOFF-codex.md:27-31`). 이번 작업에서는 TCC 권한이나 시스템 설정을 변경하지 않았고, 화면 녹화도 만들지 않았다.

`P4-S4-V`의 체크박스는 `docs/planning/06-tasks.md:534-538`에서 계속 `[ ]` 상태로 두었다. 실제 앱에서 권한 단계, restart/resume, provider skip, Enable 뒤 메뉴바 running 표시를 수동으로 관찰하고 증거를 첨부하기 전에는 해당 runtime 수용 기준 완료로 판정하지 않는다.

## 통합 후 연결점 추가 확인

코디네이터의 후속 `bun test tests/e2e/settings.spec.ts`에서 실제 daemon UDS에 등록된 16개 Settings RPC를 호출해, 각 메서드가 잘못된 입력에 `-32602`를 반환하고 미등록 대조 메서드가 `-32601`을 반환함을 확인했다(6 pass, 0 fail, 52 assertions). 이 16개에는 온보딩 연결점의 `permissions`, `requestPermissions`, `settings.patch`, `providers.setKey`, `providers.test`가 모두 포함된다. 따라서 P4-S4-V의 Endpoint 세부 게이트를 체크했다. 실제 온보딩 앱 흐름과 TCC 수동 관찰은 여전히 미검증이며 상위 P4-S4-V는 열어 둔다.
