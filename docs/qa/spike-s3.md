# Spike S-3 — 오디오 재생 감지 (P0-T0.6)

- 측정: 2026-09-24 JST, macOS 27.0, Aside CLI 1.26.916.1741.
- **판정: 미채택.** 조회 자체는 1초 미만이었으나, 실제 재생 시작·정지와 대조한 감지 지연 및 정확도 증거가 없다. `00-decisions.md`의 S-3 기본 경로인 audible 신호 없는 어텐션 모델을 유지하는 것이 현재 증거에 맞다. 정본 결정표와 태스크 체크는 코디네이터가 기록한다.
- 프로브는 브라우저 포커스·탭을 바꾸지 않고 메타데이터만 조회했다. `aside repl` 호출은 S-1 실측상 Aside 세션 항목 생성의 부작용이 있어, 이 조회를 무부작용으로 간주하지 않는다. 탭 본문·URL·제목·프로세스 식별자는 출력하지 않았다.

## 후보와 실측

| 후보 | 관찰한 boolean·조회 지연 | 1초 판정에 남은 문제 |
|---|---|---|
| CoreAudio process objects | 전체: `runningOutput=true`, 78.0ms. Aside: `targetPresent=true`, `runningOutput=true`, 78.2ms. Chrome: `targetPresent=false`, 86.7ms. | `IsRunningOutput`은 활성 출력 스트림을 뜻한다. 실제 가청 음량·콘텐츠 재생·탭 귀속을 보장하지 않는다. 현재 Aside true의 독립 재생 기준값이 없다. Chrome은 CoreAudio 대상 object가 없었다. |
| Aside `listBrowserTabs()` | `hasTabs=true`, `audibleField=false`, `anyAudible=false`, 1.0ms. | 열린 탭이 있었지만 이 CLI 결과에는 `audible` 필드가 없었다. `anyAudible=false`는 재생 중이 아님을 뜻하지 않는다. |
| Chrome AX 탭 제목 | `chromeRunning=false`, `axTrusted=true`, `probeOk=false`, 17.1ms. | Chrome이 실행 중이지 않아 탭 노드·제목 재생 표식을 검증하지 못했다. 현지화된 제목 표식의 안정성도 미검증이다. |

`CoreAudio`의 이 경로는 process object 속성 조회이며 오디오 tap을 생성하거나 PCM을 읽지 않는다. Apple SDK `CoreAudio.framework/Headers/AudioHardware.h`의 `kAudioHardwarePropertyProcessObjectList` 설명은 연결된 client process 목록, `kAudioProcessPropertyIsRunningOutput` 설명은 오디오 I/O와 활성 출력 스트림을 정의한다. [Apple process object list](https://developer.apple.com/documentation/coreaudio/kaudiohardwarepropertyprocessobjectlist), [Apple running output](https://developer.apple.com/documentation/coreaudio/kaudioprocesspropertyisrunningoutput), [Apple AX attribute read](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue).

## 재현 명령과 실제 출력

명령의 `queryMs`는 각 API 조회 시간이다. `swift` 인터프리터의 시작·컴파일 시간은 포함하지 않는다. `aside repl` 역시 CLI 시작 시간은 제외한다. 전체 명령 완료 시간이나 재생 상태 전이 지연과 동일시하면 안 된다.

```sh
swiftc -typecheck scripts/spikes/s3-audible.swift
swift scripts/spikes/s3-audible.swift coreaudio '*'
# {"probeOk":true,"targetPresent":true,"runningOutput":true,"queryMs":78.032958}
swift scripts/spikes/s3-audible.swift coreaudio at.studio.AsideBrowser
# {"probeOk":true,"targetPresent":true,"runningOutput":true,"queryMs":78.197875}
swift scripts/spikes/s3-audible.swift coreaudio com.google.Chrome
# {"probeOk":true,"targetPresent":false,"runningOutput":false,"queryMs":86.734042}
bash scripts/spikes/s3-audible.sh
# {"asideAvailable":true,"probeOk":true,"hasTabs":true,"audibleField":false,"anyAudible":false,"queryMs":1.0435840003192425}
swift scripts/spikes/s3-audible.swift chrome-ax
# {"chromeRunning":false,"axTrusted":true,"probeOk":false,"queryMs":17.082375}
```

## 1초 수용에 필요한 증거

1. 탭 또는 앱에서 실제 재생을 시작·일시정지하는 시각을 독립적으로 기록하고, 같은 프로세스에서 후보 신호를 100ms 이하 간격으로 관찰한다. 각 전이 후 **1,000ms 안에 올바른 상태**가 되는지 측정한다. 단순한 단발 조회 시간은 이 기준의 대체물이 아니다.
2. 무음 출력 스트림, 재생 중인 전경·배경 탭, 일시정지, 브라우저 helper process를 구분한다. CoreAudio true가 무음·일시정지에서도 유지되면 audible 판정에는 쓰지 않는다.
3. Chrome을 실행하고 Accessibility가 허용된 환경에서 제목 표식의 존재, 언어별 변동, 탭별 귀속을 확인한다. Aside에 `audible` 필드가 생긴 버전이라면 같은 전이 시험을 반복한다.

이번 실행에서는 브라우저 UI를 다른 워커가 사용 중이므로 재생을 조작하지 않았다. 현재 소리가 실제로 재생 중인지도 독립적으로 확인하지 못했으며, 위 조건을 충족하기 전에는 어떤 후보도 1초 수용 합격으로 기록할 수 없다.

## 검증

- `swiftc -typecheck scripts/spikes/s3-audible.swift`: 통과.
- `bash -n scripts/spikes/s3-audible.sh`: 통과.
- `bun test`: 28 pass, 0 fail.
- `npx tsc --noEmit`: 통과.
- `npx biome check .`: 32 files checked, no fixes applied.
- `swift test --package-path apps/side-mac --scratch-path /tmp/side-s3-task_4ad8d486f151-build`: 1 test, 0 failures.
