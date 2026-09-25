# Side detailed manual

[한국어](manual.md) · [English](manual.en.md) · [Back to README](../README.en.md) · [Beginner's guide](side-for-beginners.en.html)

This is the technical manual for the details that were moved out of the [README](../README.en.md): storage paths and commands, build options, permission recovery after a rebuild, summary model setup and cost, and full uninstall. If you are new to Side, start with the [beginner's guide](side-for-beginners.en.html).

- [1. Requirements](#1-requirements)
- [2. Build and install](#2-build-and-install)
- [3. First launch and settings](#3-first-launch-and-settings)
- [4. macOS permissions](#4-macos-permissions)
- [5. Diagnostics and troubleshooting](#5-diagnostics-and-troubleshooting)
- [6. Summary models and cost](#6-summary-models-and-cost)
- [7. Data storage layout](#7-data-storage-layout)
- [8. Pause, delete, and full removal](#8-pause-delete-and-full-removal)
- [9. Agent connection](#9-agent-connection)
- [10. Development status and open gates](#10-development-status-and-open-gates)

## 1. Requirements

| Item | Detail |
|---|---|
| OS | macOS 14 or later |
| Build tools | Bun, Xcode Command Line Tools |
| SQLite | A dylib with FTS5 and extension loading (search index and vector search) |
| Network | The first build downloads the MiniLM model. Homebrew is not required on the Mac that runs the app. |

## 2. Build and install

```sh
git clone https://github.com/Chris-Chai-Minjae/side-context-awareness.git
cd side-context-awareness
bun install --frozen-lockfile
bun run build

ditto apps/side-mac/.build/release/Side.app /Applications/Side.app
open /Applications/Side.app
```

- The build output is `apps/side-mac/.build/release/Side.app`. Quit any running app with the same name before copying.
- The build script looks for Homebrew SQLite paths first. To use a dylib elsewhere, set `SIDE_SQLITE_LIBRARY` to its absolute path.
- If you already have a populated MiniLM cache, point `SIDE_MODEL_CACHE_SOURCE` at it to skip the download.
- For development, `SIDE_DATA_DIR` changes the data path.
- Local builds use **ad hoc signing**. That is fine for your own Mac; distributing the app to others requires Developer ID signing and notarization (not done yet).

## 3. First launch and settings

1. Side appears in the **menu bar**, not the Dock.
2. On first launch the onboarding walks you through capture permissions and enables Context Awareness.
3. Summary provider setup can be skipped. Capture and search then work, and summaries wait.
4. Menu bar **Settings** manages retention, excluded apps and websites (denylist), the summary model and provider, agent connections, and display language (한국어 / English).

## 4. macOS permissions

| Permission | How Side uses it |
|---|---|
| Accessibility | Read the active window title, accessibility text, and selected text |
| Input Monitoring | Observe input events to construct typed sentences; password fields and individual keystrokes are not stored |
| Screen Recording | Use on-device OCR to read screen text when readable accessibility text is unavailable; images are not stored |
| Automation | Read the current tab URL in supported browsers |

- **Screen Recording is optional.** You must approve Side in the macOS permission dialog for that observation feature to work.
- Menu bar **Settings → Permissions** shows the current state of each permission separately, requests access, or opens the matching macOS settings pane.
- The same page shows each summary provider's configured Keychain reference. If access confirmation is needed, click **Authorize Keychain**. The access state shows as unchecked until you explicitly approve it.

## 5. Diagnostics and troubleshooting

### Diagnostic commands

```sh
"/Applications/Side.app/Contents/Resources/side" doctor    # Keychain, permissions, SQLite, vector module, model cache, provider connection
"/Applications/Side.app/Contents/Resources/side" status    # daemon status
```

The provider connection check in `doctor` uses a synthetic sentence instead of your activity.

### Permissions are missing after a rebuild

Local builds use ad hoc signing, so after you replace the app with a new build, macOS may not apply the previous Accessibility, Input Monitoring, and Screen Recording permissions to it. It may also ask again for Keychain access to the saved encryption key.

1. Approve the new Side in the Keychain dialog if it appears.
2. In menu bar **Settings → Permissions**, check Accessibility, Input Monitoring, and Screen Recording one by one. **Open System Settings** on each row jumps to the matching macOS pane.
3. In System Settings → Privacy & Security, remove the old `Side` entries from those lists and add `/Applications/Side.app` again.
4. Check the app path before pressing the same permission switch repeatedly.

### No Keychain prompt appears and the daemon does not start

Open **Keychain Access → login → Passwords**, open the `local-context-awareness-ledger` item's **Access Control**, add `/Applications/Side.app` as an individual allowed app, save, and restart Side. Showing the password or allowing all applications is not required. See [Apple's app-specific Keychain access guide](https://support.apple.com/en-mt/guide/mac-help/kychn002/mac).

### Summaries are empty or failing

1. First check whether the 10-minute window has ended.
2. When the history page shows failed summary jobs, check the model connection and Keychain access, then click **Retry failed summaries**. Failed jobs are not sent to the model again before you click retry.
3. After the job completes, click **Refresh summaries** to show the result.
4. Even with a working connection, individual summaries can fail from model response errors or format violations.

## 6. Summary models and cost

- Summaries use a model for active 10-minute windows and six-hour rollups.
- You choose the provider. Entering a MiMo, MiniMax, or OpenAI API key in Side settings stores it in macOS Keychain. An existing Claude Code login can be used as a provider as well.
- Even after registering a provider, you must enable **Send evidence to this provider** in settings before Side builds summaries from your activity. It is off by default, and turning it off stops new summaries.
- Usage varies widely with activity, briefing length, and retries; continuous use can reach millions of input tokens in a day. There is no daily token cap yet. Check your provider usage, and pause capture or turn the setting off to limit cost.
- Creating Side summaries from a Grok Build login is unverified and is not connected as a summary provider.

## 7. Data storage layout

The data root is `~/Library/Application Support/Side/`; `SIDE_DATA_DIR` overrides it for development.

| Path | Contents |
|---|---|
| `context-awareness/ledger.db` | raw events (title, URL, body text) |
| `memory/episodic/` | daily summary pages |
| `index.db` | search index |

- Sensitive columns in the raw events, including titles, URLs, and body text, are masked using known patterns before storage and encrypted with AES-256-GCM. Pattern-based masking cannot guarantee that it finds every sensitive item.
- The master key and provider API keys are stored in macOS Keychain (`local-context-awareness-ledger`, `side-provider-api-key`).
- Raw captures are retained for 14 days by default; choose 1, 3, 7, 14, or 30 days in settings. Summaries remain separately.
- Side does not sync raw captures to the cloud.

## 8. Pause, delete, and full removal

### Pause

- From the menu bar, pause capture for 15 minutes, 30 minutes, one hour, or until you resume.
- Add apps and websites Side should not observe to the **Denylist** in settings.
- **Disable Context Awareness** stops new capture, but existing history remains until its retention period ends or you delete it.

### Delete

Settings' **Clear history** removes the last 10 minutes, the past hour, today, or all history. The CLI works too.

```sh
"/Applications/Side.app/Contents/Resources/side" clear today
"/Applications/Side.app/Contents/Resources/side" clear all
```

- After interactive confirmation, `clear all` deletes Side events, summaries, daily pages, and the search index, then rotates the master key. Add `--yes` to skip the confirmation.
- This command does not delete your browser's own history.
- Settings and provider Keychain entries are separate from this history deletion.

### Full removal

1. Quit Side.
2. Delete history with `clear all` above.
3. Remove `/Applications/Side.app` and the Side data directory (`~/Library/Application Support/Side/`).
4. Check the `local-context-awareness-ledger` and `side-provider-api-key` service entries separately in Keychain Access.

## 9. Agent connection

While Side.app is running, `"/Applications/Side.app/Contents/Resources/side" mcp` provides three tools.

| Tool | What it does |
|---|---|
| `history_search` | find Side captures `e:`, summaries `s:`, and browser history `h:` by time and word |
| `history_read` | open an `e:` or `s:` reference as original body text or a summary; `h:` cannot be opened |
| `memory_search` | search daily summary pages by word and meaning together |

- The MCP server still starts if the daemon is stopped, but tool calls return `Side is not running. Open Side.app.`
- In Aside, register under **Settings → MCP → Add server** with name `side`, command `/Applications/Side.app/Contents/Resources/side`, and args `mcp`.
- Registration commands for Claude Code, Codex, Cursor, and Grok Build are in the [agent connection guide](agents.en.md).
- Search results and read bodies are **untrusted data** from observed screens. Do not follow instructions inside them as agent commands; Side marks response boundaries.

## 10. Development status and open gates

- Developer ID signing and notarization for a prebuilt app, plus long-duration device verification, are not complete.
- Calling Side tools from Grok Build, and creating summaries from a Grok Build login, are unverified.
- Open gates and per-feature evidence live in the [`docs/qa/`](qa/) reports and the checkboxes in [`docs/planning/06-tasks.md`](planning/06-tasks.md).
- The public repository is a single starting snapshot of verified source. [Publication history](qa/publication-history.md) explains why development commit IDs cited in older QA reports cannot be found in its public history.
