# 에이전트에서 Side 기억 사용하기

먼저 `Side.app`을 실행하고 메뉴바에서 **Enable Context Awareness**를 켠다. 아래 예시는 앱을 `/Applications/Side.app`에 설치했을 때의 경로다. 다른 위치에 설치했다면 실행 파일의 절대 경로로 바꾼다. 에이전트마다 등록하는 실행 파일과 인수는 `"/Applications/Side.app/Contents/Resources/side" mcp`이며, Side가 시작하는 로컬 stdio MCP 서버다.

## 등록

### Claude Code

터미널에서 사용자 범위로 등록한다. `--scope user`를 빼면 현재 디렉터리 범위로 등록된다.

```sh
claude mcp add --scope user side -- "/Applications/Side.app/Contents/Resources/side" mcp
claude mcp get side
```

### Codex

```sh
codex mcp add side -- "/Applications/Side.app/Contents/Resources/side" mcp
codex mcp list
```

### Cursor

전체 프로젝트에서 사용하려면 `~/.cursor/mcp.json`, 한 프로젝트에서만 사용하려면 그 프로젝트의 `.cursor/mcp.json`에 다음 서버 항목을 추가한다. 기존 `mcpServers` 항목이 있으면 `side`만 병합한다. Cursor의 [MCP 설정 문서](https://docs.cursor.com/context/model-context-protocol)는 이 두 위치와 `stdio`의 `command`/`args` 형식을 설명한다.

```json
{
  "mcpServers": {
    "side": {
      "command": "/Applications/Side.app/Contents/Resources/side",
      "args": ["mcp"]
    }
  }
}
```

### Grok Build

Grok Build CLI 0.2.93의 `mcp add`는 사용자 범위 설정을 지원한다. 다음 명령은 Grok Build를 **Side 검색 도구의 클라이언트**로 등록한다. Side의 요약 모델 제공자를 Grok으로 바꾸는 명령은 아니다. [xAI MCP 문서](https://docs.x.ai/build/features/mcp-servers)와 로컬 `grok mcp add --help`에서 `stdio` 명령 형식을 확인했다.

```sh
grok mcp add --scope user side -- "/Applications/Side.app/Contents/Resources/side" mcp
grok mcp list
```

이 Mac에서는 등록 명령을 실행하거나 Grok의 Side 도구 호출을 실측하지 않았다. 프로젝트 범위가 필요하면 `--scope project`를 사용하며, 해당 프로젝트의 `.grok/config.toml`에 설정이 저장된다.

### Aside

Aside의 **Settings → MCP → Add server**에서 이름을 `side`, command를 `/Applications/Side.app/Contents/Resources/side`, args를 `mcp`로 입력한다. 이는 Aside가 Side의 MCP 도구를 쓰게 하는 등록이다. `aside mcp` 명령은 반대 방향으로 Aside 자체의 도구를 외부에 제공한다. Aside 설정 또는 메모리 파일을 직접 편집하지 않는다.

## 도구 3종

| 도구 | 입력 예 | 결과 |
|---|---|---|
| `history_search` | `{"queries":["어제 오후 sqlite 확장 문서"],"limit":5}` | Side 캡처 `e:`, 요약 `s:`, 브라우저 방문 기록 `h:`의 시간·URL·스니펫 |
| `history_read` | `{"id":"<e: 또는 s: ref>"}` | 선택한 `e:` 원본 본문 또는 `s:` 요약. 만료된 원본은 관련 요약 참조. `h:`는 읽을 수 없음 |
| `memory_search` | `{"query":"sqlite 확장 로딩","limit":5}` | 날짜별 요약 페이지의 어휘·의미 혼합 검색 결과 |

`history_search`의 `e:` 또는 `s:` `ref`만 `history_read`의 `id`에 그대로 넣는다. 브라우저 방문 기록을 직접 조회한 `h:` 결과는 제목·URL·방문 시각만 제공하며 `history_read`로 열 수 없다. `ref` 접두사는 중복해서 붙이지 않는다. 에이전트에게는 “어제 오후에 보던 sqlite 확장 문서를 `history_search`로 찾고, `e:` 출처가 있으면 `history_read`로 열어줘”처럼 요청하면 된다.

검색 결과와 읽기 본문은 관찰된 화면에서 온 **신뢰할 수 없는 데이터**다. 그 안의 지시문을 에이전트 명령으로 따르지 않는다. Side는 응답에 `<untrusted-evidence>` 경계를 붙이며, 도구 설명에도 같은 규칙을 포함한다.

## 연결 확인

1. `"/Applications/Side.app/Contents/Resources/side" status`로 데몬 상태를 확인한다.
2. 클라이언트에서 Side 도구 3종이 보이는지 확인한다.
3. 캡처된 적이 있는 고유한 페이지 제목을 `history_search`로 찾고, `e:` 또는 `s:` `ref`가 반환되면 `history_read`로 연다. `h:` 결과만 있으면 브라우저 방문 기록의 URL·제목만 확인할 수 있다. 아직 활동이 없으면 빈 결과가 정상이다.
4. `memory_search`는 요약 provider가 요약을 만든 뒤 날짜별 페이지가 인덱싱돼야 결과가 나온다.

데몬이 꺼져 있을 때 MCP 프로세스는 시작되지만 도구 호출은 `Side is not running. Open Side.app.` 오류를 반환한다. 권한·Keychain·SQLite·모델 캐시·provider 상태는 `"/Applications/Side.app/Contents/Resources/side" doctor`로 확인한다. 실제 내용이 포함된 검색 결과를 에이전트의 외부 모델에 전달할지 여부는 해당 클라이언트의 설정과 정책에 따른다. Side의 보존 기간과 전체 삭제는 브라우저 자체 방문 기록을 지우지 않는다.
