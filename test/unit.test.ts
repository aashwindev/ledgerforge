import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Workspace } from '../src/workspace';
import { validateEdit, runCommand, searchCode, findSymbol, terms } from '../src/tools';
import { buildContextPack } from '../src/context';
import { resolveMentions, complete } from '../src/mentions';
import { computeHunks, applyHunks } from '../src/hunks';

// A tiny Flask-shaped repo: code, its tests, its docs page, a changelog, and unrelated files.
function fixture(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-'));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w('src/pkg/cli.py', 'import click\n\n\n@click.command("routes")\ndef routes_command():\n    """Show the routes."""\n    click.echo("routes")\n\n\nclass FlaskGroup:\n    def __init__(self):\n        self.commands = [routes_command]\n');
  w('src/pkg/helpers.py', 'import os\n\n\ndef get_debug_flag() -> bool:\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n');
  w('src/pkg/sessions.py', 'def open_session():\n    return {}\n');
  w('tests/test_cli.py', 'from pkg.cli import routes_command\n\n\ndef test_routes():\n    assert routes_command\n');
  w('docs/cli.rst', 'Command Line Interface\n======================\n\nBuilt-in commands\n-----------------\n\nflask routes shows the routes.\n');
  w('docs/sessions.rst', 'Sessions\n========\n');
  w('CHANGES.rst', 'Version 3.2.0\n-------------\n\n-   Unreleased.\n');
  w('.env', 'SECRET=x\n');
  return new Workspace(root);
}

test('workspace jail refuses escapes, .git and secrets files', () => {
  const ws = fixture();
  assert.throws(() => ws.resolve('../outside.py'), /outside the workspace/);
  assert.throws(() => ws.resolve('.git/config'), /not readable/);
  assert.throws(() => ws.resolve('.env'), /secrets/);
  assert.doesNotThrow(() => ws.resolve('src/pkg/cli.py'));
});

test('listFiles skips secrets files', async () => {
  const files = await fixture().listFiles();
  assert.ok(files.includes('src/pkg/cli.py'));
  assert.ok(!files.includes('.env'));
});

test('edit guard: old_text must exist exactly once', async () => {
  const ws = fixture();
  const missing = await validateEdit(ws, { path: 'src/pkg/helpers.py', old_text: 'def nope():', new_text: 'x' });
  assert.equal(missing.ok, false);
  const dup = await validateEdit(ws, { path: 'src/pkg/cli.py', old_text: 'routes', new_text: 'paths' });
  assert.equal(dup.ok, false);
  const same = await validateEdit(ws, { path: 'src/pkg/sessions.py', old_text: 'return {}', new_text: 'return {}' });
  assert.equal(same.ok, false);
});

test('edit guard: Python must still parse after the edit', async () => {
  const ws = fixture();
  const broken = await validateEdit(ws, { path: 'src/pkg/sessions.py', old_text: '    return {}', new_text: '    return {' });
  assert.equal(broken.ok, false);
  const fine = await validateEdit(ws, { path: 'src/pkg/sessions.py', old_text: '    return {}', new_text: '    return {"a": 1}' });
  assert.equal(fine.ok, true);
});

test('run_command allowlist: no shell, no write-capable git', async () => {
  const ws = fixture();
  assert.match(await runCommand(ws, 'rm', ['-rf', '.']), /not allowed|Allowed/i);
  assert.match(await runCommand(ws, 'git', ['push']), /Only git status, diff, log and show/);
  assert.match(await runCommand(ws, 'npm', ['install', 'left-pad']), /Only npm test/);
  assert.match(await runCommand(ws, 'cargo', ['publish']), /Only cargo test and cargo check/);
});

test('terms drop stopwords and short words', () => {
  assert.deepEqual(terms('Add a new built-in CLI command for the app'), ['built', 'cli', 'command', 'app']);
});

test('search_code ranks the implementation for a CLI request', async () => {
  const out = await searchCode(fixture(), 'routes command');
  assert.match(out.split('\n')[0], /src\/pkg\/cli\.py/);
});

test('find_symbol reports definitions and refuses unknown names', async () => {
  const ws = fixture();
  assert.match(await findSymbol(ws, 'routes_command'), /src\/pkg\/cli\.py:5/);
  assert.match(await findSymbol(ws, 'does_not_exist'), /No symbol named/);
});

test('context pack: link expansion finds tests, docs page and changelog within budget', async () => {
  const pack = await buildContextPack(fixture(), 'Add a new built-in CLI command that prints the routes', 8000);
  const included = pack.rows.filter(r => r.included).map(r => r.path);
  for (const p of ['src/pkg/cli.py', 'tests/test_cli.py', 'docs/cli.rst', 'CHANGES.rst']) assert.ok(included.includes(p), `${p} included`);
  assert.ok(pack.used <= pack.budget);
  assert.match(pack.message, /^Context pack/);
  assert.match(pack.message, /Request: Add a new built-in CLI command/);
  for (const r of pack.rows) assert.ok(r.reason.length > 0, 'every row has a reason');
});

test('context pack: a tiny budget excludes files and says why', async () => {
  const pack = await buildContextPack(fixture(), 'Add a new built-in CLI command that prints the routes', 20);
  assert.ok(pack.used <= 20);
  assert.ok(pack.rows.some(r => !r.included && /over budget/.test(r.reason)));
});

test('@file and @symbol mentions are resolved and pinned first', async () => {
  const ws = fixture();
  const { found, missing } = await resolveMentions(ws, 'Use @helpers.py and @routes_command, not @nothing_here');
  assert.deepEqual(found.map(f => [f.kind, f.path]), [['file', 'src/pkg/helpers.py'], ['symbol', 'src/pkg/cli.py']]);
  assert.match(found[1].body, /@click\.command\("routes"\)\n.*def routes_command/s);
  assert.deepEqual(missing, ['nothing_here']);
  const pack = await buildContextPack(ws, 'Change @get_debug_flag to accept off');
  assert.equal(pack.rows[0].source, 'mention');
  assert.equal(pack.rows[0].path, 'src/pkg/helpers.py#get_debug_flag');
});

test('@ autocomplete offers symbols and files', async () => {
  const items = await complete(fixture(), 'rout');
  assert.ok(items.some(i => i.kind === 'symbol' && i.insert === 'routes_command'));
  const files = await complete(fixture(), 'cli.p');
  assert.equal(files[0].insert, 'src/pkg/cli.py');
});

test('hunks: per-hunk accept applies only the chosen hunks', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'A\nb\nc\nd\nE\n';
  const hunks = computeHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(before, hunks, i => i === 0), 'A\nb\nc\nd\ne\n');
  assert.equal(applyHunks(before, hunks, () => true), after);
  assert.equal(applyHunks(before, hunks, () => false), before);
});

test('context pack: git co-change finds tests that are not named after the module', async () => {
  const { execFileSync } = await import('child_process');
  const ws = fixture();
  const g = (...a: string[]) => execFileSync('git', ['-C', ws.root, ...a], { stdio: 'ignore' });
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(ws.root, p)), { recursive: true }); fs.appendFileSync(path.join(ws.root, p), s); };
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  g('add', '-A'); g('commit', '-qm', 'base');
  for (let i = 0; i < 3; i++) {
    w('src/pkg/helpers.py', `# change ${i}\n`);
    w('tests/test_basic.py', `def test_debug_${i}():\n    pass\n`);
    g('add', '-A'); g('commit', '-qm', `debug fix ${i}`);
  }
  const pack = await buildContextPack(ws, 'Make get_debug_flag treat off as false');
  const row = pack.rows.find(r => r.path === 'tests/test_basic.py');
  assert.ok(row?.included, 'co-changed test file is in the pack');
  assert.match(row!.reason, /changed together with src\/pkg\/helpers\.py in 3 of its last 4 commits/);
});

test('context pack: outside a git repository co-change is skipped quietly', async () => {
  const pack = await buildContextPack(fixture(), 'Make get_debug_flag treat off as false');
  assert.ok(!pack.rows.some(r => /changed together/.test(r.reason)));
});
