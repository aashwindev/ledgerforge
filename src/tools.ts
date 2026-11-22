import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { Workspace, estimateTokens } from './workspace';

// Editor capabilities exposed to the TrueForge agent as MCP tools.
// The agent decides what to read and what to change; the extension only executes.

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: any) => Promise<string>;
}

export interface EditArgs { path: string; old_text: string; new_text: string; reason?: string }

export interface ToolHooks {
  /** Called for every file region the agent reads, for the context receipt. */
  onRead?(path: string, tokens: number, why: string): void;
  /** Called only after TrueForge approval. Applies the hunks the user accepted and reports back. */
  applyEdit(args: EditArgs): Promise<string>;
  /** True if the user approved this exact command (or it is auto-approved read-only). */
  commandAllowed?(line: string): boolean;
}

const MAX_READ_LINES = 400;
const MAX_HITS = 12;

// ---------- propose_edit validation (the hallucination guard) ----------

export interface ValidEdit { ok: true; before: string; after: string }
export interface InvalidEdit { ok: false; error: string }

export async function validateEdit(ws: Workspace, a: EditArgs, current?: string): Promise<ValidEdit | InvalidEdit> {
  let before: string;
  try {
    ws.resolve(a.path);
    before = current ?? (a.old_text === '' && !ws.exists(a.path) ? '' : await ws.read(a.path));
  } catch (e) {
    return { ok: false, error: `Cannot edit ${a.path}: ${(e as Error).message}. Read or search the repository first.` };
  }
  if (a.old_text === a.new_text) return { ok: false, error: 'old_text and new_text are identical; nothing to change.' };
  let after: string;
  if (a.old_text === '') {
    if (before.length) return { ok: false, error: 'old_text is empty but the file is not; quote the exact text to replace.' };
    after = a.new_text;
  } else {
    const count = before.split(a.old_text).length - 1;
    if (count === 0) {
      return { ok: false, error: `old_text was not found in ${a.path}. It must match the file exactly (whitespace included). Call read_file and copy the text verbatim.` };
    }
    if (count > 1) return { ok: false, error: `old_text occurs ${count} times in ${a.path}; include more surrounding lines so it is unique.` };
    after = before.replace(a.old_text, () => a.new_text);
  }
  if (a.path.endsWith('.py')) {
    const wasValid = await pythonParses(before);
    if (wasValid && !(await pythonParses(after))) {
      return { ok: false, error: `The edit would leave ${a.path} with a Python syntax error. Fix indentation or brackets and propose again.` };
    }
  }
  return { ok: true, before, after };
}

function pythonParses(src: string): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn(pythonBin(), ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(true)); // no python available: skip the check rather than block
    p.on('close', code => resolve(code === 0));
    p.stdin.end(src);
  });
}

let cachedPython: string | undefined;
function pythonBin(): string {
  return cachedPython ?? (cachedPython = process.platform === 'win32' ? 'python' : 'python3');
}

// ---------- search ----------

export function terms(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'any', 'its', 'are', 'all', 'def', 'class', 'must', 'new', 'add', 'other', 'also', 'should', 'well', 'every', 'each']);
  return [...new Set(raw.map(t => t.toLowerCase()).filter(t => t.length > 2 && !stop.has(t)))];
}

export async function searchCode(ws: Workspace, query: string, max = MAX_HITS): Promise<string> {
  const ts = terms(query);
  if (!ts.length) return 'Give at least one identifier or word longer than two characters.';
  const files = await ws.listFiles();
  const docFreq = new Map<string, number>();
  const perFile: { file: string; lines: { n: number; text: string; hits: string[] }[]; score: number }[] = [];
  for (const file of files) {
    let text: string;
    try { text = await ws.read(file); } catch { continue; }
    const lower = text.toLowerCase();
    const present = ts.filter(t => lower.includes(t));
    if (!present.length) continue;
    present.forEach(t => docFreq.set(t, (docFreq.get(t) ?? 0) + 1));
    const lines = text.split('\n').map((l, i) => ({ n: i + 1, text: l, hits: present.filter(t => l.toLowerCase().includes(t)) }))
      .filter(l => l.hits.length);
    perFile.push({ file, lines, score: 0 });
  }
  const idf = (t: string) => Math.log(1 + files.length / (docFreq.get(t) ?? 1));
  for (const f of perFile) {
    const distinct = new Set(f.lines.flatMap(l => l.hits));
    f.score = [...distinct].reduce((s, t) => s + idf(t), 0) * (1 + Math.log(1 + f.lines.length) / 4);
    f.lines.sort((a, b) => b.hits.length - a.hits.length || a.n - b.n);
  }
  perFile.sort((a, b) => b.score - a.score);
  const top = perFile.slice(0, max);
  if (!top.length) return `No matches for: ${ts.join(', ')}`;
  return top.map(f => {
    const matched = [...new Set(f.lines.flatMap(l => l.hits))];
    const sample = f.lines.slice(0, 3).map(l => `    ${l.n}: ${l.text.trim().slice(0, 140)}`).join('\n');
    return `${f.file}  (score ${f.score.toFixed(2)}; matches ${matched.join(', ')})\n${sample}`;
  }).join('\n');
}

export async function findSymbol(ws: Workspace, name: string): Promise<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'name must be a bare identifier, e.g. routes_command';
  const def = new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${name}\\b|^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let)\\s+${name}\\b|^${name}\\s*=`);
  const ref = new RegExp(`\\b${name}\\b`);
  const defs: string[] = [];
  const refs: string[] = [];
  for (const file of await ws.listFiles()) {
    let text: string;
    try { text = await ws.read(file); } catch { continue; }
    if (!text.includes(name)) continue;
    text.split('\n').forEach((l, i) => {
      if (def.test(l)) defs.push(`${file}:${i + 1}: ${l.trim()}`);
      else if (ref.test(l) && refs.length < 20) refs.push(`${file}:${i + 1}: ${l.trim().slice(0, 140)}`);
    });
  }
  if (!defs.length && !refs.length) return `No symbol named ${name} exists in this workspace.`;
  return `Definitions:\n${defs.join('\n') || '  (none found)'}\n\nReferences (up to 20):\n${refs.join('\n') || '  (none)'}`;
}

// ---------- commands ----------

const ALLOWED_COMMANDS: Record<string, (args: string[]) => string | undefined> = {
  pytest: () => undefined,
  python: () => undefined,
  python3: () => undefined,
  node: () => undefined,
  npm: args => (args[0] === 'test' || (args[0] === 'run' && args[1] === 'test') ? undefined : 'Only npm test is allowed.'),
  go: args => (['test', 'vet'].includes(args[0]) ? undefined : 'Only go test and go vet are allowed.'),
  cargo: args => (['test', 'check'].includes(args[0]) ? undefined : 'Only cargo test and cargo check are allowed.'),
  git: args => (['status', 'diff', 'log', 'show'].includes(args[0]) ? undefined : 'Only git status, diff, log and show are allowed.'),
};

export function runCommand(ws: Workspace, command: string, args: string[] = [], timeoutMs = 120_000): Promise<string> {
  const check = ALLOWED_COMMANDS[command];
  if (!check) return Promise.resolve(`Command not allowed: ${command}. Allowed: ${Object.keys(ALLOWED_COMMANDS).join(', ')}.`);
  const refusal = check(args);
  if (refusal) return Promise.resolve(refusal);
  // Prefer the workspace's virtualenv so tests run against the checked-out code.
  const venvBin = ['.venv', 'venv'].map(d => path.join(ws.root, d, process.platform === 'win32' ? 'Scripts' : 'bin')).find(d => fs.existsSync(d));
  const env = { ...process.env, ...(venvBin ? { PATH: `${venvBin}${path.delimiter}${process.env.PATH}`, VIRTUAL_ENV: path.dirname(venvBin) } : {}) };
  return new Promise(resolve => {
    const p = spawn(command, args, { cwd: ws.root, env, shell: false });
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-8000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => { p.kill('SIGKILL'); out += `\n[killed after ${timeoutMs / 1000}s]`; }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); resolve(`Failed to start ${command}: ${e.message}`); });
    p.on('close', code => { clearTimeout(timer); resolve(`$ ${[command, ...args].join(' ')}\n[exit ${code}]\n${out.slice(-4000)}`); });
  });
}

// ---------- tool table ----------

export function makeTools(ws: Workspace, hooks: ToolHooks): ToolSpec[] {
  return [
    {
      name: 'search_code',
      title: 'Search code',
      description: 'Ranked search over the workspace. Give identifiers or keywords; returns the best-matching files with matching lines. Use this to find code you have not been shown.',
      inputSchema: { query: z.string().describe('Identifiers or keywords, e.g. "parse_config load_settings ConfigLoader"') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ query }) => searchCode(ws, query),
    },
    {
      name: 'find_symbol',
      title: 'Find symbol',
      description: 'Find where a function, class or variable is defined and where it is used.',
      inputSchema: { name: z.string().describe('Bare identifier, e.g. parse_config') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ name }) => findSymbol(ws, name),
    },
    {
      name: 'read_file',
      title: 'Read file',
      description: `Read a workspace file (the live editor buffer if open). Optional 1-based start_line/end_line; at most ${MAX_READ_LINES} lines per call. Copy text from here verbatim into propose_edit old_text.`,
      inputSchema: {
        path: z.string().describe('Workspace-relative path, e.g. src/app/main.py'),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        why: z.string().optional().describe('One short phrase: why you are reading this file'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ path: p, start_line, end_line, why }) => {
        const text = await ws.read(p);
        const lines = text.split('\n');
        const start = Math.max(1, start_line ?? 1);
        const end = Math.min(lines.length, end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        const body = lines.slice(start - 1, end).join('\n');
        hooks.onRead?.(p, estimateTokens(body), why ?? '');
        const more = end < lines.length ? `\n[... ${lines.length - end} more lines; call again with start_line=${end + 1}]` : '';
        return `${p} (lines ${start}-${end} of ${lines.length})\n${body}${more}`;
      },
    },
    {
      name: 'propose_edit',
      title: 'Propose edit',
      description: 'Propose replacing old_text with new_text in one file. Nothing is written until the user reviews and accepts each hunk; the result says which hunks were accepted or rejected. old_text must appear exactly once in the file (copy it from read_file). Use old_text="" only to create a new file. Make one call per contiguous change.',
      inputSchema: {
        path: z.string().describe('Workspace-relative path'),
        old_text: z.string().describe('Exact text currently in the file, unique within it'),
        new_text: z.string().describe('Replacement text'),
        reason: z.string().describe('One line shown to the reviewer: why this change'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args: EditArgs) => {
        const v = await validateEdit(ws, args);
        if (!v.ok) return `Rejected before review: ${v.error}`;
        return hooks.applyEdit(args);
      },
    },
    {
      name: 'run_command',
      title: 'Run command',
      description: 'Run a command in the workspace root without a shell (allowed: test runners and interpreters: pytest, python, node, npm test, go test/vet, cargo test/check; read-only git status/diff/log/show; a project CLI runs as python -m <module>). Uses the workspace virtualenv when present. Output is trimmed.',
      inputSchema: {
        command: z.string().describe('Executable, e.g. pytest'),
        args: z.array(z.string()).default([]).describe('Arguments, e.g. ["tests/test_main.py", "-q"]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async ({ command, args }) => {
        const line = [command, ...(args ?? [])].join(' ');
        if (hooks.commandAllowed && !hooks.commandAllowed(line)) return `Not run: the user has not approved "${line}". Explore with search_code, find_symbol and read_file; use run_command only for tests after edits.`;
        return runCommand(ws, command, args);
      },
    },
  ];
}
