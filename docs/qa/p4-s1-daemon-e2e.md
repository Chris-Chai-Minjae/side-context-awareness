# P4-S1-T2 Settings daemon E2E

2026-09-24, macOS arm64, Bun 1.3.5.

## 검증 경로

`tests/e2e/settings.spec.ts`의 기존 Playwright 5개 시나리오는 각각 임시 `SIDE` 데이터 디렉터리와 `runDaemon()`을 시작한다. `tests/e2e/settings-daemon-fixture.ts`는 합성 `settings.json`을 먼저 저장하여 사용자 설정 또는 Aside ledger를 읽지 않고, 합성 `hello` master key 및 health/result JSON-lines를 fake helper로 전달한다. 브라우저는 별도 인증된 테스트 web server에 접속하고, 그 서버의 얇은 RPC relay가 daemon의 실제 UDS `run/daemon.sock`에 전달한다. 따라서 상태, 권한, 설정, provider key, history, applications 및 MCP usage 응답은 daemon에 등록된 Resource handler에서 나온다.

기존 5개 UI 주장에 더해 daemon UDS의 `settings.get`과 `permissions`, 실제 `settings.json`의 enabled 및 provider Keychain reference 반영을 확인했다. Provider key 시험은 합성 문자열만 사용한다. Fake helper는 `keychain.set`의 reference와 합성 키 일치 여부만 기록하며 키 원문은 호출 기록이나 보고서에 저장하지 않는다. `settings.get` HTTP 응답과 설정 파일에 합성 키 원문이 없고 `has_key=true`임을 확인한다. Input Monitoring 거부 상태에서는 daemon의 자동 권한 요청이 권한을 부여하지 않으며, UI의 Allow 클릭 직전에 fake OS grant를 활성화한다.

## RED → GREEN 및 게이트

- RED: `bun test tests/e2e/settings.spec.ts` → exit 1, 0 pass / 5 fail. 기존 fixture에 daemon 호출 경로가 없음을 요구하는 임시 assertion이 각 시나리오에서 실패했다.
- GREEN: `bun test tests/e2e/settings.spec.ts` → exit 0, 5 pass / 0 fail / 34 assertions.
- `bun test` → exit 0, 696 pass / 0 fail, 68 files, 1 snapshot, 4317 assertions. 별도 native/key stub 없이 통과했다.
- `npx tsc --noEmit` → exit 0, 출력 없음.
- `npx biome check .` → exit 0, 184 files checked, no fixes applied.
- `swift test --package-path apps/side-mac` → exit 0, SideCaptureKitTests 136 / SideAppTests 10, 모두 0 failures.
- `git diff --check` → exit 0.

## 남은 계약 경계

브라우저 E2E는 테스트 relay가 가진 bearer token을 첫 요청에 넣고, 현재 웹 클라이언트의 `?t=` 소비 경로를 사용한다. 실제 Side.app `WKWebView`에 daemon의 원문 token과 port를 전달하는 경로는 아직 구현·검증되지 않았다. `run/web.json`에는 token hash만 있고, Swift의 `SettingsWebSession` 소비 경로와 웹 클라이언트 인증 방식은 연결되지 않았다. 이 테스트는 실제 Side.app 시작, TCC 승인, WKWebView 인증 또는 native Keychain을 입증하지 않는다. 관련 계약 간극은 `docs/qa/p4-s3-t1-menubar.md`에 별도로 기록되어 있으며, 승인된 `docs/planning/` 및 `specs/`는 변경하지 않았다.
