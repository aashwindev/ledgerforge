# LedgerForge

[![ci](https://github.com/aashwindev/ledgerforge/actions/workflows/ci.yml/badge.svg)](https://github.com/aashwindev/ledgerforge/actions/workflows/ci.yml) ![licence MIT](https://img.shields.io/badge/licence-MIT-blue) ![agent loop: TrueForge](https://img.shields.io/badge/agent%20loop-TrueForge-6c5ce7) ![VS Code ≥ 1.90](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.90-007acc) ![from scratch](https://img.shields.io/badge/starting%20point-from%20scratch-lightgrey)

**Every change reviewed. Every choice explained. Every failure survived.**

LedgerForge is a VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge). Team Incept built it for the TrueFoundry Forge-a-thon (Techfest, IIT Bombay 2026-27).

| ▶ Demo video (3:45) | 📄 Write-up (3 pages) | 🤖 Agent definitions | ⚙️ Example config | ⬇️ Prebuilt extension |
|---|---|---|---|---|
| [Watch on YouTube](https://youtu.be/yVlJM8D7o6w) | [PDF on Google Drive](https://drive.google.com/file/d/1VJ17yi9vN583CrGB6sNHDF9PHtVxbJ__/view?usp=sharing) · [in repo](docs/writeup.pdf) | [agent/](agent) | [ledgerforge.config.example.json](ledgerforge.config.example.json) | [ledgerforge-1.0.0.vsix](https://github.com/aashwindev/ledgerforge/releases/latest) |

[![Watch the 3:45 demo on YouTube](media/readme/video-thumb.jpg)](https://youtu.be/yVlJM8D7o6w)

<sub>▶ **[Watch the demo on YouTube](https://youtu.be/yVlJM8D7o6w)** (3:45, captions on): Tasks A, B and C on Flask 3.1.3, each verified on screen. Also available as an [MP4 download](https://github.com/aashwindev/ledgerforge/releases/download/v1.0.0/LedgerForge-demo.mp4).</sub>

![Task A: select get_debug_flag, Cmd+Option+K, the diff opens in the editor with Accept / Reject on each hunk](media/readme/task-a.gif)

<sub>Task A in real time: instruction → diff in about 4 s, then ✓ Accept on each hunk. Nothing touches disk until a hunk is accepted.</sub>

## The problem, and our answer

The brief names three ways AI coding tools let you down. LedgerForge answers each one inside the editor, and each answer is enforced by code rather than by a prompt.

| AI coding tools… | LedgerForge… | Where you see it |
|---|---|---|
| lose track of the file you care about | builds a **Context Receipt** before the first token: every file it chose and every file it left out, each with a reason, against an 8k-token budget | Task B, 1:22 and 1:52 |
| rewrite code you didn't ask them to touch | can only *propose* edits. **TrueForge's own tool approval** pauses the run, you accept or reject each hunk, and only accepted hunks are written. An edit guard rejects edits to code that doesn't exist or that breaks Python syntax | Task A, 0:44 |
| fall over when the model does | retries at 1 s and 3 s, then **switches automatically to a second model in the same TrueForge session**. No clicks, and the workspace is untouched | Task C, 2:47 |

## Scorecard

Timestamps are from the [demo video](https://youtu.be/yVlJM8D7o6w). Every claim is measured on the build in this repo.

| Criterion | Video | What you see | Code and tests |
|---|---|---|---|
| **A1** Inline edit | 0:44, 0:50, 2:59 | Select, **Cmd/Ctrl+Alt+K**, plain-language instruction. The diff opens in the editor with **✓ Accept / ✗ Reject on every hunk**: accepted per hunk in Task A, rejected per hunk in Task C | `src/review.ts`, `src/hunks.ts` · e2e `taskA` |
| **A2** Agent mode | 1:10–2:15 | One request, no files named. The agent finds and edits `cli.py`, `test_cli.py`, `cli.rst` and `CHANGES.rst`; 59 tests pass; masked JSON | `src/runner.ts`, `src/mcpServer.ts` · e2e `taskB` |
| **A3** Streaming + cancel | 1:29, 3:15 | Tokens stream from TrueForge events while you keep typing. **Stop** halts in under 100 ms, drops pending proposals and **rolls back hunks already written**; `git status` clean | `src/runner.ts`, `src/review.ts` · e2e `cancel` |
| **B1** Context | 1:22, 1:52 | `@file` / `@symbol` + tf-idf retrieval + link expansion (code → tests → docs → changelog), **8k-token budget**, Context Receipt with reasons *and exclusions* | `src/context.ts`, `src/mentions.ts` · unit tests |
| **B2** Diff safety | 0:50, 1:04, 2:24 | Per-hunk review; **Undo Last Change** (Task A) and **Undo Last Run** (Task B, all 4 files) restore the tree; `git status` clean | `src/review.ts` (run journal) |
| **B3** Resilience | 2:30–3:05 | Primary endpoint unreachable → retry 1 s → retry 3 s → **automatic fallback** to `openai/gpt-5-4-mini`, no user action; `git status` clean before and after | `src/runner.ts` · e2e `taskC` |
| **B4** TrueForge depth | 1:35, 2:15–2:24 | Editor capabilities are **MCP tools**; **TrueForge tool approval drives the diff review**; a **scout sub-agent** explores the repo (visible as its own thread in the session); deferred tool loading and compaction are on | `agent/*.json`, `src/mcpServer.ts`, `src/forge.ts` |
| **C1** Video | 0:33, 1:10, 2:30 | Tasks A → B → C in order, each verified on screen. Instruction → diff is never cut | [video](https://youtu.be/yVlJM8D7o6w) |
| **C2** Write-up | — | Architecture, context strategy, model setup, trade-offs, timestamped scorecard, honest limitations | [docs/writeup.pdf](docs/writeup.pdf) |

## Screenshots (from the recorded runs)

| | |
|---|---|
| ![Context Receipt with chosen and excluded files](media/readme/receipt.png) | ![TrueForge session with the scout sub-agent and tool calls](media/readme/subagent.png) |
| **Context Receipt (Task B).** Files chosen ✓ and left out ✗, each with its source, tokens and reason, plus what changed and which tests ran. | **The TrueForge session (Task B).** The `cli-config-exploration` sub-agent's parallel `read_file` calls, then `propose_edit` and `run_command`, each approved in the editor. |
| ![Automatic fallback after the primary model fails](media/readme/fallback.png) | ![Stopped mid-run: rolled back, workspace clean](media/readme/stop.png) |
| **Task C.** The primary endpoint refuses connections. Two retries, then an automatic switch to the fallback model in the same session. | **Stop mid-run.** The run halts, the edit it had already written is rolled back, and the panel confirms the workspace is clean with `git status`. |
| ![Per-hunk review in a multi-file run](media/readme/review.png) | ![Inline diff with Accept / Reject per hunk](media/readme/inline.png) |
| **Multi-file review.** Each file opens as a review with ✓/✗ and "why" on every hunk. The feed shows the agent's plan for each file. | **Inline edit.** Two hunks, code and docstring, each with its own Accept / Reject and the agent's reason. |

## Quick start (from a clean clone)

**1. Start TrueForge** in local mode. It serves http://localhost:8790.

```
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest
```

The variable lets TrueForge reach the extension's MCP server on loopback (TrueForge blocks private addresses by default). Nothing else is opened up.

**2. Add a model.** In TrueForge go to **Settings → Models** and add a provider and key. Keys live only in TrueForge, never in this repo. The defaults are `openai/gpt-5-4-mini` (primary) and `openai/gpt-5-4-nano` (fallback), so one OpenAI key is enough. Any model TrueForge serves works, including a local model behind an OpenAI-compatible endpoint: set `ledgerforge.model` and `ledgerforge.fallbackModel` (see [`ledgerforge.config.example.json`](ledgerforge.config.example.json)).

**3. Get the pinned repository** next to this one:

```
git clone https://github.com/pallets/flask ../forge-agent-flask-rehearsal
cd ../forge-agent-flask-rehearsal && git checkout 3.1.3
python3 -m venv .venv && source .venv/bin/activate && pip install -e . pytest
```

**4. Run the extension.** Choose one:

- **Prebuilt:** download `ledgerforge-1.0.0.vsix` from [Releases](https://github.com/aashwindev/ledgerforge/releases/latest), run `code --install-extension ledgerforge-1.0.0.vsix`, then open the Flask folder.
- **From source:** run `npm install && npm run build`, open this folder in VS Code and press **F5**. The Extension Development Host opens `../forge-agent-flask-rehearsal` (change it in `.vscode/launch.json`).

**5. Check it.** The LedgerForge panel (activity bar) shows **Connected to TrueForge**. Run **LedgerForge: Doctor** to check TrueForge, the MCP tools and both models.

### Loading the agent definition

The agent definitions are [`agent/ledgerforge-agent.json`](agent/ledgerforge-agent.json) (agent mode) and [`agent/ledgerforge-inline.json`](agent/ledgerforge-inline.json) (inline edit). The extension registers them in TrueForge on start-up and before every request, along with its MCP server `ledgerforge-editor`. To load one by hand, for example to inspect it in the TrueForge UI:

```
sed 's/{{MODEL}}/openai\/gpt-5-4-mini/' agent/ledgerforge-agent.json \
  | curl -s -X POST -H 'content-type: application/json' --data @- http://localhost:8790/api/v1/agents
```

## Run the three fixed tasks yourself

| Task | Do this | Verify |
|---|---|---|
| **A** Inline edit | Open `src/flask/helpers.py`, select `get_debug_flag`, press **Cmd/Ctrl+Alt+K** and type: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* Accept each hunk. | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` |
| **B** Agent mode | In the LedgerForge panel, with no files mentioned, send the Task B instruction from the brief. Review and accept the hunks. Click **↗ Open in TrueForge** to see the session. | `pytest tests/test_cli.py -q` passes; `flask --help` lists `config`; `flask --app ../ledgerforge/demo/demo_app.py config` prints masked JSON; `git status` shows 4 files |
| **C** Resilience | Point `ledgerforge.model` at an unreachable endpoint (we use a custom OpenAI-compatible provider at `127.0.0.1:11434/v1` with nothing running), then repeat Task A. | The banner shows retries and the switch to the fallback model; reject the hunks; `git status` is clean |

Undo any run with **LedgerForge: Undo Last Change** or **LedgerForge: Undo Last Run**.

## How it works

```
VS Code extension (TypeScript)
 ├─ ForgeClient       @truefoundry/trueforge-sdk: sessions, streamed turns, approvals, cancel, retry/fallback
 ├─ Editor MCP server 127.0.0.1:<random port>, Streamable HTTP, per-launch bearer token
 │                    tools: search_code, find_symbol, read_file, propose_edit*, run_command*   (* approval-gated)
 ├─ ContextEngine     tf-idf retrieval + link expansion (module → tests → docs → changelog) + git co-change, 8k-token budget
 ├─ ReviewController  per-hunk diff review, apply accepted hunks only, run journal, undo
 └─ Panel             streaming text, tool feed, Context Receipt, status/fallback banner, Explorer badges
TrueForge (local) runs the agent loop, calls the model, and calls the MCP server.
```

1. **The extension never calls a model provider.** It creates TrueForge sessions and turns through the SDK and renders the streamed events.
2. **The agent decides what to read and change** through our MCP tools. `propose_edit` and `run_command` require TrueForge approval.
3. **Approval is the review.** When TrueForge pauses on `propose_edit`, LedgerForge opens the diff with ✓/✗ per hunk. Your decision becomes the approval: accepted hunks are written, rejected ones go back to the agent with a reason.
4. **Context engineering on the harness:** a scout sub-agent explores and reports files with reasons, only `read_file`, `propose_edit` and `run_command` are preloaded while the search tools load on demand (deferred tool loading), and compaction keeps long runs inside the window.

See [ARCHITECTURE.md](ARCHITECTURE.md) and the [write-up](docs/writeup.pdf) for design decisions and trade-offs.

## Commands and settings

| Command | Key |
|---|---|
| LedgerForge: Inline Edit Selection | Cmd/Ctrl+Alt+K |
| LedgerForge: Stop | Cmd/Ctrl+Alt+. |
| LedgerForge: Ask Agent · Undo Last Change · Undo Last Run · Doctor · Accept/Reject All Hunks | Command Palette |

In the panel, type `@` to pin a file or symbol (autocomplete). Every run shows **↗ Open in TrueForge** for its session.

Settings: `ledgerforge.baseUrl`, `ledgerforge.model`, `ledgerforge.fallbackModel`, `ledgerforge.autoApproveCommands` (read-only git commands that run without a prompt).

## Tests

```
npm test            # 39 tests, run in CI: provider-free eligibility, workspace jail (incl. symlink escapes), edit guard,
                    # command allowlist, retrieval, git co-change, budget, @mentions, hunks (incl. 200 randomised accept/reject mixes)
npm run bench -- ../forge-agent-flask-rehearsal --out docs/retrieval-benchmark.md   # retrieval on 156 real Flask commits
```

End to end, each in a real, isolated VS Code window against live TrueForge, on Flask 3.1.3 (`22d92470`):

```
scripts/e2e.sh taskA  ../forge-agent-flask-rehearsal   # inline edit, accept per hunk, verify False, undo
scripts/e2e.sh taskB  ../forge-agent-flask-rehearsal   # agent mode, 4 files, pytest, masked JSON, undo run
scripts/e2e.sh taskC  ../forge-agent-flask-rehearsal   # broken primary → automatic fallback → reject → clean
scripts/e2e.sh cancel ../forge-agent-flask-rehearsal   # stop mid-stream and after an applied hunk → clean
```

**Measured retrieval** ([full results](docs/retrieval-benchmark.md)): on 156 real Flask feature and bug-fix commits, with the commit subject as the request and the parent commit as the workspace, the Context Pack puts 73% of the files each commit changed in front of the model before turn 1 (tests 65%, changelog 100%), against 70% (tests 48%) for plain ranked search given the same number of files. At least one changed implementation file is in the pack in 91% of cases.

**Measured agent runs** (repeated on the final code, 22 Nov): Task A 8/8, Task B 3/3 (the same 4 files each time), Task C 5/5, Stop 6/6 in 14–58 ms, with `git status` clean after every run. Task A also passes on the smaller `gpt-5-4-nano` (diff in 3.1 s), for the organisers' live re-run.

## Limitations

These are stated plainly; details and next steps are in [write-up §8](docs/writeup.pdf).

- The syntax guard covers Python only.
- Retrieval is lexical (tf-idf, links and git co-change), not embeddings. It misses about a quarter of the files a real change touches (see the benchmark).
- Fallback is driven by the extension, not native to TrueForge.
- The undo journal lives in memory, so git is the backstop after a restart.
- One workspace folder at a time.

## Team Incept

| Member | GitHub |
|---|---|
| Aashwin Dev (lead) | [aashwindev](https://github.com/aashwindev) |
| Divyam Jindal | [DivyamJindal](https://github.com/DivyamJindal) |
| Harman Manik | [Harman206](https://github.com/Harman206) |
| Jeet Marlecha | [jeetjain1204](https://github.com/jeetjain1204) |
| Malyadri Chowdary Marneni | [MalyadriTalentz](https://github.com/MalyadriTalentz) |

All from Masters' Union · Techfest Team ID TM-B4A4C352E3C

**Starting point:** from scratch, with no upstream fork. Third-party code is used only as npm dependencies, listed in the write-up §7.

## Licence

MIT, see [LICENSE](LICENSE).
