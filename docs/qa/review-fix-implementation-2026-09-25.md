# 2026-09-25 리뷰 수정 구현 검증

대상: `review-fix-spec-2026-09-25.md` F1–F14. MIT 소스 배포 범위이며 서명·공증·사전 빌드 앱 배포와 실기기·clean Mac·TCC·장시간 검증은 사용자 결정에 따라 범위 밖이다. 실제 사용자 ledger, Keychain 값, 인증 파일은 읽지 않았다.

| 항목 | 구현 및 확인 |
|---|---|
| F1 | `api-key`, `bearer-token`, 한국 주민등록번호 형태, 영문·한국어 라벨 규칙을 확장했다. 합성 영문·한국어 코퍼스와 G1 canary 테스트가 통과했다. |
| F2 | `side doctor`는 선택한 CLI 요약 provider를 Keychain 키 없이 검사하고, 키 없는 미선택 provider는 SKIP, 실패한 미선택 provider는 WARN으로 분리한다. 합성 doctor 테스트가 통과했다. |
| F3 | 저장된 이벤트의 mask 수를 `suppressions`에 넣던 오류를 고쳤다. denylist와 Secure Input에서 실제 폐기된 이벤트가 들어오면 suppression을 1건 기록한다. 과거 오염된 카운터는 마이그레이션하지 않으며 보관 기간이 지나면 삭제된다. 네이티브 helper가 이벤트를 보내기 전에 차단한 건수는 데몬에서 관찰할 수 없다. |
| F4 | Aside Browser ARIA 입력 행을 저장 전에 정리한다. Playwright의 인용형 YAML 키와 입력 하위 `option`·`text` 행도 제거한다. 민감 라벨은 `[redacted:field]`, 일반 입력값은 빈 이름만 남긴다. 필드 치환 건수는 masks에 합산한다. 접근 가능한 `snapshot` 입력값 제외 옵션을 확인하지 못해 어댑터의 후처리 경로를 사용한다. |
| F5 | 정본 JSON을 TS에서 import하고 Swift에는 같은 파일을 리소스로 복사했다. TS/Swift 동일성 테스트가 통과했다. 앱 빌드가 SwiftPM 리소스 bundle을 Side.app 안에 복사하며 누락 시 실패한다. 로컬 설치본에서 `com.apple.Passwords`, `com.apple.systempreferences`를 확인했다. Bitwarden `com.bitwarden.desktop`과 KeePassXC `org.keepassxc.keepassxc`는 각 프로젝트의 [이슈](https://github.com/bitwarden/clients/issues/13040)와 [CMake 정의](https://github.com/keepassxreboot/keepassxc/blob/develop/src/CMakeLists.txt)에서 확인했다. Dashlane, LastPass의 제안된 bundle ID와 `com.apple.systemsettings`는 확인되지 않아 목록에 넣지 않았다. |
| F6 | `history_read` prose에 검색 경로와 같은 인젝션 무력화를 적용했다. URL·ID는 그대로 두고, 이스케이프 뒤 JSON 응답 크기를 검사한다. 합성 위조 경계 및 Day view E2E가 통과했다. |
| F7 | Keychain 읽기 실패 시 메뉴 재시도와 화면 잠금 해제 알림 1회 재시도를 추가했다. 가짜 KeyStore와 메뉴 상태 테스트가 통과했다. 실제 macOS Keychain 승인 창은 이 소스 검증 범위에 포함되지 않는다. |
| F8 | RPC·helper·provider·권한 화면·Day view·메뉴 항목을 정본 문서에 반영했다. 계약 테스트는 아키텍처 API 표와 화면 index를 직접 읽어 코드와 비교한다. |
| F9 | 브라우저 방문기록 제목을 반환 전에 마스킹하고 인젝션을 무력화한다. 합성 SQLite History 테스트가 통과했다. |
| F10 | 사용하지 않는 v0.2 파일과 전용 테스트를 제거하고 URL 정규화를 `policy/url.ts`로 옮겼다. v1→v2 데이터 읽기 마이그레이션 테스트는 합성 v1 JSON으로 유지했다. 현행 MCP·typed 테스트도 유지했다. |
| F11 | 온보딩 소개 문구를 명세에 맞추고 메뉴 한국어를 웹 문구에 맞췄다. Swift 문자열 테스트가 통과했다. |
| F12 | 합성 Codex 실행 파일이 임시 `auth.json` symlink를 파일로 바꾸는 상황을 재현했다. 소유자·권한·JSON 검증 후 원본 위치로 atomic rename한다. 검증에 실패하면 임시 파일을 보존하고 오류를 반환한다. 실제 Codex 토큰 갱신은 실행하지 않았다. |
| F13 | RPC 송신자 주입과 가상 시계로 10초·11초·71초 경계를 검증한다. 실제 71초 대기는 제거했다. |
| F14 | 한영 README·상세 설명서에 빌드 사전 요구, 평문 파생본, `doctor` 상태를 명시했다. |

## 실행 증거

- `bun test`: 891 pass, 0 fail, 75 files.
- `bun run check`: TypeScript 및 Biome 통과, 201 files.
- `swift test --package-path apps/side-mac`: SideCaptureKit 183 pass, SideApp 28 pass.
- `bun run build`: Side.app와 웹 번들 생성 성공. Swift의 기존 `kSecUseAuthenticationUIFail` 사용에 대한 deprecated 경고가 있다.
- `git diff --check`: 통과.
- Astra high 독립 리뷰가 발견한 Playwright 인용형 입력 키·입력 하위 행 누출과 SwiftPM 리소스 앱 번들 누락을 수정했다. 실제 Playwright 형식의 합성 캡처 테스트와 빌드된 Side.app 내부 JSON 존재·정본 바이트 동일성 검사가 통과했다.
- 수정 후 Astra high 최종 재검토 판정: **A, MIT source-release APPROVED**, 추가 High/Medium 차단 문제 0건. 리뷰어는 실제 Playwright 형식의 합성 값 6개 제거, 앱 번들 JSON의 정본 SHA-256 동일성, 관련 Bun 321건·Swift 109건 및 정적 검사를 독립 확인했다.
- Gitleaks 현재 `src/`, `docs/`, Swift `Sources/`, 양쪽 README 스캔: 탐지 0건. Git 기록 스캔에서 탐지된 64건은 모두 합성 redaction/canary 테스트 파일의 패턴이다. `tests/`의 현재 스캔에서도 같은 유형의 합성 픽스처만 탐지됐다. 생성된 `.build`를 포함한 저장소 전체 디렉터리 스캔은 60초 제한으로 부분 완료됐으므로 판정에 사용하지 않았다.

이 결과는 소스·합성 테스트·로컬 빌드의 증거다. 권한 승인과 장시간 캡처가 실제 사용자 Mac에서 지속되는지까지 입증하지는 않는다.
