import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// Rule check: the extension is only a TrueForge client. It must never call a model
// provider, bundle a provider SDK, or carry a key. These tests read the shipped
// source and config, so a violation fails CI.

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk('src').filter(f => f.endsWith('.ts'));

const PROVIDER_HOSTS = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai|api\.mistral\.ai|api\.cohere\.(ai|com)|api\.together\.(xyz|ai)|api\.deepseek\.com|api\.fireworks\.ai|openai\.azure\.com|bedrock-runtime|aiplatform\.googleapis\.com|ollama|:11434/i;
const PROVIDER_PACKAGES = /^(openai|@anthropic-ai\/.*|@google\/(generative-ai|genai)|groq-sdk|@mistralai\/.*|cohere-ai|ollama|@aws-sdk\/client-bedrock.*|ai|@ai-sdk\/.*|langchain|@langchain\/.*|together-ai)$/;
const KEY_LIKE = /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/;

test('no model provider endpoint appears anywhere in src/', () => {
  assert.ok(sources.length > 5, 'found the extension sources');
  for (const f of sources) {
    const hit = read(f).match(PROVIDER_HOSTS);
    assert.equal(hit, null, `${f} mentions a provider endpoint: ${hit?.[0]}`);
  }
});

test('src/ imports only TrueForge, MCP, VS Code, Node built-ins and pure helpers', () => {
  const allowed = new Set(['@truefoundry/trueforge-sdk', '@modelcontextprotocol/sdk', 'vscode', 'diff', 'zod']);
  for (const f of sources) {
    for (const [, imp, req] of read(f).matchAll(/^\s*(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+)['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      const spec = imp ?? req;
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      const builtin = require('module').builtinModules.includes(pkg);
      assert.ok(builtin || allowed.has(pkg), `${f} imports ${spec}, which is not an allowed dependency`);
    }
  }
});

test('package.json declares no provider SDK', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!PROVIDER_PACKAGES.test(dep), `package.json depends on provider SDK ${dep}`);
  }
});

test('no key-like secret in src/, agent definitions or the example config', () => {
  const files = [...sources, ...walk('agent'), 'ledgerforge.config.example.json', 'README.md'];
  for (const f of files) {
    const hit = read(f).match(KEY_LIKE);
    assert.equal(hit, null, `${f} contains something that looks like an API key`);
  }
});

test('the example config names models only; endpoint is the local TrueForge server', () => {
  const cfg = JSON.parse(read('ledgerforge.config.example.json'));
  assert.match(cfg.baseUrl, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
  for (const k of Object.keys(cfg)) assert.ok(!/key|token|secret/i.test(k), `example config has a ${k} field`);
});
