# Provider reliability triage — task_eafc9ecc34a0

2026-09-24. **판정: NO FIX.** 현재 확보한 메타데이터와 합성 HTTP 재현으로는 `src/comprehension`의 계약 또는 timeout 결함을 특정할 수 없다. 소스와 테스트는 변경하지 않았다.

## 조사 입력과 프라이버시 경계

- [기존 NFR 기록](nfr-report.md)의 완료된 10분 요약 1건: `mimo-v2.6-pro`, `attempt_count=2`, `window_to`부터 `updated_at`까지 584,717ms, 기록된 provider duration 약 80초. 이 창은 onboarding과 provider 설정 변경에 겹쳐 정상 경로의 3분 지연 측정치로 사용할 수 없다.
- Coordinator가 전달한 **메타데이터만** 사용했다. 추가 실패 3건(10분 2건, 6시간 1건)은 각각 `attempt_count=3`, 최종 오류 `all providers failed`였다. 별도 작업은 `record_summary contract violated`로 끝났다. 각 호출의 HTTP status, 응답 형식, validation rule, provider별 duration은 전달되지 않았다.
- Coordinator가 전달한 별도 62KB **합성** briefing 직접 호출 결과: MiMo는 HTTP 200 두 번과 repair 1회 후 약 53초에 성공했다. MiniMax M3는 HTTP 200 두 번 뒤 `SummaryContractError`였고, 별도 재시도는 HTTP 200 뒤 `AllProvidersFailedError`였다. 이는 Side daemon과 queue를 통과한 측정이 아니다.
- 이 작업은 Side/Aside ledger의 본문, 제목, URL, 행을 읽지 않았고 API key를 조회하거나 출력하지 않았다. 실제 provider를 다시 호출하지 않았다.

## 계약과 로컬 재현

`docs/planning/05-comprehension.md` §5–6은 계약 위반 시 같은 model에 repair를 **1회** 보내고 다시 위반하면 해당 attempt를 실패시키도록 정한다. Timeout 60초, 지정된 HTTP 오류, JSON 파싱 실패, 사용 가능한 tool call/JSON 부재는 다음 provider로 넘어간다. 구현도 [repair.ts](../../src/comprehension/repair.ts)와 [providers.ts](../../src/comprehension/providers.ts)에서 이 분기를 따른다. [queue.ts](../../src/comprehension/queue.ts)는 최대 3회 attempt를 허용하므로 `attempt_count=3` 자체는 재시도 정책과 일치한다.

`Bun.serve`를 `127.0.0.1:0`에서 시작하고 실제 `summarizeBriefing`에 `SettingsSchema`로 만든 설정을 전달했다. briefing은 합성 ASCII `x`와 `e:` 형식의 합성 ID로 정확히 `62 * 1024 = 63,488` UTF-8 bytes였다. fake provider는 요청 본문을 길이만 측정하고 아래 응답만 반환했다. 프로브는 임시 `bun -e` 실행으로만 만들었으며 파일·서버를 남기지 않았다.

| 합성 provider 응답 | 관측 결과 |
| --- | --- |
| 첫 `record_summary`의 `title`만 빈 문자열, 두 번째는 유효 | `done`, 동일 provider에 2회 호출, 가장 큰 wire 요청 66,665 bytes |
| 첫 provider HTTP 200 + JSON 객체가 없는 `content`; 두 번째 provider 유효 | `done`, 각 provider에 1회 호출 |
| HTTP 200 + JSON 객체가 없는 `content`인 provider만 존재 | `AllProvidersFailedError` |
| 첫 provider가 HTTP 200 + 빈 `title`을 두 번 반환; 다음 provider 유효 | `SummaryContractError`, 규칙 `title: must be nonempty`, 호출 수 2/0 |
| 첫 provider가 응답을 끝내지 않음; 두 번째 provider 유효 | 60,013ms 뒤 `done`, 설정 timeout 60,000ms, 호출 수 1/1 |

합성 프로브의 출력 원문이다. `p59245`는 실행 중 할당된 임시 loopback port의 식별자다.

```text
{"case":"62KB one-repair","state":"done","calls":2,"maxRequestBytes":66665,"model":"p59245/p59245"}
{"case":"HTTP200 unusable then fallback","state":"done","firstCalls":1,"secondCalls":1}
{"case":"HTTP200 unusable only","error":"AllProvidersFailedError"}
{"case":"two HTTP200 contract violations","error":"SummaryContractError","rules":["title: must be nonempty"],"firstCalls":2,"secondCalls":0}
{"case":"60s timeout","state":"done","elapsedMs":60013,"configuredTimeoutMs":60000,"stalledCalls":1,"fallbackCalls":1,"model":"fallback/fallback"}
```

관련 기존 테스트를 실행했다:

```text
$ bun test tests/comprehension/providers.test.ts tests/comprehension/provider-priority.test.ts tests/comprehension/contract.test.ts
52 pass
0 fail
190 expect() calls
Ran 52 tests across 3 files. [99.00ms]
```

## 판단과 다음 증거

Fake HTTP 재현은 62KB briefing, 1회 repair, HTTP 200의 unusable output, 60초 timeout, provider fallback이 현재 명세대로 동작함을 보여준다. MiMo의 53초 성공과 완료 작업의 약 80초 *provider duration*은 한 HTTP 호출의 60초 timeout 위반을 증명하지 않는다. 후자는 여러 호출의 합계일 수 있으며, 완료 작업의 584,717ms에는 onboarding과 queue 시간이 포함된다.

실패 작업의 `all providers failed`는 timeout, 허용된 HTTP 오류, 키 부재, 파싱 불가 응답 중 무엇이었는지 구분하지 못한다. `record_summary contract violated`도 실제 validation rule이 없어서 계약 검사가 잘못되었는지 판단할 수 없다. 원인 확인 없이 timeout을 늘리거나 repair/fallback 정책을 바꾸면 §5–6 계약과 개인정보 전송 경계를 바꿀 수 있으므로 수정하지 않았다.

Side daemon의 기존 `providers.test`는 허구의 빈 활동 창으로 **단일 호출**을 확인한다. 이 결과는 provider 연결성의 좁은 증거이며 62KB briefing, repair, queue retry, 정상 provider 지연의 증거가 아니다. 실제 [runSummaryPass](../../src/comprehension/run.ts)도 `ProviderLog` callback을 전달하지 않아 실패 작업에 호출별 메타데이터가 남지 않는다. 원인을 좁히려면 다음 합성 재현에서 호출별 provider/model, HTTP status 또는 transport error 범주, request/response bytes, duration, 비내용 validation rule code만 확보해야 한다. 본문·제목·URL·키는 수집할 필요가 없다.
