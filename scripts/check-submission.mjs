// Pre-submission check: the Forge-a-thon artefact rules that can be verified from the repo.
// Usage: node scripts/check-submission.mjs   (also runs in CI)
import { execFileSync } from 'child_process';
import fs from 'fs';

const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

// Write-up: 1 to 3 pages, the eight headings in order, one scorecard row per criterion.
const writeup = read('docs/writeup.md');
const headings = ['Team', 'Starting point', 'Architecture on TrueForge', 'How context is selected', 'Model setup', 'Scorecard', 'Tools used', 'Known limitations'];
const found = [...writeup.matchAll(/^## (\d)\. (.+)$/gm)].map(m => [Number(m[1]), m[2]]);
check(found.length === 8 && headings.every((h, i) => found[i][0] === i + 1 && found[i][1].startsWith(h)), 'write-up has the eight required headings, in order');
const pages = (fs.existsSync('docs/writeup.pdf') ? fs.readFileSync('docs/writeup.pdf', 'latin1') : '').match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
check(pages >= 1 && pages <= 3, `write-up PDF is 1 to 3 pages (${pages})`);
const scorecard = writeup.slice(writeup.indexOf('## 6.'), writeup.indexOf('## 7.'));
const rows = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2'];
check(rows.every(r => new RegExp(`^\\| ${r} `, 'm').test(scorecard)), 'scorecard has a row for each of the nine criteria');
check(rows.slice(0, 8).every(r => new RegExp(`^\\| ${r} [^|]*\\| [^|]*\\d:\\d\\d`, 'm').test(scorecard)), 'every scored scorecard row carries a video timestamp');
check(/AI coding assistant/i.test(writeup), 'write-up declares the AI coding tools used');

// README: video, write-up, clean-clone setup including TrueForge and the agent definition, starting point.
const readme = read('README.md');
check(/https:\/\/(youtu\.be|www\.youtube\.com)\//.test(readme), 'README links the demo video');
check(/https:\/\/drive\.google\.com\/file\//.test(readme), 'README links the write-up PDF');
check(readme.includes('npx @truefoundry/trueforge@latest'), 'README says how to start TrueForge locally');
check(/loading the agent definition/i.test(readme) && readme.includes('/api/v1/agents'), 'README says how to load the agent definition');
check(/starting point:?\*{0,2} from scratch/i.test(readme), 'README declares the starting point');

// Repository: licence, example model config, agent definitions with approval-gated writes, no secrets.
check(/MIT License/.test(read('LICENSE')), 'LICENSE present (MIT)');
check(fs.existsSync('ledgerforge.config.example.json'), 'example model configuration present');
for (const f of fs.readdirSync('agent').filter(f => f.endsWith('.json'))) {
  // Every tool that can change the workspace must pause for TrueForge approval (that pause is the review).
  for (const srv of JSON.parse(read(`agent/${f}`)).manifest.mcp_servers) {
    const enabled = srv.enable_tools.includes('@all') ? ['propose_edit', 'run_command'] : srv.enable_tools;
    const writes = enabled.filter(t => t === 'propose_edit' || t === 'run_command');
    check(writes.length > 0 && writes.every(t => srv.require_approval_for_tools.includes(t)), `agent/${f}: ${writes.join(' and ')} ${writes.length > 1 ? 'need' : 'needs'} TrueForge approval`);
  }
}
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
check(!tracked.some(f => /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|ledgerforge\.config\.json)$/.test(f)), 'no secrets or local config files are tracked');

console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nSubmission checks passed.');
process.exit(failures.length ? 1 : 0);
