import { execFile } from 'child_process';
import * as path from 'path';
import { terms } from './tools';
import { Workspace, estimateTokens } from './workspace';
import { resolveMentions } from './mentions';

// Automatic retrieval before the first turn, independent of the model:
// 1. score every file by idf-weighted overlap with the request;
// 2. take the best implementation files as seeds and follow their links
//    (module -> tests/test_<module>.py -> docs page of the same name -> changelog),
//    plus the tests and docs that git history shows changing together with it;
// 3. pack outlines (signatures / headings) into a fixed token budget, best first;
// 4. report what was included, what was left out, and why (the Context Receipt).

export const CONTEXT_BUDGET = 8000;
const SEEDS = 2;
const MAX_CANDIDATES = 10;
const OUTLINE_LINES = 60;
const COCHANGE_COMMITS = 300; // how far back to look in git history
const COCHANGE_MIN = 3; // a test or docs file must have changed with the seed at least this often

export interface ReceiptRow { path: string; source: 'mention' | 'auto' | 'linked' | 'agent'; reason: string; tokens: number; included: boolean }
export interface ContextPack { message: string; rows: ReceiptRow[]; used: number; budget: number; strategy: string }

const isTest = (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);
const isDoc = (p: string) => /\.(rst|md|txt)$/i.test(p);
const isChangelog = (p: string) => /^(CHANGES|CHANGELOG|HISTORY)(\.(rst|md|txt))?$/i.test(p);
const isCode = (p: string) => /\.(py|ts|js|tsx|jsx)$/.test(p) && !isTest(p);

export async function buildContextPack(ws: Workspace, request: string, budget = CONTEXT_BUDGET): Promise<ContextPack> {
  const ts = terms(request);
  const files = await ws.listFiles();
  const texts = new Map<string, string>();
  const df = new Map<string, number>();
  for (const f of files) {
    let t: string;
    try { t = (await ws.read(f)); } catch { continue; }
    texts.set(f, t);
    const lower = t.toLowerCase();
    for (const term of ts) if (lower.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = (t: string) => Math.log(1 + files.length / (df.get(t) ?? files.length));
  const scored = [...texts].map(([f, t]) => {
    const lower = t.toLowerCase();
    const name = path.basename(f).toLowerCase();
    // BM25-style saturating term frequency times idf, per request term.
    const w = new Map(ts.map(term => { const tf = count(lower, term); return [term, tf ? (tf / (tf + 1.5)) * idf(term) : 0]; }));
    const hits = ts.filter(term => w.get(term)! > 0).sort((a, b) => w.get(b)! - w.get(a)!);
    // A request term in the file name ("auth" -> auth.py) is a strong signal.
    const nameBoost = ts.some(term => name.replace(/\.\w+$/, '') === term) ? 2 : 1;
    return { f, hits, score: hits.reduce((s, term) => s + w.get(term)!, 0) * nameBoost };
  }).filter(x => x.hits.length).sort((a, b) => b.score - a.score);

  const picks: { f: string; source: ReceiptRow['source']; reason: string }[] = [];
  const add = (f: string, source: ReceiptRow['source'], reason: string) => { if (texts.has(f) && !picks.some(p => p.f === f)) picks.push({ f, source, reason }); };
  const why = (f: string) => { const s = scored.find(x => x.f === f); return s ? `matches ${s.hits.slice(0, 4).join(', ')}` : ''; };

  const seeds = scored.filter(x => isCode(x.f)).slice(0, SEEDS);
  for (const s of seeds) {
    add(s.f, 'auto', `implementation; ${why(s.f)}`);
    const mod = path.basename(s.f).replace(/\.\w+$/, '');
    for (const f of files) {
      const base = path.basename(f).toLowerCase();
      if (isTest(f) && (base === `test_${mod}.py` || base === `${mod}.test.ts`)) add(f, 'linked', `tests for ${s.f}`);
      if (isDoc(f) && !isChangelog(f) && base.replace(/\.\w+$/, '') === mod) add(f, 'linked', `docs page for ${s.f}`);
    }
    // Tests and docs are often not named after the module (Flask tests app.py in test_basic.py).
    // Git history knows: take the test file and the docs page that changed with it most often.
    const co = await coChanged(ws.root, s.f);
    for (const kind of [isTest, (f: string) => isDoc(f) && !isChangelog(f)]) {
      const best = co.find(c => kind(c.f) && c.n >= COCHANGE_MIN);
      if (best) add(best.f, 'linked', `changed together with ${s.f} in ${best.n} of its last ${best.total} commits`);
    }
  }
  const changelog = files.find(f => isChangelog(f));
  if (changelog) add(changelog, 'linked', 'project changelog: user-facing changes are recorded here');
  const coPicks = picks.filter(p => p.reason.startsWith('changed together')).length;
  for (const s of scored) if (picks.length < MAX_CANDIDATES + coPicks) add(s.f, 'auto', why(s.f));

  // Pack outlines best-first; whatever does not fit is excluded, with the reason.
  const rows: ReceiptRow[] = [];
  const blocks: string[] = [];
  let used = 0;
  // Explicit @file / @symbol mentions are pinned first and charged to the same budget.
  const { found, missing } = await resolveMentions(ws, request);
  for (const m of found) {
    const label = m.kind === 'symbol' ? `${m.path}#${m.token}` : m.path;
    const fits = used + m.tokens <= budget;
    rows.push({ path: label, source: 'mention', reason: fits ? `you mentioned @${m.token}` : `you mentioned @${m.token}; over budget (${m.tokens} tok), agent must read it`, tokens: m.tokens, included: fits });
    if (fits) { used += m.tokens; blocks.push(`### ${label} (mentioned by the user, ${m.kind === 'symbol' ? 'full definition' : 'file'})\n${m.body}`); }
  }
  for (const t of missing) rows.push({ path: '@' + t, source: 'mention', reason: 'no file or symbol with this name', tokens: 0, included: false });
  for (const p of picks) {
    if (found.some(m => m.kind === 'file' && m.path === p.f)) continue;
    const body = outline(p.f, texts.get(p.f)!);
    const tokens = estimateTokens(body);
    const fits = used + tokens <= budget;
    rows.push({ path: p.f, source: p.source, reason: fits ? p.reason : `${p.reason}; over budget (${tokens} tok)`, tokens, included: fits });
    if (fits) { used += tokens; blocks.push(`### ${p.f} (${p.source}: ${p.reason})\n${body}`); }
  }
  for (const s of scored.slice(0, 40)) {
    if (rows.length >= picks.length + 5) break;
    if (!picks.some(p => p.f === s.f)) rows.push({ path: s.f, source: 'auto', reason: `left out: weaker match (${s.hits.slice(0, 3).join(', ')}) than the files above`, tokens: 0, included: false });
  }

  const strategy = `@mentions pinned first, then idf-ranked retrieval, top ${SEEDS} implementation files expanded to their tests, docs page, git co-changed tests and docs, and the changelog; outlines packed into ${budget} tokens`;
  const message = [
    `Context pack (chosen by the editor before this turn: ${strategy}; ${used}/${budget} tokens). These are outlines only: read_file before editing. Other files may matter too.`,
    ...blocks,
    `Excluded: ${rows.filter(r => !r.included).map(r => `${r.path} (${r.reason})`).join('; ') || 'none'}`,
    '---',
    `Request: ${request}`,
  ].join('\n\n');
  return { message, rows, used, budget, strategy };
}

/** Files that changed in the same commits as `file`, most frequent first. Empty outside git. */
function coChanged(root: string, file: string): Promise<{ f: string; n: number; total: number }[]> {
  const args = ['-C', root, 'log', '-n', String(COCHANGE_COMMITS), '--no-merges', '--full-diff', '--format=%x00', '--name-only', '--', file];
  return new Promise(resolve => {
    execFile('git', args, { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      const commits = stdout.split('\0').map(b => b.split('\n').filter(Boolean)).filter(c => c.length);
      const counts = new Map<string, number>();
      for (const c of commits) for (const f of c) if (f !== file) counts.set(f, (counts.get(f) ?? 0) + 1);
      resolve([...counts].map(([f, n]) => ({ f, n, total: commits.length })).sort((a, b) => b.n - a.n));
    });
  });
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < 50; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Signatures for code, headings for docs, the newest entries for a changelog. Line numbers kept. */
function outline(file: string, text: string): string {
  const lines = text.split('\n');
  let keep: number[];
  if (isChangelog(file)) keep = lines.slice(0, 20).map((_, i) => i);
  else if (isDoc(file)) keep = lines.flatMap((l, i) => (/^[=\-~^"#*]{3,}\s*$/.test(lines[i + 1] ?? '') && l.trim() ? [i] : /^#{1,4} /.test(l) || /^\.\. (click|autofunction|autoclass)::/.test(l) ? [i] : []));
  else keep = lines.flatMap((l, i) => (/^\s*(def |class |async def |@[\w.]+\.command|@click\.|export (async )?(function|class|const) )/.test(l) ? [i] : []));
  return keep.slice(0, OUTLINE_LINES).map(i => `${i + 1}: ${lines[i].slice(0, 120)}`).join('\n') || '(no outline)';
}
