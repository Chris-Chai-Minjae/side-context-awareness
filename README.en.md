# Side

**[한국어](README.md) · [English](README.en.md)**

<img src="docs/assets/side-logo.png" alt="Side logo" width="88">

Side is an open-source macOS menu bar app that records readable content from active browser and app windows on your device, so you can later search by time, word, or topic. It independently implements Aside Context Awareness for macOS and works without installing Aside or having a Max plan. You and connected agents can search the history with its sources. Daily summaries require a configured provider and your consent to send activity briefings. Build Side on your own Mac from source; a prebuilt app is not currently distributed.

**[Beginner's guide in English](https://chris-chai-minjae.github.io/side-context-awareness/side-for-beginners.en.html)** · **[Side landing page (한국어 · English)](https://chris-chai-minjae.github.io/side-context-awareness/)**

The source code is available under the [MIT License](LICENSE). The beginner's guide includes usage instructions and simple example questions; the landing page explains how Side works and what installation requires in Korean and English.

## How can Side help?

![Four steps: record active Mac windows on the device, then search their sources through a connected agent](docs/assets/side-flow.png)

1. Side records readable content from active windows for which you have granted permission. You can exclude apps and websites or pause recording.
2. You can search for what you saw and when. If you configure a summary provider and consent to sending evidence, Side also creates daily summaries.
3. For example, you can ask, “Find the restaurant reservation page I saw yesterday evening.” If a verifiable record exists, Side provides the time you viewed it, its title, and its URL.
4. Register Side as an MCP tool in Claude Code, Codex, Cursor, **Aside**, or another agent to search the same records there. Side.app must be running.

This repository is still under development. For now, each user builds and installs the app from source on their own Mac. Developer ID signing and notarization for a prebuilt app, along with long-duration verification on a physical Mac, are not complete. The remaining release checks are recorded separately in [`docs/qa/`](docs/qa/).

The public repository is a single starting snapshot of verified source. [Publication history](docs/qa/publication-history.md) explains why development commit IDs cited in older QA reports cannot be found in its public Git history.

## Install and get started

You need macOS 14 or later. Building from source requires Bun, Xcode Command Line Tools, and a SQLite dylib that supports FTS5 and extension loading. The build script looks for Homebrew SQLite paths; set `SIDE_SQLITE_LIBRARY` to use a dylib at another build path. The MiniLM model is downloaded and bundled into the app during the build. If you already have a populated cache, specify it with `SIDE_MODEL_CACHE_SOURCE`. Homebrew is not required on the Mac that runs the app.

```sh
git clone https://github.com/Chris-Chai-Minjae/side-context-awareness.git
cd side-context-awareness
bun install --frozen-lockfile
bun run build
```

Copy the built app to `/Applications/Side.app` and open it. If an app with that name is already running, quit it first.

```sh
ditto apps/side-mac/.build/release/Side.app /Applications/Side.app
open /Applications/Side.app
```

Side appears in the menu bar rather than the Dock. On first launch, grant capture permissions during onboarding and enable Context Awareness. You can skip summary provider setup; capture then works, but summaries wait for a provider. In the menu bar settings, manage retention, excluded apps and websites, the summary model, and agent connections. You can select 한국어 or English as the display language in settings.

Local builds use ad hoc signing. After you rebuild and replace the app, macOS may not apply its previous Accessibility, Input Monitoring, and Screen Recording permissions to the new build. If that happens, remove the old `Side` entries from the corresponding lists under System Settings → Privacy & Security, then add `/Applications/Side.app` again. Developer ID signing and notarization required to distribute a prebuilt app to others remain a separate release gate. Check the current status in the [`docs/qa/`](docs/qa/) reports and the checkboxes in [`docs/planning/06-tasks.md`](docs/planning/06-tasks.md).

## macOS permissions

| Permission | How Side uses it |
|---|---|
| Accessibility | Read the active window title, accessibility text, and selected text |
| Input Monitoring | Observe input events to construct typed sentences; password fields and individual keystrokes are not stored |
| Screen Recording | Use on-device OCR to read screen text when readable accessibility text is unavailable; images are not stored |
| Automation | Read the current tab URL in supported browsers |

Screen Recording is optional. You must approve Side in the macOS permission dialog for the corresponding observation feature to work. Check permission status and diagnostics in menu bar **Settings…** or with:

```sh
"/Applications/Side.app/Contents/Resources/side" doctor
```

## Data and privacy

The data root is `~/Library/Application Support/Side/`; you can specify a development path with `SIDE_DATA_DIR`. `context-awareness/ledger.db` holds raw events, `memory/episodic/` holds daily summaries, and `index.db` holds the search index. Before storage, Side masks sensitive fields in the raw events, including titles, URLs, and body text, using known patterns, then encrypts them with AES-256-GCM. Pattern-based masking cannot guarantee that it finds every sensitive item. The master key and provider API keys are stored in macOS Keychain. Summaries and daily pages remain as plaintext in local files.

Raw captures are retained for 14 days by default; you can choose 1, 3, 7, 14, or 30 days in settings. Summaries remain separately. Side does not sync raw captures to the cloud. It sends masked 10-minute window briefings and six-hour rollup briefings to the displayed provider host only when **Send evidence to this provider** is enabled for the summary provider. This setting is off by default. A connected agent may pass MCP results to its own model, so check that agent's data policy as well. Side cannot completely block MCP access by another process running under the same macOS user account.

## Pause and delete

From the menu bar, you can pause capture for 15 minutes, 30 minutes, one hour, or until you resume it. Add apps or websites that Side should not observe to **Denylist** in settings. **Disable Context Awareness** stops new capture, but existing history remains until its retention period ends or you delete it yourself.

In settings, **Clear history** can delete the last 10 minutes, the past hour, today, or all history. You can also use the CLI:

```sh
"/Applications/Side.app/Contents/Resources/side" clear today
"/Applications/Side.app/Contents/Resources/side" clear all
```

After interactive confirmation, `clear all` deletes Side events, summaries, daily pages, and the search index, and rotates the master key. Add `--yes` to skip the interactive confirmation. This command does not delete your browser's own history. Settings and provider Keychain entries are separate from this history deletion. To uninstall Side completely, first quit Side and clear its history, then remove the app and the Side data directory. Also check the `local-context-awareness-ledger` and `side-provider-api-key` service entries separately in Keychain Access.

## Connect an agent

While Side.app is running, `"/Applications/Side.app/Contents/Resources/side" mcp` provides `history_search`, `history_read`, and `memory_search`. Register Side under **Settings → MCP → Add server** in Aside to ask its agent to find Side records. See the [agent connection guide](docs/agents.en.md) for Claude Code, Codex, Cursor, and Aside setup. The MCP server still starts if the daemon is stopped, but tool calls return `Side is not running. Open Side.app.`.
