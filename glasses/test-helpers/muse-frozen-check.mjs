// Proves Muse is byte-identical to commit 56fe3b2. Fails CLOSED: any missing anchor, in either side, is a FAIL.
//   node muse-frozen-check.mjs [root]    root = the tree to check (default: this repo). The baseline is always git's 56fe3b2.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '56fe3b2';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(process.argv[2] || repo);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 26 });
let passed = 0;
const failures = [];
const ok = label => { passed++; console.log('  ok    ' + label); };
const bad = (label, why) => { failures.push(label); console.log('  FAIL  ' + label + ': ' + why); };

function baseText(name) { return git('show', `${BASE}:${name}`).toString('utf8'); }

// Name -> exact source text of each Muse block of hud-server.mjs (see the anchors below).
function blocks(text) {
  const lines = text.split('\n');
  const out = new Map();
  const dup = [];
  const add = (key, i, indent) => {
    let body;
    if (lines[i].trimEnd().endsWith('{')) {
      let j = i + 1;
      while (j < lines.length && !(lines[j].startsWith(indent + '}') && !lines[j].startsWith(indent + '  '))) j++;
      if (j === lines.length) { dup.push('unterminated block: ' + key); return; }
      body = lines.slice(i, j + 1).join('\n');
    } else body = lines[i];
    if (out.has(key)) dup.push('ambiguous block: ' + key); else out.set(key, body);
  };
  lines.forEach((line, i) => {
    let m = line.match(/^(\s*)if \(.*p === '(\/api\/muse[^']*)'/);
    if (m) {
      const method = line.match(/req\.method === '(\w+)'/);
      return add('route ' + m[2] + (method ? ' [' + method[1] + ']' : ''), i, m[1]);
    }
    if (line.startsWith('const museTrimLogged')) return add('museTrimLogged', i, '');
    if (line.startsWith('function museReply')) return add('museReply', i, '');
    if (line.startsWith('async function askMuse')) return add('askMuse', i, '');
    if (line.startsWith('const museMoved') || line.startsWith('const museMoving')) return add(line.split(/\s+/)[1], i, '');
  });
  return { out, dup };
}

// a. muse-clean.mjs and the Muse blocks of hud-server.mjs
function whole(name) {
  const p = path.join(root, name);
  if (!existsSync(p)) return bad(name, 'missing from the tree');
  if (Buffer.compare(git('show', `${BASE}:${name}`), readFileSync(p)) === 0) ok(name + ' byte-identical to ' + BASE);
  else bad(name, 'differs from ' + BASE);
}
whole('glasses/muse-clean.mjs');

const hudPath = path.join(root, 'glasses/hud-server.mjs');
if (!existsSync(hudPath)) bad('glasses/hud-server.mjs', 'missing from the tree');
else {
  const b = blocks(baseText('glasses/hud-server.mjs'));
  const c = blocks(readFileSync(hudPath, 'utf8'));
  for (const d of b.dup) bad('base ' + d, 'anchor problem in the baseline');
  for (const d of c.dup) bad('tree ' + d, 'anchor problem in the working file');
  const need = ['museReply', 'askMuse', 'museTrimLogged', 'museMoved', 'museMoving'];
  for (const k of need) if (!b.out.has(k)) bad(k, 'anchor missing in the ' + BASE + ' baseline');
  const routes = [...b.out.keys()].filter(k => k.startsWith('route '));
  if (routes.length < 3) bad('muse routes', 'found only ' + routes.length + ' /api/muse* route blocks in the baseline (expected at least 3)');
  for (const k of [...b.out.keys()].sort()) {
    if (!c.out.has(k)) bad(k, 'anchor missing from hud-server.mjs');
    else if (c.out.get(k) !== b.out.get(k)) bad(k, 'differs from ' + BASE);
    else ok(k + ' byte-identical to ' + BASE);
  }
  for (const k of c.out.keys()) if (!b.out.has(k)) bad(k, 'a Muse block that ' + BASE + ' does not have');
}

// b. every Muse-named file in glasses/home-app/src
const srcDir = 'glasses/home-app/src';
const baseMuse = git('ls-tree', '--name-only', BASE, srcDir + '/').toString().trim().split('\n').filter(n => /muse/i.test(path.basename(n)));
if (baseMuse.length === 0) bad('home-app Muse files', 'none found in ' + BASE);
for (const n of baseMuse) whole(n);
const dirNow = path.join(root, srcDir);
if (!existsSync(dirNow)) bad(srcDir, 'missing from the tree');
else for (const f of readdirSync(dirNow)) if (/muse/i.test(f) && !baseMuse.includes(srcDir + '/' + f)) bad(srcDir + '/' + f, 'a Muse file that ' + BASE + ' does not have');

console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
