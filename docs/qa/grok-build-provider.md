# Grok Build login integration — blocked synthetic gate

기준: 2026-09-24, Grok Build CLI 0.2.93. 사용자는 기존 Grok Build 로그인을 Side 요약 제공자로 재사용하도록 요청했다. 실제 Side/Aside 캡처 본문, ledger 행, API 키는 읽거나 전송하지 않았다. 이 파일은 인증 내용과 CLI 원문 응답을 담지 않는다.

## 요약 제공자 판정

- 현재 사용자 `GROK_HOME`에서 글로벌 hook/plugin/MCP 등이 활성 상태로 발견되어 활동 증거를 그대로 넘기는 실행 경로로 채택하지 않았다.
- 개인용 임시 `HOME`과 `GROK_HOME`, 권한 `0600`의 일시적인 인증 파일 복사본, allowlisted 환경에서 `grok inspect --json`의 사용자 hook/plugin/MCP/project instruction은 모두 0개였다. 원본 인증 파일 메타데이터는 변하지 않았고 임시 복사본과 세션 디렉터리는 검사 후 삭제했다.
- `grok-build`는 로컬 모델 목록에 없었다. 목록에는 `grok-4.5`, `grok-4.6`, `grok-4.7`, `grok-4.7-build-fast`가 있었다.
- 목록에 있는 `grok-4.7-build-fast`에 합성 표준입력 표식만 보낸 격리 호출도 종료 코드 1이었다. 도구 호출은 관찰되지 않았고 표식 응답도 없었다. 안전한 오류 분류로 원인을 특정하지 못했다. 원문 stdout/stderr와 세션 본문은 보관하지 않았다.

따라서 **기존 로그인으로 작동하는 Grok Build 요약 경로는 미검증**이며 Side에 Grok CLI 요약 provider를 연결하지 않았다. 합성 입력에서 모델 응답과 도구 격리까지 확인되기 전에는 사용자 활동을 이 경로로 보내지 않는다. MiMo 2.6 Pro와 MiniMax M3의 별도 API 제공자 설정에는 영향이 없다.

## MCP 클라이언트는 별개

로컬 `grok mcp add --help`와 [xAI MCP 문서](https://docs.x.ai/build/features/mcp-servers)는 Grok Build에 Side의 `stdio` MCP 서버를 등록하는 방법을 제공한다. [에이전트 연결 문서](../agents.md)에 사용자 범위 명령을 적었다. 이는 Grok이 Side의 `history_search` 등을 **질문할 수 있게 하는 설정**이며 Grok을 Side의 백그라운드 요약 provider로 쓰는 기능과 다르다. 실제 Grok→Side 도구 호출은 아직 실측하지 않았다.
