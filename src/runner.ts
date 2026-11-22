import * as vscode from 'vscode';
import { AgentKind, Decision, ForgeClient, PendingCall, TurnResult, loadAgentDef } from './forge';
import { ReviewController, ReviewItem, editKey } from './review';
import { EditArgs, runCommand, validateEdit } from './tools';
import { Workspace } from './workspace';
import { ContextPack, buildContextPack } from './context';

// One run = one user request. Owns cancellation, retry/fallback and rollback,
// so a stopped or failed run never leaves half-applied edits behind.

export interface RunUI {
  begin(label: string): void;
  text(delta: string): void;
  log(kind: 'tool' | 'read' | 'guard' | 'subagent' | 'info' | 'session', text: string, url?: string): void;
  status(text: string, tone: 'info' | 'warn' | 'error' | 'ok'): void;
  end(): void;
  /** Context Receipt: what the editor packed before the turn, and (via receiptRead) what the agent read. */
  receipt?(pack: ContextPack): void;
}

const BACKOFF_MS = [1000, 3000];
const FIRST_EVENT_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 150_000; // longer than the 120 s run_command timeout

export class Runner {
  private active?: { abort: AbortController; sessionId?: string; attemptId: string; runId: string; kind: AgentKind; allowCommands: boolean; approved: Set<string>; ranTests: boolean; inlineDeclined?: boolean };
  private seq = 0;

  constructor(
    private forge: ForgeClient,
    private ws: Workspace,
    private review: ReviewController,
    private agentDir: string,
    private ui: RunUI,
  ) {}

  get busy() { return !!this.active; }
  get attemptId() { return this.active?.attemptId ?? 'none'; }

  /** Checked by the run_command MCP handler: only commands the user approved in this run (or read-only ones) execute. */
  commandAllowed(line: string): boolean {
    const a = this.active;
    const ok = isAutoApproved(line) || (!!a && (a.allowCommands || a.approved.delete(line)));
    if (ok && a && /^(pytest|python3? -m (pytest|unittest)|npm (run )?test|node --test|go test|cargo test)\b/.test(line)) a.ranTests = true;
    return ok;
  }

  async start(kind: AgentKind, message: string, label: string): Promise<void> {
    if (this.active) { vscode.window.showWarningMessage('LedgerForge is already running. Press Stop first.'); return; }
    const cfg = vscode.workspace.getConfiguration('ledgerforge');
    const models = [cfg.get<string>('model'), cfg.get<string>('fallbackModel')].filter((m): m is string => !!m && !m.startsWith('<'));
    const runId = `run-${++this.seq}`;
    const abort = new AbortController();
    this.active = { abort, runId, attemptId: runId, kind, allowCommands: false, approved: new Set(), ranTests: false };
    this.ui.begin(label);
    let input = message;
    if (kind === 'ledgerforge-agent') {
      const pack = await buildContextPack(this.ws, message);
      this.ui.receipt?.(pack);
      input = pack.message;
    }

    try {
      // One TrueForge session per run. Retries and the fallback continue in it (model swapped via PATCH),
      // so the conversation and the user's accepted edits survive a model failure.
      let session: string | undefined;
      let lastError = '';
      for (let m = 0; m < models.length; m++) {
        const model = models[m];
        const spec = loadAgentDef(this.agentDir, kind, model).manifest;
        const tries = m === 0 ? BACKOFF_MS.length + 1 : 1;
        for (let t = 0; t < tries; t++) {
          if (abort.signal.aborted) return;
          this.active.attemptId = `${runId}#${m}.${t}`;
          this.ui.status(m
            ? `Switched automatically to fallback model ${model} (${models[0]} failed: ${lastError}). Working in the same TrueForge session…`
            : `${model}${t ? ` (retry ${t}/${BACKOFF_MS.length})` : ''}: working…`, m ? 'warn' : 'info');
          let r: TurnResult | undefined;
          if (session) {
            try {
              if (/no (response|event)/.test(lastError)) await this.forge.cancel(session); // a stalled turn may still be running
              await this.forge.updateSessionAgent(session, spec);
              r = await this.attempt(spec, `The previous attempt failed (${lastError}). You are now running on ${model}. Continue the original request above from where it stopped. Edits the user already accepted are on disk; read files again before changing them.`, abort.signal, session);
            } catch (e) {
              this.ui.log('info', `Could not continue session ${session} (${(e as Error).message}); starting a new one.`);
              await this.review.discardAll();
              await this.review.undo(runId, true);
              session = undefined;
            }
          }
          if (!r) r = await this.attempt(spec, input, abort.signal);
          session = this.active.sessionId ?? session;
          if (abort.signal.aborted || r.status === 'cancelled') return;
          // Never finish untested: if this run wrote files but never ran tests, ask once more in the same session.
          if (r.status === 'done' && kind === 'ledgerforge-agent' && !this.active.ranTests && this.review.lastRunId() === runId && session) {
            this.ui.status('Edits applied but no tests were run: asking the agent to run them.', 'info');
            r = await this.attempt(spec, 'You applied edits but did not run any tests. Run the relevant tests now with run_command (the test runner this project uses, on the test file you changed). If they fail, fix the code with propose_edit and run them again. Then give the final summary.', abort.signal, session);
            if (abort.signal.aborted || r.status === 'cancelled') return;
          }
          if (r.status === 'done') {
            this.ui.status(`Done on ${model}${m ? ' (fallback, same TrueForge session)' : ''}.`, 'ok');
            return;
          }
          await this.review.discardAll();
          const why = lastError = shortError(r.error);
          if (t < tries - 1) {
            this.ui.status(`${model} failed: ${why}. Retrying in ${BACKOFF_MS[t] / 1000}s…`, 'warn');
            this.ui.log('info', `⚠ ${model} failed (${why}); retry ${t + 1}/${BACKOFF_MS.length} in ${BACKOFF_MS[t] / 1000}s`);
            await sleep(BACKOFF_MS[t], abort.signal);
          } else if (m < models.length - 1) {
            this.ui.status(`${model} failed: ${why}. Switching automatically to fallback model ${models[m + 1]} in the same TrueForge session (history kept).`, 'warn');
            this.ui.log('info', `↪ Switching automatically to fallback model ${models[m + 1]} (same TrueForge session, no user action)`);
          } else {
            // Nothing worked: leave the workspace exactly as it was before the run.
            const undone = await this.review.undo(runId, true);
            this.ui.status(`All configured models failed (last: ${why}). ${undone.length ? `Rolled back ${[...new Set(undone)].join(', ')}.` : 'No files were changed.'} Check TrueForge Settings → Models.`, 'error');
          }
        }
      }
      if (!models.length) this.ui.status('No model configured. Set ledgerforge.model in Settings.', 'error');
    } finally {
      this.active = undefined;
      this.ui.end();
    }
  }

  /** Stop: abort the stream, cancel the TrueForge turn, drop proposals, roll back this run's writes. */
  async stop(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.abort.abort();
    if (a.sessionId) void this.forge.cancel(a.sessionId);
    await this.review.discardAll();
    const undone = await this.review.undo(a.runId, true);
    const clean = (await runCommand(this.ws, 'git', ['status', '--porcelain'])).split('\n').slice(2).join('').trim() === '';
    this.ui.status(`Stopped.${undone.length ? ` Rolled back ${undone.join(', ')}.` : ' Nothing was written.'}${clean ? ' Workspace clean ✓ (git status)' : ''}`, 'ok');
  }

  private async attempt(spec: any, message: string, signal: AbortSignal, sessionId?: string): Promise<TurnResult> {
    // Per-attempt controller so a stalled model can be abandoned without stopping the run.
    const own = new AbortController();
    const onAbort = () => own.abort();
    signal.addEventListener('abort', onAbort);
    let sawEvent = false;
    let stalled = '';
    const stall = setTimeout(() => { if (!sawEvent) { stalled = `no response from the model within ${FIRST_EVENT_TIMEOUT_MS / 1000}s`; own.abort(); } }, FIRST_EVENT_TIMEOUT_MS);
    // Mid-stream watchdog: the stream went silent while the model was working (not while the user reviews).
    let idle: NodeJS.Timeout | undefined;
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => { stalled = `no event from the model for ${IDLE_TIMEOUT_MS / 1000}s`; own.abort(); }, IDLE_TIMEOUT_MS); };
    try {
      const r = await this.forge.runTurn(spec, message, {
        onText: (d, thread) => { if (thread === 'main') this.ui.text(d); },
        onEvent: e => {
          if (sawEvent) kick();
          if (e.type === 'turn.created') { sawEvent = true; kick(); const sid = this.active?.sessionId ?? ''; this.ui.log('session', `TrueForge session ${sid}`, `${this.forge.baseUrl}/sessions/${sid}`); }
          if (e.type === 'model.message.delta') sawEvent = true;
          if (e.type === 'thread.created') this.ui.log('subagent', `Subagent started: ${e.title ?? e.agentInfo?.name ?? ''}`);
          if (e.type === 'thread.done') this.ui.log('subagent', `Subagent finished: ${e.title ?? ''}`);
          if (e.type === 'thread.context_compaction_started') this.ui.log('info', 'TrueForge is compacting context…');
        },
        onApproval: async calls => { clearTimeout(idle); try { return await this.approve(calls); } finally { kick(); } },
        onSession: id => { if (this.active) this.active.sessionId = id; },
      }, own.signal, sessionId);
      if (own.signal.aborted && !signal.aborted) return { ...r, status: 'error', error: stalled };
      return r;
    } catch (e) {
      if (signal.aborted) return { sessionId: '', status: 'cancelled' };
      if (own.signal.aborted) return { sessionId: '', status: 'error', error: stalled };
      return { sessionId: '', status: 'error', error: (e as Error).message };
    } finally {
      clearTimeout(stall);
      clearTimeout(idle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** TrueForge paused for approval: guard-check edits, open the per-hunk review, answer. */
  private async approve(calls: PendingCall[]): Promise<Decision[]> {
    const decisions: Decision[] = [];
    const items: { call: PendingCall; item: ReviewItem }[] = [];
    const simulated = new Map<string, string>();
    for (const c of calls) {
      if (c.name === 'propose_edit') {
        const a = c.args as EditArgs;
        // Inline edit: once the user has rejected the whole proposal, that answer stands for this run,
        // whatever the model does next. No second review pops up.
        if (this.active?.inlineDeclined) {
          this.ui.log('guard', `Blocked: you already rejected this inline edit; not opening another review for ${a.path}.`);
          decisions.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: false, reason: 'The user already rejected this inline edit. Do not propose any more edits. Reply with one line saying nothing was changed.' });
          continue;
        }
        const v = await validateEdit(this.ws, a, simulated.get(a.path));
        if (!v.ok) {
          this.ui.log('guard', `Blocked before review: ${v.error}`);
          decisions.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: false, reason: v.error });
          continue;
        }
        simulated.set(a.path, v.after);
        items.push({ call: c, item: { key: editKey(a), args: a, before: v.before, after: v.after } });
      } else if (c.name === 'run_command') {
        const ok = await this.confirmCommand(c.args);
        decisions.push(ok
          ? { toolCallId: c.toolCallId, threadId: c.threadId, allow: true }
          : { toolCallId: c.toolCallId, threadId: c.threadId, allow: false, reason: 'The user declined to run this command.' });
      } else {
        // Fail closed: only the two gated tools are expected here.
        decisions.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: false, reason: `Unexpected approval request for ${c.name}.` });
      }
    }
    if (items.length) {
      this.ui.status(`Review ${items.length} proposed edit(s): accept or reject each hunk.`, 'info');
      const result = await this.review.review(items.map(i => i.item));
      for (const { call, item } of items) {
        const acc = result?.get(item.key);
        decisions.push(acc && acc.size
          ? { toolCallId: call.toolCallId, threadId: call.threadId, allow: true }
          : { toolCallId: call.toolCallId, threadId: call.threadId, allow: false, reason: `The user rejected every hunk of this edit to ${item.args.path}. Nothing was written. Do not propose it again.` });
      }
      if (this.active?.kind === 'ledgerforge-inline' && items.every(({ item }) => !result?.get(item.key)?.size)) this.active.inlineDeclined = true;
    }
    return decisions;
  }

  private async confirmCommand(args: { command: string; args?: string[] }): Promise<boolean> {
    const line = [args.command, ...(args.args ?? [])].join(' ');
    // Read-only commands (by default git status/diff/log/show) never change the workspace: no prompt.
    if (isAutoApproved(line)) return true;
    if (this.active?.allowCommands) return true;
    const pick = await vscode.window.showInformationMessage(`LedgerForge wants to run: ${line}`, 'Allow', 'Allow for this run', 'Deny');
    if (pick === 'Allow for this run' && this.active) this.active.allowCommands = true;
    const ok = pick === 'Allow' || pick === 'Allow for this run';
    if (ok) this.active?.approved.add(line);
    return ok;
  }
}

function isAutoApproved(line: string): boolean {
  const auto = vscode.workspace.getConfiguration('ledgerforge').get<string[]>('autoApproveCommands') ?? [];
  return auto.some(p => line === p || line.startsWith(p + ' '));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(r => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
}

function shortError(e?: string): string {
  if (!e) return 'unknown error';
  const net = e.match(/(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH)\s*([\w.:-]*)/);
  if (net) return `model endpoint unreachable (${net[1]}${net[2] ? ' ' + net[2] : ''})`;
  const m = e.match(/\((\d{3})\)[:\s]*([^"}\]]{0,80})/);
  return m ? `${m[1]} ${m[2].trim()}` : e.slice(0, 120);
}
