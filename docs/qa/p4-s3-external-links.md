# P4-S3 Day view 외부 링크 연결점

## 구현

`SettingsWindowController`가 `WKNavigationDelegate`와 `WKUIDelegate`를 연결한다. `http://127.0.0.1:<session port>`의 내부 hash 링크는 현재 WKWebView에서 열고, `target=_blank`인 내부 링크도 새 창 대신 인증 헤더를 붙여 현재 뷰에 로드한다. 사용자 클릭으로 시작한 다른 origin의 `http`/`https` 링크는 `NSWorkspace.open`에 넘기고 WebKit 탐색을 취소한다. 비 HTTP(S) URL과 사용자 클릭이 아닌 외부 탐색은 취소하며, `target=_blank`에도 같은 분류를 적용한다. 테스트는 URL 분류만 실행하며 외부 네트워크를 호출하지 않는다.

## 검증

- RED: `swift test --package-path apps/side-mac --filter SettingsNavigationTests` → exit 1, `cannot find 'SettingsNavigationPolicy' in scope`.
- GREEN: 같은 명령 → exit 0, `Executed 4 tests, with 0 failures` (내부 hash, 외부 HTTPS, `target=_blank`, 위험 scheme·자동 외부 탐색).
- `bun test` → exit 0, `669 pass`, `0 fail`, `Ran 669 tests across 65 files. [10.06s]`.
- `npx tsc --noEmit` → exit 0, 출력 없음.
- `npx biome check .` → exit 0, `Checked 175 files in 102ms. No fixes applied.`
- `swift test --package-path apps/side-mac` → exit 0, SideCaptureKitTests `Executed 136 tests, with 0 failures`; SideAppTests `Executed 10 tests, with 0 failures`.

## 남은 수동 확인

현재 앱에는 데몬의 `{port, token}`을 `SettingsWindowController.accept(session:)`으로 전달하는 경로가 없고, 웹 앱은 URL 쿼리에서만 토큰을 읽는다(`docs/qa/p4-s3-t1-menubar.md`). 따라서 실제 WKWebView 인증과 Day view 클릭으로 기본 브라우저가 열리는 동작은 아직 관측하지 못했다. 승인된 토큰 경로가 연결되면 같은 origin hash 이동, 외부 `http`/`https` 일반 링크와 `target=_blank`, 비 HTTP(S) 링크 취소를 실제 앱에서 확인해야 한다. `docs/planning/06-tasks.md`의 P4-S3-T1 체크박스는 그대로 열려 있다.
