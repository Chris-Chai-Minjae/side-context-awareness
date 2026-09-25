# Phase 0 — M0 셋업·계약·Spike 검증

## 완료 태스크

- P0-T0.1: Git 저장소, Side 패키지와 스크립트, 목표 디렉터리 및 의존성을 준비했다. 첫 커밋 `520a61c`.
- P0-T0.2: 승인된 macOS 상수와 Side 설계 상수를 `src/constants.ts`에 분류해 구현하고 `tests/constants.test.ts`로 회귀 값을 검증했다. 커밋 `78ff9d3`.
- P0-T0.3: `SideCaptureKit` SwiftPM 라이브러리·테스트와 `MenuBarExtra` 실행 앱을 만들었다. 앱 실행 뒤 Accessibility 트리에서 `AXExtrasMenuBar` 항목 1개와 `Side` 라벨을 확인했다.
- P0-T0.4~T0.8: [S-1](spike-s1.md), [S-2](spike-s2.md), [S-3](spike-s3.md), [S-4](spike-s4.md), [S-5](spike-s5.md)의 측정과 판정을 `docs/planning/00-decisions.md` Spike 표에 기록했다. S-5 LAN 주소는 사용자 지정 `192.168.1.141:8500`으로 정본 태스크에 반영했다.
- P0-T0.9: settings v2, helper JSON-lines, 로컬 JSON-RPC 21개 메서드, `record_summary` 스키마와 fake helper/provider/clock을 계약 테스트로 구현했다. `resources.yaml`의 모든 필드가 출력 스키마에 존재하는지 자동 대조한다.

## 최종 게이트와 증거

| 명령·검사 | 결과 |
|---|---|
| `bun test` | 60 pass, 0 fail, 220 assertions, 19 files |
| `npx tsc --noEmit` | exit 0, 진단 0 |
| `npx biome check .` | 48 files, 오류 0 |
| `swift test --package-path apps/side-mac` | SideCaptureKit 1 test, failures 0 |
| `swift build --package-path apps/side-mac -c release` | exit 0 |
| `bun run build` | `dist/side-daemon` 컴파일과 Swift release 빌드 성공 |
| `swiftc -typecheck scripts/spikes/s{2,3,4}-*.swift` 각각 실행 | 모두 exit 0 |
| `bash -n scripts/spikes/s3-audible.sh` | exit 0 |
| `git diff --check` | exit 0 |
| 키 패턴 파일 스캔 | 저장소에서 키 형태의 문자열을 포함한 파일 0개 |

`Side.app` 상태 항목은 AX 메타데이터로 확인했다. 화면 픽셀 자체는 검사하지 않았다. 실측 스파이크는 합성·비개인적 입력을 사용했고, 실제 캡처 원문과 API 키를 로그·커밋에 남기지 않았다.

## 구현에 반영할 판정

- S-1: `aside repl` 반복이 세션 항목 증가를 동반해 Aside DOM 어댑터 기본값은 off로 유지한다.
- S-2: Chrome·Aside에서 기존 AX 본문은 2,048B를 넘었지만 `AXManualAccessibility` 설정은 지원되지 않았다. 기존 본문이 충분하면 사용하고 부족하면 OCR 후보로 둔다. Arc·Brave·Edge는 미설치라 미검증이다.
- S-3: 실제 오디오 재생 전이와 비교한 신뢰 가능한 1초 감지 증거가 없어 audible 신호를 채택하지 않는다.
- S-4: Chrome·Aside의 일반/시크릿 `window.mode` 전환을 확인했다. Safari AX 제목 신호는 안정적인 차단 근거가 아니며 Safari 비공개 창 차단은 보장되지 않는다. 이 한계를 `03-capture.md` §7에 기록했다.
- S-5: MiMo 2.6 Pro direct, MiniMax M3 direct, LAN `:8500` Grok 4.7에서 합성 `record_summary` tool call 1개를 확인했다. MiMo의 강제 `tool_choice`는 공식 문서상 무시되므로 해당 provider는 `supportsToolChoice=false`와 JSON 본문 폴백을 사용한다. 나머지 둘의 `true`는 단발 관측이다.

## 계약 해석과 남은 검증

- 디스크 `Settings` v2는 `02-architecture.md` §6의 nested camelCase를 따르고, `settings.get` 출력은 `resources.yaml`의 flat snake_case, `settings.patch` 입력은 화면 이벤트의 flat camelCase leaf를 따르는 구현 해석을 적용했다. 정본 문서의 필드 자체는 바꾸지 않았다.
- `RawObservation`의 와이어 필드는 정본에 구체적으로 정의되지 않아 P0 계약은 객체 경계만 검사한다. Phase 1 helper 구현과 결합할 때 관찰 이벤트별 필드 검증을 강화해야 한다.
- 디스크 retention 허용 범위는 1~30일이고 화면 선택지는 1·3·7·14·30일이다. 화면 리소스는 선택지만 노출한다.
- `settings.providers`의 디스크 기본 목록은 승인된 스키마대로 빈 배열이다. S-5의 provider별 `supportsToolChoice` 판정은 추후 provider 항목 생성·편집 시 적용해야 하며, `allowEvidence=false` 기본값은 유지한다.
- TCC 권한 부여와 30분 실사용 캡처는 Phase 1 통합 검증에서 별도로 수행한다. Phase 0은 앱 스켈레톤과 합성 프로브까지만 증명한다.
