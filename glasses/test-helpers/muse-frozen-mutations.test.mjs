// Mutation test for muse-frozen-check.mjs: the clean tree passes; each kind of change makes it fail.
//   node glasses/test-helpers/muse-frozen-mutations.test.mjs   (run from a temp dir, never from the repo)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const checker = path.join(here, 'muse-frozen-check.mjs');
const files = ['glasses/hud-server.mjs', 'glasses/muse-clean.mjs',
  ...readdirSync(path.join(repo, 'glasses/home-app/src')).filter(f => /muse/i.test(f)).map(f => 'glasses/home-app/src/' + f)];
let passed = 0, failed = 0;
const t = (name, okay) => { console.log((okay ? '  ok    ' : '  FAIL  ') + name); okay ? passed++ : failed++; };

function tree() {
  const d = mkdtempSync(path.join(tmpdir(), 'muse-frozen-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); copyFileSync(path.join(repo, f), path.join(d, f)); }
  return d;
}
const run = d => spawnSync('node', [checker, d], { encoding: 'utf8' }).status;
function mutate(file, fn) {
  const d = tree(); const p = path.join(d, file);
  const before = readFileSync(p, 'utf8'); const after = fn(before);
  if (after === before) throw new Error('mutation changed nothing: ' + file);
  writeFileSync(p, after); const rc = run(d); rmSync(d, { recursive: true, force: true }); return rc;
}
const hud = 'glasses/hud-server.mjs';

{ const d = tree(); t('clean tree passes', run(d) === 0); rmSync(d, { recursive: true, force: true }); }
t('changed askMuse line fails', mutate(hud, s => s.replace('if (!health.ok || !health.composer) continue', 'if (!health.ok) continue')) !== 0);
t('changed museReply fails', mutate(hud, s => s.replace('const { text, trimmed, anchor } = sanitizeMuseReply(raw, { partial })', 'const { text, trimmed, anchor } = sanitizeMuseReply(raw, { partial: true })')) !== 0);
t('changed /api/muse route fails', mutate(hud, s => s.replace("p === '/api/muse/reply'", "p === '/api/muse/reply2'")) !== 0);
t('changed museMoving fails', mutate(hud, s => s.replace('const museMoving = new Set()', 'const museMoving = new Set([1])')) !== 0);
t('deleted askMuse anchor fails', mutate(hud, s => s.replace('async function askMuse(', 'async function askMuse2(')) !== 0);
t('deleted museTrimLogged anchor fails', mutate(hud, s => s.replace('const museTrimLogged', 'const museTrimLoggedX')) !== 0);
t('deleted route anchor fails', mutate(hud, s => s.replace("p === '/api/muse/ask'", "p === '/api/x/ask'")) !== 0);
t('changed muse-clean.mjs fails', mutate('glasses/muse-clean.mjs', s => s + '\n// x\n') !== 0);
for (const f of files.filter(x => x.includes('home-app')))
  t('changed ' + path.basename(f) + ' fails', mutate(f, s => s + '\n// x\n') !== 0);
{ const d = tree(); rmSync(path.join(d, 'glasses/home-app/src/musepoll.ts')); t('deleted Muse file fails', run(d) !== 0); rmSync(d, { recursive: true, force: true }); }
{ const d = tree(); writeFileSync(path.join(d, 'glasses/home-app/src/musenew.ts'), 'x'); t('added Muse file fails', run(d) !== 0); rmSync(d, { recursive: true, force: true }); }
{ const d = tree(); writeFileSync(path.join(d, hud), readFileSync(path.join(d, hud), 'utf8') + "\nif (req.method === 'GET' && p === '/api/muse/extra') {\n  x()\n}\n"); t('added /api/muse route fails', run(d) !== 0); rmSync(d, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
