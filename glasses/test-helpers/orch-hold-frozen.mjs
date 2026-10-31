// Read-only preservation gate for ORCH-HOLD.md. The reference cannot be changed by environment.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = '03f7bcf2cba3bd17ab501356347ad969e73a0877';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const current = path.resolve(process.argv[2] || repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
const original = name => git('show', `${RELEASE}:${name}`);
const working = name => readFileSync(path.join(current, name));
const baselineFiles = git('ls-tree', '-r', '--name-only', RELEASE, '--', 'glasses').toString().trim().split('\n');
let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed++; } catch (error) { failures.push(`${label}: ${error.message}`); }
}
function equal(a, b) { if (!a.equals(b)) throw new Error('differs from released 0.4.28'); }

const whole = new Set(baselineFiles.filter(name => /muse/i.test(name)));
for (const name of [
  'glasses/hud-server.mjs', 'glasses/listen.mjs', 'glasses/listen-g2.mjs', 'glasses/listen-page.mjs',
  'glasses/test-listen-frozen.sh', 'glasses/test-listen-join.sh',
  ...['menu', 'tiles', 'desk', 'deskpointer', 'remote', 'musecache', 'musepoll', 'musesync', 'shownwatch', 'settle'].map(n => `glasses/home-app/src/${n}.ts`),
  'glasses/home-app/tests/listen-bounce.test.ts', 'glasses/home-app/tests/small-0427.test.ts',
]) whole.add(name);
for (const name of [...whole].sort()) check(name, () => equal(original(name), working(name)));

// New Muse files cannot introduce a replacement path outside the frozen files.
function walk(dir) {
  const names = [];
  for (const item of readdirSync(path.join(current, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(item.name)) continue;
    const name = `${dir}/${item.name}`;
    if (item.isDirectory()) names.push(...walk(name));
    else if (item.isFile() || item.isSymbolicLink()) names.push(name);
  }
  return names;
}
check('no added Muse path', () => {
  const extra = walk('glasses').filter(n => /muse/i.test(n) && !whole.has(n));
  if (extra.length) throw new Error(extra.join(', '));
});

// The shared files retain these exact release spans. Anchors are unique and missing/ambiguous anchors fail closed.
function span(source, start, end) {
  if (source.split(start).length !== 2) throw new Error(`missing or ambiguous start: ${start.trim()}`);
  const from = source.indexOf(start), until = source.indexOf(end, from + start.length);
  if (until < 0) throw new Error(`missing end: ${end.trim()}`);
  return source.slice(from, until);
}
function block(source, start) {
  if (source.split(start).length !== 2) throw new Error(`missing or ambiguous block: ${start.trim()}`);
  const from = source.indexOf(start), lineStart = source.lastIndexOf('\n', from - 1) + 1;
  const firstEnd = source.indexOf('\n', from), first = source.slice(lineStart, firstEnd);
  const indent = /^\s*/.exec(first)[0];
  if (!first.trimEnd().endsWith('{')) return first;
  let at = firstEnd + 1;
  while (at < source.length) {
    const end = source.indexOf('\n', at), line = source.slice(at, end < 0 ? source.length : end);
    if (line.startsWith(indent + '}') && !line.startsWith(indent + '  ')) return source.slice(lineStart, at + indent.length + 1);
    at = end < 0 ? source.length : end + 1;
  }
  throw new Error(`unterminated block: ${start.trim()}`);
}
function exact(name, label, select) {
  check(`${name}: ${label}`, () => equal(Buffer.from(select(original(name).toString())), Buffer.from(select(working(name).toString()))));
}
const model = 'glasses/home-app/src/model.ts', main = 'glasses/home-app/src/main.ts';
exact(model, 'Muse action and screen declarations', s => s.split('\n').filter(line => /\| \{ kind: '(?:loadMuse|askMuse|muse|listen|confirm)'|const CONFIRM_CHOICES =|^  muse: boolean;/.test(line)).join('\n'));
exact('glasses/home-app/src/inputflow.ts', 'Muse remote-settings guard', s => block(s, 'export function remoteSettingsIgnored(screen: string): boolean {\n'));
exact(model, 'Muse display helper', s => span(s, 'const MUSE_CHROME', 'const OLD_TEXT_S'));
exact(model, 'Muse answer, history and pending state', s => span(s, '  // The Muse screen: the question as ONE line', '  showFlash('));
exact(model, 'shared voice transcript fallback', s => {
  const fallback = span(s, "    if (s.kind !== 'listen') return;", '  setError(');
  // This one reviewed addition only rejects an unbound legacy AGENT transcript. Muse remains bound by s.muse.
  const guard = '    if (!s.chat && !s.muse && !s.reminder && !s.start) return; // No unbound legacy agent transcript.\n';
  if (fallback.split(guard).length > 2) throw new Error('duplicate legacy agent guard');
  return fallback.replace(guard, '');
});
for (const [label, marker] of [
  ['opening Muse', "    if (target.kind === 'muse') {\n"],
  ['listening controls', "    if (s.kind === 'listen') {\n"],
  ['confirming a Muse question', "    if (s.kind === 'confirm' && s.muse && input === 'select') {\n"],
  ['starting a Muse question', "    if (s.kind === 'muse' && input === 'select') {\n"],
  ['scrolling Muse', "    if (s.kind === 'muse') {\n"],
  ['Muse voice screen rendering', "    } else if ((s.kind === 'confirm' || s.kind === 'listen') && s.muse) {\n"],
  ['Muse answer rendering', "    } else if (s.kind === 'muse') {\n"],
]) exact(model, label, s => block(['listening controls', 'confirming a Muse question', 'starting a Muse question', 'scrolling Muse'].includes(label) ? span(s, '  input(', '  render(') : s, marker));
for (const [label, marker] of [
  ['Muse ask transport and polling', "    } else if (action.kind === 'askMuse') {\n"],
  ['Muse latest transport', "    } else if (action.kind === 'loadMuse') {\n"],
  ['Muse tile refresh', "        } else if (need.kind === 'muse') {\n"],
  ['Tiles refresh function', 'async function refreshTiles(): Promise<void> {\n'],
  ['glasses menu behavior', "async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n"],
]) exact(main, label, s => block(s, marker));
// Single-line Muse branches and handlers must also retain exact source and order.
for (const [name, pattern] of [
  [model, /^.*(?:private museLines:|if \(d\.muse\)|if \(target.kind === 'muse'\) \{|s\.kind === 'confirm' && s\.muse|if \(kind === 'muse'\)).*$/gm],
  [main, /^.*(?:import .*Muse|import .*muse|let urgentPaint =|let prevKind =|onDrawn:|const museShown =|const museTile =|muse: \(\)|if \(app === 'muse'\)|if \(id === MENU\.muse\)).*$/gm],
]) exact(name, 'Muse dispatch lines', s => [...s.matchAll(pattern)].map(m => m[0]).join('\n'));
check('main.ts: original paint body preserved', () => {
  const old = block(original(main).toString(), 'function paint(): void {\n');
  const cur = block(working(main).toString(), 'function paint(): void {\n');
  const body = old.slice(old.indexOf('\n') + 1, old.lastIndexOf('\n')).trim();
  if (!cur.includes(body)) throw new Error('original paint body changed; agent scheduling must be additive');
});

for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`${passed} passed, ${failures.length} failed (Muse/menu/Tiles frozen to ${RELEASE.slice(0, 7)})`);
process.exitCode = failures.length ? 1 : 0;
