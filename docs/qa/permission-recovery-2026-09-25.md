# Side permission and summary recovery / 권한 및 요약 복구

Date: 2026-09-25. This note records user-requested improvements without changing the approved `docs/planning/` or `specs/` baseline. It does not mark an unfinished Phase 5 gate complete.

날짜: 2026-09-25. 이 문서는 사용자가 요청한 개선을 기록합니다. 승인된 `docs/planning/`과 `specs/` 정본은 수정하지 않았으며, 미완료 Phase 5 게이트를 완료로 표시하지 않습니다.

## Scope and contract addendum / 범위와 계약 추가

- The new Permissions page reads each macOS permission separately, shows capture/helper state apart from permission grants, and links to the matching System Settings pane. Provider rows show Keychain access and allow an explicit authorization request. Connection verification reads the provider model list without generating a summary.
- The page does not request Screen Recording while OCR is disabled, matching `03-capture.md` §8. It still links to the matching System Settings pane.
- The user requested recovery for empty daily summaries, garbled text, and the Aside Browser switch. `summaries.retryFailedToday` explicitly requeues at most six failed jobs with retained evidence and triggers one summary pass. The summary output contract rejects U+FFFD in any string. Aside adapter status now uses adapter health; the app resolves the user-installed Aside CLI path.
- These user-authorized additions extend the approved API table in `02-architecture.md` §4 without editing that immutable baseline: daemon RPCs `providers.keyStatus`, `providers.authorizeKey`, `summaries.retryFailedToday`; native helper commands `keychain.status` and `keychain.authorize`. They return booleans or counts only. No API key or captured text is returned.

- 새 권한 페이지는 macOS 권한별 상태와 캡처·헬퍼 상태를 구분하고 각 시스템 설정 항목으로 연결합니다. 제공자별 Keychain 상태와 명시적 허용 버튼을 표시하며, 연결 확인은 요약 생성 없이 모델 목록을 조회합니다.
- OCR이 꺼져 있으면 Screen Recording 요청 버튼을 비활성화합니다(`03-capture.md` §8). 해당 시스템 설정 링크는 계속 제공합니다.
- 사용자가 요청한 빈 일간 요약·깨진 글자·Aside Browser 스위치 문제를 다룹니다. `summaries.retryFailedToday`는 원본 증거가 남은 실패 작업을 한 번에 최대 6개 다시 대기시키고 요약 실행을 요청합니다. 요약 계약은 모든 문자열의 U+FFFD를 거부합니다. Aside 상태는 실제 어댑터 상태를 반영하고 사용자 설치 경로의 Aside CLI를 찾습니다.
- 사용자 요청으로 승인 정본의 API 표에 없는 메서드가 추가됐습니다. 위 RPC 세 개와 native helper 명령 두 개는 상태 boolean 또는 개수만 반환합니다. API 키와 캡처 원문은 반환하지 않습니다.

## Verification / 검증

- `bun test`: 841 passed, 0 failed after the Keychain status, Permissions UI, and Day view repairs.
- `bun run check`: TypeScript and Biome passed after the UI refinement.
- `swift test --package-path apps/side-mac`: 175 capture-kit tests and 24 app tests passed, 0 failed.
- `bun run build`, `bun scripts/gates/p5-bundle-smoke.ts`, and `codesign --verify --deep --strict`: passed for the local ad hoc signed app.
- Installed `/Applications/Side.app` launched with its main thread responsive. After the user approved the master-key Keychain prompt, the daemon started. A live `permissions` RPC then reported Accessibility and Input Monitoring granted, Screen Recording not granted. A live `status` RPC reported capture running with a partial-permissions banner. Today's day page existed, with two completed summaries and one failed job.
- The first installed build exposed a defect: `providers.keyStatus` timed out after 10 seconds. A native stack sample showed the legacy file-based Keychain shim blocking inside `SecItemCopyMatching` even with noninteractive flags. The revised daemon now answers that RPC immediately with `stored:null, accessible:null` until explicit authorization; the Permissions page no longer reads Keychain on load.
- After replacing the app and re-adding its macOS privacy grants, live `permissions` reported Accessibility, Input Monitoring, and Screen Recording all granted. Live `status` reported capture running with no permission banner. An explicit MiMo Keychain authorization request showed the macOS SecurityAgent dialog but received no approval response before the 120-second request deadline. This describes that test point; later summary and Aside evidence follows below.
- The follow-up UI repair disables already-granted permission requests, identifies observer-registration and other partial-capture failures separately from privacy grants, and clears stale Keychain access status after a failed key read, including the background summary path. The Day view has an explicit refresh action. Final local bundle smoke and code-signature checks passed; an Astra high read-only source review found no P0/P1/P2 issue after the last race repair.
- One previously failed 10-minute summary was explicitly requeued through `summaries.retryFailedToday` and completed with MiMo 2.6 Pro. Live status then showed five completed summaries and zero failed for today. The Day view now offers a manual Refresh summaries action after asynchronous completion; the refresh itself makes no model call.
- Before the final app replacement, live `status` reported `asideAdapter: available`, and an aggregate source count found an `aside_dom` event without opening captured content. The prior installed daemon later disappeared around 04:10 JST while the GUI remained; no exit code or incident log was available, so the cause is undetermined. A private SQLite backup passed `PRAGMA integrity_check`; exactly one U+FFFD summary with retained sources was requeued for regeneration. The final source build was installed in `/Applications/Side.app`, but its master-key read is currently waiting inside macOS `SecItemCopyMatching` with no visible authorization sheet. Capture and historical regeneration in this final installed build await macOS Keychain authorization.

- Keychain 상태·권한 화면·날짜 화면 수정 후 `bun test` 841개가 통과했습니다.
- 수정 후 `bun run check`가 통과했습니다. Swift 캡처 키트 테스트 175개와 앱 테스트 24개, 로컬 빌드, 번들 검사, 코드 서명 검증도 통과했습니다.
- 사용자가 Keychain 마스터 키 접근을 승인한 뒤 데몬이 시작됐습니다. 실제 권한 조회에서 손쉬운 사용·입력 모니터링은 허용, 화면 기록은 미허용으로 나왔고 캡처는 실행 중입니다. 오늘 날짜 페이지에는 완료 요약 2건과 실패 작업 1건이 있습니다.
- 첫 설치 빌드의 `providers.keyStatus`는 10초 뒤 시간 초과했습니다. macOS의 기존 파일 기반 Keychain 경로가 비대화형 옵션을 지정해도 내부에서 멈춘 것이 native stack으로 확인됐습니다. 수정 빌드에서는 자동 Keychain 조회를 없앴고 이 RPC가 즉시 미확인 상태를 반환합니다.
- 앱 교체와 권한 재추가 후 손쉬운 사용·입력 모니터링·화면 기록이 모두 허용으로 나왔고 캡처는 경고 없이 실행 중이었습니다. MiMo 키의 명시적 허용 요청에서 macOS 창이 떴으나 120초 내 승인 응답이 없어 시간 초과됐습니다. 이 문장은 그 시점의 시험 결과이며, 이후 확인한 요약·Aside 증거는 아래에 기록합니다.
- 추가 UI 수정으로 이미 허용된 권한 요청 버튼은 비활성화하고, 관찰자 등록 등 부분 캡처 오류를 macOS 권한과 구분하며, 백그라운드 요약을 포함한 키 읽기 실패 시 이전 Keychain 허용 표시를 없앴습니다. 날짜 화면에는 명시적 새로고침을 넣었습니다. 최종 번들 검사·코드 서명 검증이 통과했고, Astra high 읽기 전용 리뷰에서 P0~P2 문제를 찾지 못했습니다.
- 이전에 실패한 10분 요약 1건은 `summaries.retryFailedToday`로 명시적으로 재대기시킨 뒤 MiMo 2.6 Pro에서 완료됐습니다. 이후 오늘 요약은 완료 5건, 실패 0건이었습니다. 비동기 완료 후 기록 화면의 **요약 새로고침**을 누르면 결과를 다시 읽으며, 새로고침 자체는 모델을 호출하지 않습니다.
- 최종 앱 교체 전 `asideAdapter: available`과 `aside_dom` 출처 이벤트 1건을 내용 열람 없이 확인했습니다. 기존 설치 앱의 데몬은 04:10경 사라졌지만 종료 코드나 사고 로그가 없어 원인은 확정하지 못했습니다. 개인 SQLite 백업의 무결성 검사를 통과했고, 원본이 남은 U+FFFD 요약 1건을 재생성 대기열에 넣었습니다. 최종 소스 빌드는 `/Applications/Side.app`에 설치됐지만 마스터 키 조회가 macOS `SecItemCopyMatching` 내부에서 기다리고 있으며 허용 창은 보이지 않습니다. 최종 설치 빌드의 캡처와 해당 요약 재생성은 macOS Keychain 접근을 허용한 뒤 확인해야 합니다.

This is source-build evidence only. Hosted GitHub Actions and long-duration physical testing are separate gates.

이는 소스 빌드 검증입니다. GitHub Actions 실행과 장시간 실기기 테스트는 별도 게이트입니다.
