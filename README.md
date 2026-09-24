# Side

**[한국어](README.md) · [English](README.en.md)**

<img src="docs/assets/side-logo.png" alt="Side 로고" width="88">

Side는 Mac에서 활성 브라우저와 앱의 읽을 수 있는 내용을 기기에 기록하고, 나중에 시간·단어·주제로 찾아볼 수 있는 메뉴바 앱입니다. Aside Context Awareness의 macOS 동작을 독립적으로 구현했으며, Aside 설치나 Max 플랜 없이 사용할 수 있습니다.

Side is an open-source macOS menu bar app that records readable content from active browser and app windows on your device. You and connected agents can search the history with its sources. Daily summaries require a configured provider and your consent to send activity briefings. Build Side on your own Mac from source; a prebuilt app is not currently distributed.

**[처음 사용하는 분을 위한 한국어 안내서](https://chris-chai-minjae.github.io/side-context-awareness/side-for-beginners.html)** · **[Side 소개 페이지 / Landing page (한국어 · English)](https://chris-chai-minjae.github.io/side-context-awareness/)**

소스코드는 [MIT License](LICENSE)로 공개합니다. 안내서에서는 사용법과 쉬운 질문 예시를 볼 수 있고, 소개 페이지에서는 한국어와 영어로 작동 방식과 설치 조건을 확인할 수 있습니다.

## 어떻게 도움이 되나요?

![Mac의 활성 창을 기기에 기록하고, 출처를 검색해 연결한 에이전트에서 다시 찾는 네 단계 흐름](docs/assets/side-flow.png)

1. 권한을 허용한 활성 창의 읽을 수 있는 내용을 Side가 기기에 기록합니다. 앱·웹사이트를 제외하거나 기록을 일시정지할 수 있습니다.
2. 언제 무엇을 봤는지 검색할 수 있습니다. 요약 제공자를 설정하고 전송에 동의하면 날짜별 요약도 만듭니다.
3. 예를 들어 “어제 저녁에 봤던 식당 예약 페이지를 찾아주세요”라고 물어볼 수 있습니다. 확인할 수 있는 기록이 있다면 본 시간과 제목·주소를 알려줍니다.
4. Claude Code, Codex, Cursor, **Aside** 등에 Side를 MCP 도구로 등록하면 해당 에이전트에서도 같은 기록을 검색할 수 있습니다. 이때 Side.app이 실행 중이어야 합니다.

현재 저장소는 개발 중이며, 각 사용자가 Mac에서 소스를 빌드해 설치하는 방식으로 배포합니다. 사전 빌드 앱의 Developer ID 서명·공증과 장시간 실기기 검증은 완료되지 않았습니다. 남은 검증 항목은 [`docs/qa/`](docs/qa/)에 구분해 기록했습니다.

공개 저장소는 검증한 소스의 단일 시작 스냅샷입니다. 과거 QA 보고서의 개발 커밋 ID가 공개 Git 이력에서 조회되지 않는 이유는 [공개 이력 설명](docs/qa/publication-history.md)에 기록했습니다.

## 설치와 시작

macOS 14 이상이 필요합니다. 소스 빌드에는 Bun, Xcode Command Line Tools, FTS5와 확장 로딩을 지원하는 SQLite dylib가 필요합니다. 빌드 스크립트는 Homebrew SQLite 경로를 찾으며, 다른 빌드 경로의 dylib는 `SIDE_SQLITE_LIBRARY`로 지정할 수 있습니다. MiniLM 모델은 빌드할 때 내려받아 앱에 동봉합니다. 이미 채운 캐시가 있다면 `SIDE_MODEL_CACHE_SOURCE`로 지정할 수 있습니다. 실행할 Mac에는 Homebrew가 필요하지 않습니다.

```sh
git clone https://github.com/Chris-Chai-Minjae/side-context-awareness.git
cd side-context-awareness
bun install --frozen-lockfile
bun run build
```

빌드된 앱을 `/Applications/Side.app`에 복사해서 실행합니다. 같은 이름의 앱이 이미 실행 중이면 먼저 종료합니다.

```sh
ditto apps/side-mac/.build/release/Side.app /Applications/Side.app
open /Applications/Side.app
```

Side는 Dock 대신 메뉴바에 표시됩니다. 첫 실행 온보딩에서 캡처 권한을 부여하고 상황 인식을 켭니다. 요약 provider 설정은 건너뛸 수 있으며, 이 경우 캡처는 가능하지만 요약은 대기합니다. 메뉴바의 설정에서 보존 기간, 제외 앱·웹사이트, 요약 모델과 에이전트 연결을 관리합니다. 화면 언어는 설정에서 한국어 또는 English로 선택할 수 있습니다.

로컬 빌드는 임시 서명(ad hoc signing)을 사용합니다. 다시 빌드해 앱을 교체하면 macOS가 기존 Accessibility·Input Monitoring·Screen Recording 권한을 새 빌드에 적용하지 않을 수 있고, 저장된 암호화 키의 Keychain 접근도 다시 물을 수 있습니다. 그때는 Keychain 창에서 새 Side를 허용하고, 시스템 설정 → 개인정보 보호 및 보안의 해당 권한 목록에서 이전 `Side` 항목을 제거한 뒤 `/Applications/Side.app`을 다시 추가합니다. 사전 빌드 앱을 제3자에게 배포할 때 필요한 Developer ID·공증은 별도 게이트로 남아 있습니다. 현재 상태는 [`docs/qa/`](docs/qa/) 보고서와 [`docs/planning/06-tasks.md`](docs/planning/06-tasks.md)의 체크박스에서 확인할 수 있습니다.

Keychain 허용 창이 보이지 않고 데몬이 시작되지 않으면 **Keychain Access → login → Passwords**에서 `local-context-awareness-ledger` 항목의 **Access Control**을 열어 `/Applications/Side.app`을 개별 앱으로 추가한 뒤 저장합니다. 암호 표시나 모든 앱 허용은 필요하지 않습니다. [Apple의 앱별 Keychain 접근 안내](https://support.apple.com/en-mt/guide/mac-help/kychn002/mac)를 참고하세요. 저장 후 Side를 다시 시작합니다.

## macOS 권한

| 권한 | Side에서 쓰는 용도 |
|---|---|
| Accessibility | 활성 창의 제목, 접근성 텍스트와 선택 영역 읽기 |
| Input Monitoring | 입력된 문장을 구성하기 위한 입력 이벤트 관찰. 비밀번호 필드와 개별 키 입력은 저장하지 않음 |
| Screen Recording | 읽을 수 있는 접근성 텍스트가 없을 때 화면 글자를 온디바이스 OCR로 읽기. 이미지는 저장하지 않음 |
| Automation | 지원 브라우저의 현재 탭 URL 읽기 |

Screen Recording은 선택 사항입니다. macOS의 권한 창에서 Side를 승인해야 해당 관찰 기능이 작동합니다. 메뉴바 **Settings… → Permissions**에서 각 권한의 현재 상태를 따로 확인하고, 권한 요청 또는 해당 macOS 시스템 설정 항목 열기를 선택할 수 있습니다. 같은 화면에서 요약 제공자의 Keychain 키 참조를 확인하고, 접근 확인이 필요하면 **Keychain 권한 허용**을 누릅니다. 접근 상태는 명시적 승인 전까지 미확인으로 표시됩니다. CLI 진단은 아래 명령으로 실행합니다.

```sh
"/Applications/Side.app/Contents/Resources/side" doctor
```

오늘의 요약이 비어 있다면 먼저 10분 창이 끝났는지 확인하세요. 기록 화면에 실패한 요약 작업이 표시되면 모델 연결과 Keychain 접근을 확인한 뒤 **실패한 요약 다시 시도**를 누를 수 있습니다. 완료를 기다린 뒤 **요약 새로고침**을 누르면 새 결과가 표시됩니다. 재시도 버튼을 누르기 전에는 실패 작업을 다시 모델에 보내지 않습니다.

요약은 활동이 있는 10분 구간과 6시간 롤업에 모델을 사용합니다. 사용량은 활동량·입력 길이·재시도에 따라 크게 달라지며, 하루 종일 사용하면 수백만 입력 토큰에 이를 수 있습니다. 현재 일일 토큰 한도 기능은 없으므로 제공자 사용량을 확인하고, 비용을 제한하려면 캡처를 일시정지하거나 **이 제공자에게 증거 전송**을 끄세요. 전송을 끄면 새 요약은 만들어지지 않습니다.

## 데이터와 프라이버시

데이터 루트는 `~/Library/Application Support/Side/`이며 `SIDE_DATA_DIR`로 개발용 경로를 지정할 수 있습니다. `context-awareness/ledger.db`에는 원본 이벤트, `memory/episodic/`에는 날짜별 요약, `index.db`에는 검색 색인이 있습니다. 원본의 제목·URL·본문 등 민감 컬럼은 저장 전에 알려진 패턴에 따라 마스킹하고 AES-256-GCM으로 암호화합니다. 규칙 기반 마스킹은 모든 민감 정보를 찾는다는 보장이 없습니다. 마스터 키와 provider API 키는 macOS Keychain에 보관합니다. 요약과 날짜별 페이지는 로컬 파일에 평문으로 남습니다.

원본 캡처의 기본 보존 기간은 14일이며 설정에서 1·3·7·14·30일 중 선택할 수 있습니다. 요약은 별도로 남습니다. Side는 원본 캡처를 클라우드로 동기화하지 않습니다. 요약 provider에 **Send evidence to this provider**를 켠 경우에만 마스킹한 10분 창 briefing과 6시간 rollup briefing을 표시된 provider host로 보냅니다. 이 설정은 기본적으로 꺼져 있습니다. 연결한 에이전트가 MCP 결과를 자신의 모델에 전달할 수 있으므로 해당 에이전트의 데이터 정책도 확인해야 합니다. 같은 macOS 사용자 권한으로 실행되는 다른 프로세스의 MCP 접근은 완전히 차단할 수 없습니다.

## 일시정지와 삭제

메뉴바에서 15분·30분·1시간·재개할 때까지 캡처를 멈출 수 있습니다. 설정의 **Denylist**에는 관찰하지 않을 앱이나 웹사이트를 추가합니다. **Disable Context Awareness**는 새 캡처를 중단하지만 기존 이력은 보존 기간 또는 직접 삭제 시점까지 남습니다.

설정의 **Clear history**에서 최근 10분, 지난 1시간, 오늘, 전체 이력을 삭제할 수 있습니다. CLI에서도 다음처럼 실행합니다.

```sh
"/Applications/Side.app/Contents/Resources/side" clear today
"/Applications/Side.app/Contents/Resources/side" clear all
```

`clear all`은 대화형 확인 후 Side 이벤트·요약·날짜 페이지·검색 색인을 지우고 마스터 키를 교체합니다. `--yes`를 붙이면 대화형 확인을 건너뜁니다. 이 명령은 브라우저 자체의 방문 기록을 지우지 않습니다. 설정과 provider Keychain 항목은 이 이력 삭제와 별개입니다. 앱을 완전히 제거하려면 먼저 Side를 종료하고 이력을 삭제한 뒤 앱과 Side 데이터 디렉터리를 제거합니다. Keychain Access에서 `local-context-awareness-ledger` 및 `side-provider-api-key` 서비스 항목도 별도로 확인합니다.

## 에이전트 연결

Side.app이 실행 중일 때 `"/Applications/Side.app/Contents/Resources/side" mcp`가 `history_search`, `history_read`, `memory_search`를 제공합니다. Aside의 **Settings → MCP → Add server**에 Side를 등록하면 Aside 에이전트에서도 Side 기록을 찾아달라고 요청할 수 있습니다. Claude Code, Codex, Cursor와 Aside의 연결 방법은 [에이전트 연결 안내](docs/agents.md)에 있습니다. 데몬이 꺼져 있어도 MCP 서버는 시작되지만 도구 호출 시 `Side is not running. Open Side.app.`를 반환합니다.
