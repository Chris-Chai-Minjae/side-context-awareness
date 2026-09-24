# P4-S3-T1 SwiftUI 메뉴바 부분 구현

## 구현 범위

- `MenuBarExtra`에 상태 문구 5종, 상태 아이콘 3종, Pause 4개 선택지, 조건부 Resume, Today's summary…, Settings…, Quit Side를 연결했다.
- 메뉴가 열릴 때 `status`를 즉시 다시 읽고, 메뉴바 라벨의 폴링과 30초 캐시를 적용했다. Pause/Resume은 기존 UDS JSON-RPC를 호출한 뒤 상태를 다시 읽는다.
- Quit은 데몬에 SIGTERM을 보내고 최대 5초 기다린 뒤 살아 있으면 SIGKILL을 보낸 다음 앱을 종료한다.
- `SettingsWindowController`는 메모리의 `SettingsWebSession(port, token)`을 받을 수 있다. 인증 토큰은 URL 대신 첫 HTML 요청의 Authorization 헤더에 둔다. 세션이 없는 현재 경로에서는 인증되지 않은 페이지를 띄우지 않고 안내 창을 표시한다.

## 미결: 실제 WKWebView 세션 경로

P4-S3-T1은 **미완료**이며 `docs/planning/06-tasks.md` 체크박스는 그대로 둔다. 데몬의 `startApiServer`는 원문 토큰을 메모리에서 반환하지만 `run/web.json`에는 `port`와 `tokenHash`만 기록한다(`src/api/server.ts:81`, `src/api/server.ts:113`). 현재 `settings.open` helper 명령은 인자가 없고 Swift 라우터도 `null` 결과를 반환한다(`src/contracts/protocol.ts:125`, `apps/side-mac/Sources/Side/App/CommandRouter.swift:333-335`); 이 저장소에는 `{port, token}`을 앱의 `accept(session:)`으로 전달하는 구현이 없다. 웹 앱의 `readInjectedToken`은 URL의 `t` 쿼리에서만 토큰을 읽는다(`src/web/rpc-client.tsx:16-24`), 따라서 native 요청 헤더만으로는 이후 `/rpc` 호출을 인증할 수 없다. URL 쿼리에 토큰을 넣으면 P4-S3-V의 "토큰이 URL 기록에 남지 않음" 수용 기준을 증명할 수 없다. 승인된 세션 전달 계약과 메모리 토큰 소비 경로가 연결된 뒤 WKWebView 인증·라우팅 및 실제 메뉴 렌더를 검증해야 한다.

## 검증 기록

- RED: `swift test --package-path apps/side-mac --filter MenuStateTests` → exit 1, `cannot find type 'MenuBarServicing' in scope` 등 새 메뉴 타입 부재로 실패.
- GREEN: `swift test --package-path apps/side-mac --filter MenuStateTests` → `Executed 6 tests, with 0 failures`.
- `swift test --package-path apps/side-mac --filter SupervisorTests.testQuit` → `Executed 2 tests, with 0 failures`. SIGTERM 무시 데몬 강제 종료 테스트는 5초 경과를 확인했다.
- `bun install --frozen-lockfile` → exit 0, `153 packages installed [117.00ms]`. 초기 전체 게이트는 이 worktree에 `node_modules`가 없어 `playwright`/`preact`/`happy-dom`을 찾지 못했고, 설치 후 재실행했다.
- `bun test` → exit 0, `669 pass`, `0 fail`, `Ran 669 tests across 65 files. [9.57s]`.
- `npx tsc --noEmit` → exit 0, 출력 없음.
- `npx biome check .` → exit 0, `Checked 175 files in 141ms. No fixes applied.`
- `swift test --package-path apps/side-mac` → exit 0, SideCaptureKitTests `Executed 136 tests, with 0 failures`; SideAppTests `Executed 6 tests, with 0 failures`.

SwiftUI 메뉴 렌더와 실제 WKWebView 인증은 이 작업에서 수동 실행으로 입증하지 않았다.
