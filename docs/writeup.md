# LedgerForge: TrueFoundry Forge-a-thon, Round 1

*Every change reviewed, every choice explained, every failure survived.* Repo: https://github.com/aashwindev/ledgerforge · Video: https://youtu.be/yVlJM8D7o6w

The brief names three ways AI coding tools fail: they lose track of the file you care about, rewrite code you did not ask them to touch, and edit symbols that do not exist. LedgerForge answers each one inside the editor:
- A **Context Receipt** shows which files the agent chose, and why.
- **Per-hunk review** runs on TrueForge's own tool approval, so nothing reaches disk unless you accept it.
- An **edit guard** rejects edits to code that does not exist before you ever see them.

Every write goes into a run journal, so you can undo one change or a whole run. Stop and model failures both leave `git status` clean.

## 1. Team

**Team Incept** (Techfest Team ID TM-B4A4C352E3C), all from Masters' Union: Aashwin Dev (team lead, @aashwindev), Divyam Jindal (@DivyamJindal), Harman Manik (@Harman206), Jeet Marlecha (@jeetjain1204) and Malyadri Chowdary Marneni (@MalyadriTalentz). Repository: https://github.com/aashwindev/ledgerforge

## 2. Starting point

From scratch (no upstream fork), MIT licence. Third-party code is used only as npm dependencies (section 7). The git history starts at the first commit of this repository.

## 3. Architecture on TrueForge

```
VS Code extension (TypeScript)
 ├─ ForgeClient       trueforge-sdk: sessions, streamed turns, approvals, cancel, session PATCH for fallback
 ├─ Editor MCP server 127.0.0.1:<random port>, Streamable HTTP, per-launch bearer token
 ├─ ContextEngine     @mentions + tf-idf + link expansion + git co-change, 8k budget → Context Receipt
 ├─ ReviewController  per-hunk diff review, apply accepted hunks only, run journal, undo
 └─ Panel             streaming text, tool feed, Context Receipt, status banner, Explorer badges
TrueForge (local mode) runs the agent loop, calls the model, calls our MCP server
```

**The loop runs in TrueForge.**
- The extension is a TrueForge client. It creates sessions and turns with `@truefoundry/trueforge-sdk` and renders the streamed events: `model.message.delta` for text, and tool and approval events for the feed.
- It never calls a model provider.
- The agent definitions are committed in `agent/ledgerforge-agent.json` and `agent/ledgerforge-inline.json`. The extension registers them through TrueForge's agents API, together with its MCP server `ledgerforge-editor`.

| MCP tool | What it does | Gate |
|---|---|---|
| `search_code`, `find_symbol` | ranked search; definitions and references | none |
| `read_file` | reads the live editor buffer, including unsaved changes | none |
| `propose_edit(path, old_text, new_text, reason)` | writes **only the hunks the user accepted** | TrueForge approval |
| `run_command` | no shell; allowlist of test runners (pytest, python, node, npm test, go test, cargo test) and read-only git | TrueForge approval |

All tools are confined to the workspace, following symlinks to check where they really lead, and refuse `.git` and secrets files. The agent, not the extension, decides what to read and change.

**TrueForge approval drives the review.** `propose_edit` and `run_command` are in the agent's `require_approval_for_tools`. When TrueForge emits `tool.approval_required`, the turn pauses and:
1. A guard checks the edit. `old_text` must occur exactly once, which catches invented code, and Python must still parse.
2. The edit opens as a diff with ✓/✗ on every hunk.
3. If you accept any hunk, we answer `allow`. TrueForge then calls `propose_edit`, which writes only those hunks and tells the agent which were applied and which were rejected.
4. If you reject every hunk, we answer `deny` with the reason.

Unknown approval requests are denied (fail closed).

**Harness features, and why.**
- **Subagents.** The agent must start one exploration subagent, which searches and reads, then returns ranked files with reasons. The root agent's context stays small, and the subagent shows as its own thread in the session.
- **Deferred tool loading.** Only `read_file`, `propose_edit` and `run_command` are preloaded. The search tools load on demand through `call_tool`, and our approval handler unwraps `call_tool`, so an edit sent that way still gets reviewed.
- **Compaction and large-tool-response handling** keep long Task B runs inside the context window.
- We did not use Code Mode or skills: both need the sandbox, and our tools must run inside the editor.

**Stop.** Stop aborts the client stream, calls `sessions.cancel`, closes pending reviews and rolls back the run's applied hunks from the journal. Measured: 24–72 ms, then `git status` clean. The editor never blocks, because everything in the extension host is asynchronous.

**Fallback.**
- **Triggers:** a turn error, no first event within 20 s, or no events for 150 s (time spent reviewing doesn't count).
- **Retries:** LedgerForge retries the primary model after 1 s, then after 3 s.
- **Switch:** it then `PATCH`es the **same session** to the fallback model and sends a continuation turn, so history and accepted edits carry over.
- **If every model fails,** the run is rolled back.

| Design decision | Why | Trade-off |
|---|---|---|
| Review inside TrueForge's approval pause | one source of truth: the session records every decision | the agent waits while you review (the stall timer is paused) |
| Apply accepted hunks on the tool call, not before | a rejected hunk never touches disk | an edit can come back partly applied; the agent is told exactly which hunks |
| Same-session fallback via `PATCH` | context and accepted edits survive the switch | the failed turn stays in the session as an error |
| Outlines in the pack, full files on demand | 10 files fit in 3k tokens | the agent must call `read_file` before editing |

## 4. How context is selected

1. **@mentions.** The panel autocompletes files and symbols. A mentioned file is pinned whole. A mentioned symbol is pinned as its full definition, including decorators. Mentions come first and count against the budget.
2. **Retrieval before turn 1.** This works with any model, even one with weak tool use. Files are scored by saturating term frequency × inverse document frequency, doubled when a request term matches the file name (`cli` → `cli.py`).
3. **Link expansion.** The top 2 implementation files pull in `tests/test_<module>.py`, `docs/<module>.rst` and the changelog. This is how Task B finds the test, docs and changelog without being told. **Git co-change** adds the test file and docs page that most often changed in the same commits, for projects that do not name tests after modules (Flask tests `app.py` in `test_basic.py`). The receipt says so: "changed together with src/flask/app.py in 24 of its last 127 commits".
4. **8,000-token budget.** Outlines (signatures for code, headings for docs) are packed best first. Anything that ranks lower or doesn't fit is listed as excluded, with its reason. In Task B the pack uses 2,991 / 8,000 tokens, with 10 files in and 5 out. For example, `docs/api.rst` is out as a "weaker match (json, secret, prints) than the files above".
5. **Scout subagent.** It checks the pack with the search tools and returns ranked files with reasons, so the root agent never sees raw search output.
6. **Context Receipt.** The panel shows every row (✓/✗, source, tokens, reason) with a budget meter, and marks files as the agent reads them. Explorer badges show 👁 read, ✎ proposed and ✓ applied.

**Measured** (`npm run bench`, `docs/retrieval-benchmark.md`). On 156 real Flask feature and bug-fix commits, with the commit subject as the request and the parent commit as the workspace, the pack puts **73% of the files each commit changed** in front of the model before turn 1: implementation 71%, tests 65%, docs 56%, changelog 100%. Plain ranked search with the same number of files gets 70% (tests 48%). Co-change raised tests from 54% to 65% and was added after the video was recorded; Task B's pack is identical file for file.

**Trade-offs.**
- Lexical scoring is fast, explainable and needs no dependencies, but it misses synonyms.
- Link expansion relies on naming conventions; co-change needs git history.
- Outlines keep the pack small; the agent reads full files itself.

## 5. Model setup

| Role | Model | Where it ran | Approx. cost (TrueForge usage) |
|---|---|---|---|
| Primary | `openai/gpt-5-4-mini` | OpenAI API through local TrueForge 0.185.1 | Task A ≈ $0.003; Task B $0.06–0.34, typically $0.15 (≈ 85% cached input) |
| Fallback | `openai/gpt-5-4-nano` (Task C: `gpt-5-4-mini`) | same | Task A < $0.001 |
| Task C primary | `local-ollama/qwen3-coder`, a custom OpenAI-compatible provider at `127.0.0.1:11434/v1` with no server running | unreachable (`ECONNREFUSED`) | $0 |

- **Prices:** $0.75 input, $0.075 cached input and $4.50 output per 1M tokens. All development and rehearsals together cost a few dollars.
- **To switch models:** add any provider in TrueForge **Settings → Models**, then set `ledgerforge.model` and `ledgerforge.fallbackModel` in VS Code (example: `ledgerforge.config.example.json`). **LedgerForge: Doctor** checks that both models answer.
- **Any model:** nothing in the extension is provider-specific. For the organisers' live re-run, Task A also passes on `gpt-5-4-nano`, with the diff in 3.1 s.

## 6. Scorecard

| Row | Time | Claim (measured on the final build) |
|---|---|---|
| A1 Inline edit | 0:44, 0:50, 2:59 | Task A: select, Cmd/Ctrl+Alt+K, diff in about 4 s with ✓ per hunk (A) and ✗ per hunk (C); prints `False` |
| A2 Agent mode | 1:10–2:15 | Task B: `cli.py`, `test_cli.py`, `cli.rst` and `CHANGES.rst` found and edited unprompted; 59 tests pass; masked JSON |
| A3 Streaming + cancel | 1:29, 3:15–3:27 | tokens stream live; typing works during a run; Stop halts in under 100 ms and rolls back the accepted hunk; `git status` clean |
| B1 Context | 1:22, 1:52 | Context Receipt in Task B: 10 chosen and 5 excluded files with reasons, 2,991 / 8,000-token meter |
| B2 Diff safety | 0:50, 1:04, 2:24 | per-hunk review; Undo Last Change (A) and Undo Last Run (B) restore files, `git status` clean |
| B3 Resilience | 2:30–3:05 | endpoint unreachable → retries at 1 s and 3 s → automatic fallback in the same session, no clicks; `git status` clean |
| B4 TrueForge | 1:35, 2:15–2:24 | approval pauses drive the review (1:35); session shows `ledgerforge-editor` tool calls, approvals and the subagent's own thread (2:20) |
| C1 Video | 0:33, 1:10, 2:30 | A → B → C in order, each verified on screen |
| C2 Write-up | — | this document |

## 7. Tools used

- **Libraries and tools:** VS Code Extension API, TrueForge and `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `zod`, `diff`, esbuild, TypeScript, Node's test runner.
- **Tests:** 39, run in CI. They cover the workspace jail (including symlink escapes), edit guard, command allowlist, retrieval, git co-change, budget, @mentions and hunks (including 200 randomised accept/reject mixes). Eligibility tests fail the build if `src/` names a model provider endpoint, imports a provider SDK or contains a key.
- **End-to-end tests:** four scripts drive a real VS Code window against live TrueForge and check `git status`, pytest and the Flask CLI. Repeated on the final code (22 Nov): **Task A 8/8, Task B 3/3** (the same 4 files each time, about 55 s), **Task C 5/5**, **Stop 6/6** (14–58 ms). `git status` was clean after every run.
- **AI coding assistant:** Claude Code (Claude Opus 5.5).

## 8. Known limitations and what we would do with another month

- **The syntax check is Python-only**, the pinned repository's language. Other languages still get the exact-match guard and per-hunk review. Next: tree-sitter for every language.
- **Retrieval is lexical.** The pack holds 73% of the changed files before turn 1 (benchmark above); `search_code` and `find_symbol` remain available to the agent for the rest. Next: embeddings combined with BM25, and links from the import graph.
- **Fallback lives in the extension, not in TrueForge.** It keeps the same session and history; the failed turn stays in the session log as an error. Next: a TrueForge PR adding native per-agent fallback models.
- **Some rules are enforced by the extension rather than the agent definition**, because models do not always follow instructions: a run that edits without testing is asked once more, and a rejected inline edit cannot be proposed again in that run (seen once in 3 Task C runs before we added it). Next: move them into the agent definition as far as TrueForge allows.
- **Undo history lasts for the editor session.** After a restart, git is the safety net. Next: persist the run journal in workspace storage.
- **One workspace folder at a time, and a multi-file change is reviewed one file tab at a time.** Next: a single review view for the whole run.
