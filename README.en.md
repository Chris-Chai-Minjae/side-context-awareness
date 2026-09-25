# Side Work Memory

**App name: Side**

**[한국어](README.md) · [English](README.en.md)**

<img src="docs/assets/side-logo.png" alt="Side logo" width="88">

**A Mac menu bar app that keeps clues about pages and work you saw so you can find them later.**

Side keeps readable text, titles, and addresses from allowed browser tabs and Mac app windows on this Mac. You can search later by time and word. Side is an independent open-source (MIT) project.

- **Raw records stay on this Mac.** They are stored in `~/Library/Application Support/Side/` and are not automatically sent to the cloud. Sensitive values are masked and encrypted before they are saved.
- **Summaries are optional.** Capture and local search work without a model. A model provider may charge for usage when you enable summaries.
- **You decide what is remembered.** Password fields are excluded at the source, and you control the exclusion list, pausing, retention, and deletion from settings.

> **Distributed as source code.** There is no ready-to-run app download yet. Each user builds Side on their own Mac. → [Install](#install)

**Quick links** · [Beginner's guide](https://chris-chai-minjae.github.io/side-work-memory/side-for-beginners.en.html) · [Detailed manual](docs/manual.en.md) · [Landing page (한국어 · English)](https://chris-chai-minjae.github.io/side-work-memory/) · [Agent connection guide](docs/agents.en.md) · [MIT License](LICENSE)

## What can you do with it?

1. **Search what you saw earlier.** Ask "Where did I see that yesterday?" Side can find body text if it captured readable content. A browser-visit-only result has a title, address, and visit time, but no page body.
2. **Automatic activity briefings.** With summaries enabled, Side condenses 10-minute windows and six-hour rollups into a dated timeline of what you did.
3. **Search through an AI agent (MCP).** Register `side mcp` separately in Cursor, Claude Code, Codex, or another client so it can search records Side kept. Installing the app does not connect it automatically.
4. **Read screens without text (on-device OCR).** For graphic apps and PDFs where the accessibility API returns no text, Side extracts on-screen characters locally with screen recording permission. Images are not stored.

## Why it is different

| Area | What it means |
|---|---|
| Free and open source | Released under the MIT License and runs on your Mac without a separate Side server. Your chosen summary provider or connected agent may incur usage. |
| Privacy | Raw captures stay on this Mac and are not automatically synced to the cloud. Enabling summaries sends masked activity briefings to your chosen provider. |
| Optional model use | Side's own summary-model use is optional. Without summaries, capture and search still run locally. |
| Agent connection | Register Side MCP in a client to search local records. Check important facts against the original source. |
| Control | Password fields are excluded at the source, plus an app and website exclusion list, 15-minute to 1-hour pauses, and per-period or full history deletion. |

Capture and search run on this Mac. External-model summaries and MCP agent connections are separate choices.

## Everyday questions

Ask a connected agent in your own words. Answers depend on what Side actually recorded.

1. **Find a page you saw earlier:** “Find the restaurant booking page I saw yesterday evening. What was its title and address?”
2. **Resume after a meeting:** “What document was I reading before the meeting? Give me a clue about where I left off.”
3. **Review today's activity:** “What did I work on this morning?” A daily summary can help if one was actually created.
4. **Compare two documents:** “How does the guide I just read differ from the draft I wrote?” Both documents need readable content in Side's records.
5. **Find an error-fix page:** “Find the error-fix page I opened earlier. What was its address?”

You can also revisit sources for legal work or reconstruct project time for a timesheet. Check legal quotations, dates, amounts, OCR-read figures, and final billable time against the original source and your actual work records. Side cannot retrieve a screen it missed or a record that was deleted.

## How it works

![Four steps: record active Mac windows on the device, then search their sources through a connected agent](docs/assets/side-flow.png)

1. **Capture** Side records readable content from active windows you have allowed, on this Mac. You can exclude apps and websites or pause capture.
2. **Summarize (optional)** Configure a summary provider and enable **Send evidence to this provider** to summarize 10-minute activity and six-hour rollups. Masked briefings go to that provider and may incur usage.
3. **Search** Find what you saw and when by time, word, or topic. For example, "find the restaurant reservation page I saw yesterday evening."
4. **Connect an agent (separate choice)** Register Side as an MCP tool separately in Claude Code, Codex, Cursor, **Aside**, or another client to search local records. Side.app must be running. Aside is one compatible client.

Side does not record your screen continuously. Windows without permission, excluded apps and websites, and password fields are not recorded.

## Install

Side is **distributed as source code only.** You do not download a finished app; each user builds it on their own Mac. Developer ID signing and notarization for a prebuilt app, plus long-duration device testing, are still pending ([development status](docs/qa/)).

Requirements: macOS 14 or later, Bun, Xcode Command Line Tools, and a SQLite dylib with FTS5 and extension loading. The build downloads and bundles the MiniLM model. Homebrew is not required on the Mac that runs the app.

```sh
git clone https://github.com/Chris-Chai-Minjae/side-work-memory.git
cd side-work-memory
bun install --frozen-lockfile
bun run build

ditto apps/side-mac/.build/release/Side.app /Applications/Side.app
open /Applications/Side.app
```

Quit any running app with the same name before copying. Side appears in the menu bar rather than the Dock. On first launch, grant capture permissions and enable Context Awareness. Summary provider setup can be skipped; capture and search still work without it.

Build options (`SIDE_SQLITE_LIBRARY`, `SIDE_MODEL_CACHE_SOURCE`), re-granting permissions and Keychain access after a rebuild, and diagnostic commands are in the [detailed manual](docs/manual.en.md).

## macOS permissions

| Permission | How Side uses it |
|---|---|
| Accessibility | Read the active window title, accessibility text, and selected text |
| Input Monitoring | Observe input events to construct typed sentences; password fields and individual keystrokes are not stored |
| Screen Recording | Use on-device OCR to read screen text when readable accessibility text is unavailable; images are not stored |
| Browser Automation | Read the current tab URL in supported browsers. **Already allowed** means no new approval prompt is needed. |
| Authorize Keychain | Check read access to summary-provider API keys saved in Side. This is separate from the local record-encryption key and Codex or Claude CLI logins. |

Screen Recording is optional. Open **Settings → Permissions** from the menu bar to check each permission separately and jump to the matching macOS settings pane. Diagnostic commands and recovery steps for missing permissions or empty summaries are in the [detailed manual](docs/manual.en.md).

For summaries, you can set MiMo 2.6 Pro as primary and MiniMax M3 as fallback. In addition to API-key providers, you can sign in to the official Codex CLI with `codex login` for ChatGPT and select **OpenAI (Codex login)** in Side, or use `claude auth login` and select the Claude Code login option. These are summary-provider choices, separate from MCP registration. Use a CLI login for Side summaries at your own risk; check each service's terms and usage limits. There is no need to open CLI login-token files. The Codex option currently cannot use a login stored only in Keychain.

## Privacy

Side runs on this Mac. Captured records, summaries, and the search index are all stored in `~/Library/Application Support/Side/`. Sensitive raw values such as titles, URLs, and body text are masked using known patterns and then encrypted, and the encryption key and model API keys are separate items in macOS Keychain. Raw captures are not synced to the cloud. **Summaries and daily pages remain readable text in local files.**

You choose what is kept and for how long.

- **Pause** stop capture for 15 minutes, 30 minutes, one hour, or until you resume.
- **Exclusions** list apps and websites Side should not observe. Password input fields are never recorded.
- **Retention** raw captures last 14 days by default; choose 1, 3, 7, 14, or 30 days.
- **Delete** clear the last 10 minutes, the past hour, today, or all history. Clearing all rotates the encryption key.
- **Disable** turning Context Awareness off stops new capture; existing history remains until retention ends or you delete it.

Storage layout, deletion commands, summary model setup, and full uninstall steps are in the [detailed manual](docs/manual.en.md).

## Connect an agent

While Side.app is running, `side mcp` provides three tools: `history_search`, `history_read`, and `memory_search`. Register Side in each client; it does not connect automatically.

```sh
claude mcp add --scope user side -- "/Applications/Side.app/Contents/Resources/side" mcp
```

Per-client setup and tool usage are in the [agent connection guide](docs/agents.en.md). The MCP server starts even when the daemon is stopped, but tool calls return `Side is not running. Open Side.app.`

## Documentation

- **[Detailed manual](docs/manual.en.md)** build options, permission and rebuild recovery, storage layout, deletion and full uninstall, summary models and cost
- [Beginner's guide](https://chris-chai-minjae.github.io/side-work-memory/side-for-beginners.en.html) plain-language walkthrough with example questions
- [Agent connection guide](docs/agents.en.md) Claude Code, Codex, Cursor, Grok Build, and Aside setup
- [Landing page](https://chris-chai-minjae.github.io/side-work-memory/) Korean and English overview
- [Development status](docs/qa/) QA reports and open gates · [Publication history](docs/qa/publication-history.md)

The source is released under the [MIT License](LICENSE).
