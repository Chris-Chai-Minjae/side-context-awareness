# Spike S-4 — 시크릿/비공개 창 감지

## 범위와 방법

- 실행 환경: macOS 27.0, Google Chrome 153.0.8010.47, Aside 1.0.922.1, Safari 27.0.
- 프로브: `swift scripts/spikes/s4-private.swift <chrome|arc|brave|edge|aside|safari>`.
- 프로브는 이미 실행 중이고 전경에 있는 앱만 조회한다. 창 생성, 포커스 변경, 본문·URL 읽기, 권한 요청을 하지 않는다. 출력은 브라우저 ID, 판별 boolean, 숫자 오류만 포함한다.
- AppleScript는 `AEDeterminePermissionToAutomateTarget(..., false)`가 허용한 경우에만 실행한다. Safari AX는 `AXIsProcessTrusted()`가 true인 경우에만 조회한다.
- 일반 창과 비공개 창에서 별도 실행해 같은 신호가 false/true로 바뀌어야 실측 판별 가능으로 인정한다. 창 제목에 `Private Browsing` 등이 포함되는지만 확인하는 신호는 페이지 제목과 혼동될 수 있으므로 단독 차단 근거로 인정하지 않는다.

## 정적 조사

| 브라우저 | 설치 | 로컬 AppleScript dictionary | 실측 판정 |
|---|---:|---|---|
| Chrome | 예 | `window.mode`: `normal` 또는 `incognito` | **가능**: 일반 `false`, 시크릿 `true` |
| Arc | 아니오 | 미확인 | 설치되지 않아 불가 |
| Brave | 아니오 | 미확인 | 설치되지 않아 불가 |
| Edge | 아니오 | 미확인 | 설치되지 않아 불가 |
| Aside | 예 | `window.mode`: `normal` 또는 `incognito` | **가능**: 일반 `false`, 시크릿 `true` |
| Safari | 예 | Safari suite와 표준 `window`에 비공개 속성 없음 | **안정적 판별 미확인**: AX 제목 마커만 변화, AppleScript는 권한 미부여 |

설치 여부는 `/Applications/*.app`과 Launch Services 조회로 확인했다. `sdef`는 설치된 세 앱의 사전을 읽었다. Safari 사전의 속성 부재만으로 AX나 창 제목 방식의 성공·실패를 단정할 수 없다.

## 검증

- `swiftc -typecheck scripts/spikes/s4-private.swift`: 통과.
- `swift scripts/spikes/s4-private.swift`를 `arc`, `brave`, `edge`로 각각 실행: 모두 `installed=false`, `running=false`, `frontmost=false`; UI 접근 없이 종료.
- 비대화형 TCC 확인: Swift 실행 환경의 Accessibility `true`; Chrome와 Aside Automation `OSStatus=0`; Safari 실행 후 Automation `OSStatus=-1744`(동의 필요). 권한 요청은 하지 않았다.
- `bun test`: 28 pass, 0 fail. `npx tsc --noEmit`: 통과. `npx biome check .`: 32 files, 통과.
- `swift test --package-path apps/side-mac --scratch-path /tmp/side-s4-swift-test`: 1 test, 0 failures.

## 전용 UI 슬롯 실측

| 브라우저·창 상태 | `appleScriptPrivate` | Safari AX 제목 마커 | 기타 |
|---|---:|---:|---|
| Aside 일반 창 | `false` | 해당 없음 | Automation 허용 |
| Aside 새 시크릿 창 | `true` | 해당 없음 | `window.mode` 인식 |
| Chrome 창 없음 | 판정 불가 | 해당 없음 | AppleScript 오류 `-1719` |
| Chrome 새 일반 창 | `false` | 해당 없음 | `window.mode` 인식 |
| Chrome 새 시크릿 창 | `true` | 해당 없음 | `window.mode` 인식 |
| Safari 일반 창 | 권한 미부여 | `false` | AX 비공개 이름의 속성 없음 |
| Safari 새 비공개 창 | 권한 미부여 | `true` | AX 비공개 이름의 속성 없음 |
| Safari 비공개 창 닫은 뒤 일반 창 | 권한 미부여 | `false` | AX `AXDescription` 오류 `-25205` |

프로브와 별도인 테스트 준비 명령으로 빈 일반/비공개 창을 열었고 측정용 창은 닫았다. 기존 전경 앱인 Aside로 포커스를 복원했다. 실제 페이지 본문, URL, 창 제목은 출력하거나 기록하지 않았다.

## 판정과 후속

Chrome와 Aside는 `mode of front window`의 일반/시크릿 전환을 실측했으므로 시크릿 창 차단 신호로 채택 가능하다. Arc·Brave·Edge는 이 기기에 없어 해당 앱의 AppleScript 구현과 TCC 동작을 검증하지 못했다.

Safari의 `AXTitle` 마커는 빈 비공개 창에서만 확인했다. 창 제목은 웹 페이지 제목과 섞일 수 있으므로 이를 캡처 차단의 신뢰 가능한 근거로 사용할 수 없다. Safari AppleScript의 `mode`와 `name`은 Automation 수동 허용 전까지 실행하지 않았으며, 사전에는 비공개 속성이 없다. 따라서 현재 증거로는 Safari 비공개 창의 안정적 차단을 보장할 수 없다. 승인된 `docs/planning/03-capture.md` §7의 한계 기재와 최종 결정은 조정자에게 넘긴다.
