import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Workspace } from '../src/workspace';
import { validateEdit, runCommand } from '../src/tools';
import { buildContextPack } from '../src/context';
import { computeHunks, applyHunks, hunkPositions } from '../src/hunks';

// Edge cases for the three things that keep the user's files safe:
// the workspace jail, the edit guard and per-hunk review.

function repo(files: Record<string, string>): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-safety-'));
  for (const [p, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  }
  return new Workspace(root);
}

// ---------- workspace jail ----------

test('jail: absolute paths, parent hops and nested .git are refused', () => {
  const ws = repo({ 'a.py': 'x = 1\n' });
  assert.throws(() => ws.resolve('/etc/passwd'), /outside the workspace/);
  assert.throws(() => ws.resolve('src/../../escape.py'), /outside the workspace/);
  assert.throws(() => ws.resolve('vendor/lib/.git/HEAD'), /not readable/);
});

test('jail: every secrets-file shape is refused, look-alikes are not', () => {
  const ws = repo({});
  for (const p of ['.env', '.env.local', 'config/.env.production', 'certs/server.pem', 'keys/deploy.key', 'id_rsa', 'home/id_rsa.pub']) {
    assert.throws(() => ws.resolve(p), /secrets/, p);
  }
  for (const p of ['src/environment.py', 'docs/env.rst', 'keyboard.py', 'monkey.py']) {
    assert.doesNotThrow(() => ws.resolve(p), p);
  }
});

test('jail: a symlink inside the workspace cannot reach a file outside it', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
  fs.writeFileSync(path.join(outside, 'private.py'), 'TOKEN = "x"\n');
  const ws = repo({ 'a.py': 'x = 1\n' });
  fs.symlinkSync(outside, path.join(ws.root, 'linked'));
  fs.symlinkSync(path.join(outside, 'private.py'), path.join(ws.root, 'shortcut.py'));
  assert.throws(() => ws.resolve('linked/private.py'), /outside the workspace/);
  assert.throws(() => ws.resolve('shortcut.py'), /outside the workspace/);
});

test('jail: a symlink that stays inside the workspace is allowed', () => {
  const ws = repo({ 'src/a.py': 'x = 1\n' });
  fs.symlinkSync(path.join(ws.root, 'src'), path.join(ws.root, 'alias'));
  assert.doesNotThrow(() => ws.resolve('alias/a.py'));
});

test('jail: new files can still be proposed in folders that do not exist yet', () => {
  const ws = repo({});
  assert.doesNotThrow(() => ws.resolve('src/new_pkg/new_module.py'));
});

// ---------- edit guard ----------

test('guard: creating a new file needs empty old_text and a missing file', async () => {
  const ws = repo({ 'a.py': 'x = 1\n' });
  const create = await validateEdit(ws, { path: 'b.py', old_text: '', new_text: 'y = 2\n' });
  assert.equal(create.ok, true);
  const clobber = await validateEdit(ws, { path: 'a.py', old_text: '', new_text: 'y = 2\n' });
  assert.equal(clobber.ok, false);
});

test('guard: replacement text is inserted literally ($& and $1 are not regex tokens)', async () => {
  const ws = repo({ 'a.py': 'PRICE = 1\n' });
  const v = await validateEdit(ws, { path: 'a.py', old_text: 'PRICE = 1', new_text: 'PRICE = "$& $1 $$"' });
  assert.ok(v.ok);
  assert.equal(v.ok && v.after, 'PRICE = "$& $1 $$"\n');
});

test('guard: a file that was already broken can still be edited', async () => {
  const ws = repo({ 'broken.py': 'def f(:\n    pass\n' });
  const v = await validateEdit(ws, { path: 'broken.py', old_text: 'def f(:', new_text: 'def f():' });
  assert.equal(v.ok, true);
});

test('guard: secrets files and paths outside the workspace are refused before review', async () => {
  const ws = repo({ '.env': 'A=1\n' });
  assert.equal((await validateEdit(ws, { path: '.env', old_text: 'A=1', new_text: 'A=2' })).ok, false);
  assert.equal((await validateEdit(ws, { path: '../x.py', old_text: '', new_text: 'x' })).ok, false);
});

test('guard: the unsaved editor buffer is what gets validated', async () => {
  const ws = repo({ 'a.py': 'on_disk = 1\n' });
  const v = await validateEdit(ws, { path: 'a.py', old_text: 'in_editor = 1', new_text: 'in_editor = 2' }, 'in_editor = 1\n');
  assert.ok(v.ok);
  assert.equal(v.ok && v.after, 'in_editor = 2\n');
});

// ---------- command allowlist ----------

test('allowlist: shells, network tools and bare git are refused without running', async () => {
  const ws = repo({});
  for (const cmd of ['sh', 'bash', 'zsh', 'curl', 'wget', 'rm', 'pip', 'npx']) {
    assert.match(await runCommand(ws, cmd, ['-c', 'echo hi']), /Command not allowed/, cmd);
  }
  assert.match(await runCommand(ws, 'git', []), /Only git status/);
  assert.match(await runCommand(ws, 'git', ['checkout', '.']), /Only git status/);
  assert.match(await runCommand(ws, 'git', ['reset', '--hard']), /Only git status/);
  assert.match(await runCommand(ws, 'npm', ['run', 'build']), /Only npm test/);
});

test('allowlist: arguments are passed without a shell, so metacharacters are inert', async () => {
  const ws = repo({});
  const out = await runCommand(ws, 'node', ['-e', 'console.log(process.argv[1])', '; rm -rf . && echo pwned']);
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /; rm -rf \. && echo pwned/);
  assert.ok(fs.existsSync(ws.root));
});

test('allowlist: a command that hangs is killed at the timeout', async () => {
  const ws = repo({});
  const out = await runCommand(ws, 'node', ['-e', 'setInterval(() => {}, 1000)'], 300);
  assert.match(out, /killed after 0.3s/);
});

// ---------- per-hunk review ----------

test('hunks: insert-only, delete-only, first-line and last-line changes', () => {
  const before = 'a\nb\nc\nd\n';
  const cases = ['X\na\nb\nc\nd\n', 'a\nb\nc\nd\nX\n', 'b\nc\nd\n', 'a\nb\nc\n', 'Z\nb\nc\nY\n'];
  for (const after of cases) {
    const hs = computeHunks(before, after);
    assert.ok(hs.length >= 1, after);
    assert.equal(applyHunks(before, hs, () => true), after, `accept all: ${JSON.stringify(after)}`);
    assert.equal(applyHunks(before, hs, () => false), before, `reject all: ${JSON.stringify(after)}`);
  }
});

test('hunks: neighbouring changed lines form one hunk, a kept line splits them', () => {
  assert.equal(computeHunks('a\nb\nc\n', 'A\nB\nc\n').length, 1);
  assert.equal(computeHunks('a\nb\nc\n', 'A\nb\nC\n').length, 2);
});

test('hunks: CRLF line endings survive a partial accept', () => {
  const before = 'one\r\ntwo\r\nthree\r\n';
  const after = 'ONE\r\ntwo\r\nTHREE\r\n';
  const hs = computeHunks(before, after);
  assert.equal(applyHunks(before, hs, i => i === 1), 'one\r\ntwo\r\nTHREE\r\n');
});

test('hunks: every accept/reject combination rebuilds a consistent file (randomised)', () => {
  let seed = 42;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const base = Array.from({ length: 4 + rand(12) }, (_, i) => `line ${i}\n`);
    const edited = base.flatMap(l => {
      const r = rand(6);
      return r === 0 ? [] : r === 1 ? [l.toUpperCase()] : r === 2 ? [l, `new ${rand(99)}\n`] : [l];
    });
    const before = base.join('');
    const after = edited.join('');
    const hs = computeHunks(before, after);
    assert.equal(applyHunks(before, hs, () => true), after);
    assert.equal(applyHunks(before, hs, () => false), before);
    const mask = rand(1 << Math.min(hs.length, 10));
    const take = (i: number) => ((mask >> i) & 1) === 1;
    const partial = applyHunks(before, hs, take);
    // Each hunk's anchor line in the partial result holds exactly what that hunk chose.
    const lines = partial.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    hunkPositions(hs, take).forEach((pos, i) => {
      const chosen = take(i) ? hs[i].newLines : hs[i].oldLines;
      assert.deepEqual(lines.slice(pos, pos + chosen.length), chosen, `round ${round} hunk ${i}`);
    });
  }
});

// ---------- context budget ----------

test('context: the pack never exceeds its budget and every excluded file says why', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`src/pkg/mod${i}.py`] = `def command_${i}():\n    """cli command ${i}"""\n${'    x = 1\n'.repeat(20 + i * 5)}`;
  const ws = repo(files);
  for (const budget of [0, 40, 400, 2000, 8000]) {
    const pack = await buildContextPack(ws, 'Add a cli command', budget);
    assert.ok(pack.used <= budget, `used ${pack.used} > budget ${budget}`);
    for (const r of pack.rows.filter(r => !r.included)) assert.ok(r.reason.length > 0);
  }
});
