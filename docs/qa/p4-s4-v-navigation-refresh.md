# P4-S4-V: finish → MenuBar 상태 갱신

- 작업: `task_7e14433fae2e` (2026-09-24)
- 기준: `43bfd36`, `specs/screens/onboarding.yaml`의 `finish_step` → `native://menubar`

## 변경과 판정

`SideApp`과 `OnboardingWindowController`가 같은 `MenuBarState.shared`를 사용한다. 온보딩 Enable이 성공한 뒤 completion callback은 창을 닫고 `refresh(force: true)`를 한 번 호출한다. 따라서 기존 30초 캐시가 남아 있어도 daemon `status`를 즉시 다시 읽으며, 기존 `MenuBarState`의 실패 시 `Capture is not running` 표시와 정기 polling은 그대로 적용된다. 이미 enabled인 상태로 시작해 온보딩을 표시하지 않는 경로와 Enable 실패 경로는 추가 status 조회를 하지 않는다.

## TDD와 자동 검사

| 단계 | 명령 | 결과 |
|---|---|---|
| RED | `swift test --package-path apps/side-mac --filter 'OnboardingFlowTests.testEnableRefreshesCachedMenuImmediatelyAfterSuccess\|OnboardingFlowTests.testEnableFailureDoesNotRefreshMenu\|OnboardingFlowTests.testAlreadyEnabledStartupDoesNotRefreshMenuFromOnboarding'` | `OnboardingWindowController.makeFlow` 부재로 컴파일 실패 |
| GREEN | 같은 명령 | 3 tests, 0 failures |
| Swift 전체 | `swift test --package-path apps/side-mac` | SideCaptureKitTests 139 + SideAppTests 10 = 149 tests, 0 failures |
| Bun 전체 | `bun test` | 697 pass, 0 fail; synthetic fixture/helper 경로 |
| 타입 | `npx tsc --noEmit` | exit 0 |
| 형식 | `npx biome check .` | 185 files checked, no fixes |
| 차이 | `git diff --check` | exit 0 |

새 Swift 테스트는 fake `OnboardingService` 구현의 `setEnabled` 성공/실패와 fake `MenuBarServicing`의 조회 횟수 및 `Capturing` 표시를 확인한다. 성공 테스트는 사전 조회로 채운 캐시가 유효한 상태에서 강제 재조회를 확인한다. 기존 `MenuStateTests`의 30초 캐시/메뉴 열기/daemon 실패 테스트도 Swift 전체 검사에 포함됐다.

## 남은 증거

이 결과는 Swift fake-service 연결과 synthetic 검사 증거다. 실제 macOS TCC 권한 부여, Screen Recording 재시작/복원, 실제 Side.app에서 Enable 후 daemon이 `running`을 반환하는 시점과 메뉴바 표시를 수동으로 관찰하지 않았다. `P4-S4-V` 부모 체크박스와 승인된 planning/spec 문서는 변경하지 않았다.
