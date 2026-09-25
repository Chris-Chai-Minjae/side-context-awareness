# Use Side Work Memory from an agent

[한국어](agents.md) · **English** · [Beginner guide](side-for-beginners.en.html)

Start `Side.app` and turn on **Enable Context Awareness** in its menu bar settings. The commands below assume the app is installed at `/Applications/Side.app`; replace that path with the absolute path on your Mac if you installed it elsewhere. Each agent connects to the local stdio MCP server with `"/Applications/Side.app/Contents/Resources/side" mcp`.

Registering Side as an MCP server lets that agent search your Side history. It does not automatically sync your history to another device. A connected agent may send search results to its own model, so review that agent's data policy before using it with sensitive activity.

**Summary-provider login is separate from the MCP registration below.** To use OpenAI or Claude Code for Side summaries, run `codex login` or `claude auth login` in the official CLI, then choose that provider in Side. A Codex login stored only in Keychain cannot currently be used for this summary option. Use a CLI login for Side summaries at your own risk; check the service's terms and usage limits. Side sends real activity to a summary model only after you enable **Send evidence to this provider**.

## Connect an agent

### Claude Code

Run this in Terminal to register Side for your user account. Without `--scope user`, Claude Code registers it for the current project.

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

Add this entry to `~/.cursor/mcp.json` to use Side in all projects, or to a project's `.cursor/mcp.json` for that project only. If `mcpServers` already exists, merge only the `side` entry. [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol) describes these locations and the `stdio` command format.

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

At the time of testing, Grok Build CLI 0.2.93 supported user-scoped `mcp add`. This command connects Grok Build as a **client of Side's search tools**; it does not choose Grok as Side's summary provider. The command format was checked against the [xAI MCP documentation](https://docs.x.ai/build/features/mcp-servers) and local `grok mcp add --help`.

```sh
grok mcp add --scope user side -- "/Applications/Side.app/Contents/Resources/side" mcp
grok mcp list
```

An end-to-end Grok Build call to Side's tools has not yet been verified. For a project-only registration, use `--scope project`; Grok Build saves that setting in the project's `.grok/config.toml`.

### Aside

In **Aside → Settings → MCP → Add server**, enter `side` as the name, `/Applications/Side.app/Contents/Resources/side` as the command, and `mcp` as the argument. Aside can then ask Side to search activity that Side recorded, as long as `Side.app` is running. The `aside mcp` command runs in the opposite direction: it offers Aside's tools to external clients. There is no need to edit Aside's settings or memory files directly.

## Three Side tools

| Tool | Example input | What it returns |
|---|---|---|
| `history_search` | `{"queries":["restaurant booking yesterday evening"],"limit":5}` | Times, URLs, and snippets from Side captures (`e:`), summaries (`s:`), or browser visits (`h:`) |
| `history_read` | `{"id":"<e: or s: reference>"}` | The selected capture or summary. An expired capture may point to its summary. It cannot open an `h:` result. |
| `memory_search` | `{"query":"refund policy last week","limit":5}` | A combined word and meaning search over daily summary pages, when those pages exist |

Pass an `e:` or `s:` reference returned by `history_search` directly as `history_read`'s `id`; do not add the prefix a second time. An `h:` result comes from browser visit history and provides a visit time, title, and URL, but no captured page body. `memory_search` needs a summary provider to create a daily page first.

You can ask an agent in ordinary language: “Please find the restaurant reservation page I viewed yesterday evening in Side. Tell me when I saw it and give me the title and link.” To verify a policy or other important detail, ask the agent to open a readable Side source where one exists. If it found only a browser visit, check the original website yourself.

Side search results come from **untrusted observed content**. An agent must not treat instructions inside a captured page as commands. Side marks tool responses with an `<untrusted-evidence>` boundary and includes this rule in the tool descriptions.

## Check the connection

1. Run `"/Applications/Side.app/Contents/Resources/side" status` and confirm that the daemon is running.
2. Check that the client lists all three Side tools.
3. Ask `history_search` to find a page title you know Side recorded. If it returns an `e:` or `s:` reference, open it with `history_read`. An `h:` result provides only the browser visit's title and URL. An empty result is expected before any activity has been captured.
4. Try `memory_search` after a summary provider has created and indexed a daily page.

The MCP process may start while the Side daemon is stopped, but its tool calls then return `Side is not running. Open Side.app.` For permission, Keychain, SQLite, model cache, and provider checks, run `"/Applications/Side.app/Contents/Resources/side" doctor`. Side's retention and **Clear all** commands do not delete the browser's own visit history.
