# Spike S-5 — provider별 강제 `tool_choice` (2026-09-24)

## 방법과 범위

- `bun run scripts/spikes/s5-provider.ts`로 direct provider 두 곳에 합성 요청을 각각 1회 보냈다. LAN은 첫 MiniMax alias 관측 후 사용자 정정에 따라 `bun run scripts/spikes/s5-provider.ts lan`으로 `grok-4.7`을 1회 더 확인했다. 스크립트는 승인된 `docs/planning/05-comprehension.md` §5의 `record_summary` JSON Schema를 읽어 사용하며 `pattern`이 없다. 메시지는 가상 인물이 TextEdit에서 정원 동아리 포스터를 작성했다는 비개인적 내용이고 실제 증거 ID·URL이 없다.
- Aside 설정과 credentials는 읽기 전용으로 프로세스 메모리에서만 파싱했다. 키, 네트워크 응답 본문, 생성된 tool 인자는 출력·파일·명령 인자·환경변수에 남기지 않았다. HTTP 응답은 메모리에서만 스키마 검증했다. CommandCode 경로는 호출하지 않았다.
- MiMo는 Aside의 `xiaomi-coding` Token Plan 직접 호스트를 사용했다. 로컬 모델 목록은 v2.5 계열만 보였으나 [Xiaomi Token Plan 문서](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)가 동일한 방식의 `mimo-v2.6-pro` 요청을 명시하고, 실제 HTTP 200으로 해당 모델의 사용 가능성을 확인했다.
- MiniMax는 Aside의 `minimax` credential 및 `MiniMax-M3` 카탈로그 항목과 [MiniMax 공식 OpenAI 호환 경로](https://platform.minimax.io/docs/guides/text-generation)를 확인한 뒤 직접 `/v1/chat/completions`로 호출했다. Aside 카탈로그의 기존 `/anthropic` 경로는 이번 OpenAI 호환 테스트에 사용하지 않았다.
- LAN은 현재 Aside `litellm` 등록인 `192.168.1.141:8500/v1`을 사용했다. 인증된 `GET /v1/models`는 `grok-4.7`을 광고했고, 이 모델을 LAN fallback 후보로 합성 호출했다. Aside 등록 목록에 `grok-4.7`이 보이지 않는 것과 실제 `/models` 가용성을 구분했다. 원래 T0.8에 적힌 `:8100`은 다른 서비스였고, 사용자가 2026-09-24에 Side의 LAN fallback 주소를 **`:8500`으로 확정**했다.

## 관측 결과

| 대상 | 요청 모델 ID | 호스트 | HTTP | 400 | 지연 | `record_summary` tool call | `forcedToolCallObserved` | `supportsToolChoice` 설정 판정 |
|---|---|---|---:|---|---:|---|---|---|
| MiMo direct | `mimo-v2.6-pro` | `token-plan-sgp.xiaomimimo.com` | 200 | 아니오 | 7,578 ms | 1개, 인자 스키마 유효 | **true** | **false** |
| MiniMax direct | `MiniMax-M3` | `api.minimax.io` | 200 | 아니오 | 5,413 ms | 1개, 인자 스키마 유효 | **true** | **true (1회 관측)** |
| LAN 현재 등록, fallback 후보 | `grok-4.7` | `192.168.1.141:8500` | 200 | 아니오 | 5,388 ms | 1개, 인자 스키마 유효 | **true** | **true (1회 관측)** |
| LAN 현재 등록, 추가 관측 | `MiniMax-M3` | `192.168.1.141:8500` | 200 | 아니오 | 5,211 ms | 1개, 인자 스키마 유효 | **true** | **true (1회 관측, 의도된 LAN 모델 아님)** |
| 원래 계획서 주소, 현재 대상 아님 | 미확정 | `192.168.1.141:8100` | POST 미호출 | 미확인 | 미확인 | 미확인 | **unknown** | **unknown** |

[Xiaomi OpenAI API 문서](https://mimo.mi.com/docs/en-US/api/chat/openai-api)는 `tool_choice`가 `auto` 이외의 값이면 백엔드가 해당 필드를 제거하고 `auto`와 동일하게 처리한다고 명시한다. 따라서 MiMo의 `forcedToolCallObserved=true`는 유효한 응답 관측값이지만, 설정용 `supportsToolChoice=false`로 둔다. MiniMax와 LAN `:8500`의 지원 판정은 각각 단발성 요청만의 증거다.

조정자의 별도 읽기 전용 검사에서 `:8100/health`와 `:8100/v1/models`는 200, `:8100/models`는 404, GET `:8100/v1/chat/completions`는 405였다. `:8100/v1/models`의 19개 ID는 GPT/Codex 계열이며 Grok·MiMo·MiniMax는 없었다. 이는 `:8100`이 `:8500`과 다른 서비스임을 보여 주지만, 인증된 POST나 `tool_choice` 지원 여부는 증명하지 않는다.

## 검증과 남은 일

- 워커의 독립 검증에서 `bun test` 58 pass였고 `bunx biome check scripts/spikes/s5-provider.ts`가 통과했다. 당시 전체 tsc·Biome은 동시 작성 중인 P0-T0.9 파일 때문에 일시적으로 실패했다.
- P0-T0.9 병합 후 조정자가 다시 실행한 최종 게이트는 `bun test` **60 pass, 0 fail**, `npx tsc --noEmit` **0 errors**, `npx biome check .` **48 files, 0 errors**였다.
- Aside에서 메모리로 읽은 현재 키 3개의 값이 소유 파일 2개에 포함되는지 검사한 결과 **0건**이었다. 값 자체는 출력하지 않았다.
- `programming` 스킬의 추가 no-excuse 검사기는 TypeScript 7의 `typescript/unstable/*` API를 요구하지만 이 프로젝트는 TypeScript 5.9라 실행되지 않았다. 위의 프로젝트 타입 검사·경로 한정 Biome·테스트는 별도로 통과했다. 스파이크 스크립트는 249 pure LOC로 스킬의 200–250 경고 구간에 있으므로 후속 기능이 늘면 파일 분리가 필요하다.
- **S-5 수용 확인:** 세 사용자 확정 경로에서 합성 `record_summary` tool call 1개와 유효 인자를 확인했다. 설정용 `supportsToolChoice` 판정은 MiMo direct `false`, MiniMax direct `true (1회 관측)`, LAN `:8500`의 `grok-4.7` `true (1회 관측)`이다. MiMo에는 문서상 강제 선택이 무시되므로 구현에서 JSON 본문 폴백을 유지해야 한다. `:8100`의 인증된 POST는 현재 Side 경로에 해당하지 않아 실행하지 않았다.
