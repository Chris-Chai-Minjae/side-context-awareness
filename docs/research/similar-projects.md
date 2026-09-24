# Context Awareness 유사 프로젝트 조사

조사일: 2026-09-24. 공개 GitHub 저장소의 README, 아키텍처 및 라이선스 문서를 확인했다. 실행·보안 감사 결과는 아니다.

| 프로젝트 | 확인한 구현 | Side 명세와 다른 점 |
|---|---|---|
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch) ([web watcher](https://github.com/ActivityWatch/aw-watcher-web), [window watcher](https://github.com/ActivityWatch/aw-watcher-window)) | 앱·창·브라우저 URL 및 AFK 활동을 로컬 watcher/server에 기록. MPL-2.0. | 화면 본문과 OCR, 저장 전 비밀 마스킹, 인용 가능한 10분·6시간 요약은 기본 경로에 없다. |
| [Memoir](https://github.com/Emanuelel/memoir) ([architecture](https://github.com/Emanuelel/memoir/blob/main/ARCHITECTURE.md), [privacy](https://github.com/Emanuelel/memoir/blob/main/PRIVACY.md)) | macOS AX 텍스트를 읽어 로컬 SQLite에 보관하고 MCP로 회수. MIT. | 스크린샷·OCR·키 입력 기록은 하지 않는다고 명시한다. Side의 브라우저 URL 및 원본 ledger 계약과 다르다. |
| [MemoryLane](https://github.com/deusXmachina-dev/memorylane) ([privacy](https://github.com/deusXmachina-dev/memorylane/blob/main/docs/privacy-and-permissions.md)) | 화면 캡처를 모델로 요약하고 스크린샷은 지운 뒤 OCR·요약·embedding을 로컬에 보관, MCP 제공. GPL-3.0. | 기본 모델 경로는 관리형 endpoint이며, Side가 요구하는 텍스트 briefing만의 선택적 반출·원본 증거 인용과 다르다. |
| [SecondBrain](https://github.com/openintelligence-labs/secondbrain) ([architecture](https://github.com/openintelligence-labs/secondbrain-docs/blob/main/docs/index.md)) | macOS ScreenCaptureKit, AX/OCR, 하이브리드 검색, 일간 digest 및 MCP. MIT. | 화면 프레임과 여러 검색 저장소를 중심으로 설계되어 Side의 제한 보관 ledger와 요약 단계가 다르다. |
| [Screenpipe](https://github.com/screenpipe/screenpipe) ([license](https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md)) | 화면·오디오 활동과 로컬 검색·에이전트 연동을 제공. | 현재 라이선스는 상업 이용과 경쟁 제품 제작에 제한을 두므로 코드 재사용 후보에서 제외했다. |

현재 공개 저장소에서 승인된 Side 명세의 **앱·브라우저 관찰 → 저장 전 마스킹과 암호화된 제한 보관 → 10분·6시간 요약 → 인용 가능한 회수**를 한 제품으로 확인하지 못했다. 위 저장소는 설계 비교에만 사용했고 코드를 복사하지 않았다.
