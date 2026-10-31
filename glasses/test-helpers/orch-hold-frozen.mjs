// Read-only preservation gate for ORCH-HOLD.md. The reference cannot be changed by environment.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
// Muse Listen is removed: no live-hook regions remain, so there is nothing to strip.
const stripHook = source => source;
import { fileURLToPath } from 'node:url';

const RELEASE = '03f7bcf2cba3bd17ab501356347ad969e73a0877';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const current = path.resolve(process.argv[2] || repo);
const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
const original = name => git('show', `${RELEASE}:${name}`);
const working = name => {
  let at = current;
  for (const part of name.split('/')) { at = path.join(at, part); if (lstatSync(at).isSymbolicLink()) throw new Error('symlink in frozen path'); }
  return readFileSync(at);
};
const baselineFiles = git('ls-tree', '-r', '--name-only', RELEASE, '--', 'glasses').toString().trim().split('\n');
let passed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed++; } catch (error) { failures.push(`${label}: ${error.message}`); }
}
function equal(a, b) { if (!a.equals(b)) throw new Error('differs from released 0.4.28'); }

// Files this removal (0.4.30) deleted: Muse Listen (hub + app) was added after the Muse freeze, Desk before it.
const REMOVED = new Set(['glasses/muse-queue.mjs', 'glasses/muse-queue.test.mjs']);
const whole = new Set(baselineFiles.filter(name => /muse/i.test(name) && !REMOVED.has(name)));
for (const name of [
  ...['tiles', 'remote', 'musecache', 'musepoll', 'musesync', 'shownwatch', 'settle'].map(n => `glasses/home-app/src/${n}.ts`),
]) whole.add(name);
for (const name of [...whole].sort()) check(name, () => equal(original(name), working(name)));

// Files the removal had to change are pinned to their reviewed post-removal bytes instead (sha256), so any
// later change still needs review. Their Muse parts are proved byte-identical to 56fe3b2 by test-muse-frozen.sh.
const REMOVAL_PINS = {
  'glasses/hud-server.mjs': '756d582d7ebc808b8ad6a8fb978fd20677001cf9827ff110274d8946903b9c81',
  'glasses/home-app/tests/small-0427.test.ts': '6e37890bc3cf2dfb1957200f6b96e92f21db799834620b6426c9ed522ad5d348',
};
for (const [name, digest] of Object.entries(REMOVAL_PINS)) {
  check(name + ' (post-removal pin)', () => {
    if (createHash('sha256').update(working(name)).digest('hex') !== digest) throw new Error('differs from the reviewed 0.4.30 bytes');
  });
}

// Desk (test) was removed from home-app after the 0.4.28 release. These exact phrases are the only Desk text
// inside the otherwise frozen Muse/menu/paint spans; the reference is read with them taken out.
const DESK_PHRASES = [
  ['!showingDesk() && ', ''], [', the Desk, display off', ', display off'], [', Home, Desk)', ', Home)'], [', Desk)', ')'],
  [' && foreground && !showingDesk()', ' && foreground'], ["showingDesk() ? 'desk' : ", ''], [' || showingDesk()', ''],
  ['  } else if (showingDesk()) {\n    preview = desk!.render();\n    glasses.setText(preview);\n', ''],
];
function deskFree(text) {
  for (const [from, to] of DESK_PHRASES) text = text.split(from).join(to);
  // The launcher line for Muse lived inside the Desk's own app opener, which is gone with the Desk.
  return text.split('\n').filter(line => !/showingDesk\(\)\) \{ deskMode|leaveDesk\(\);\s*$|^    if \(app === 'muse'\) \{ model\.goTo\('muse'\); void run\(\{ kind: 'loadMuse' \}\); \}$/.test(line)).join('\n');
}

// Only the literal additive id3 entry is allowed; all previous menu bytes remain pinned.
exactMenu();
function exactMenu() {
  check('menu.ts: released menu without the removed Muse Listen item', () => {
    const name = 'glasses/home-app/src/menu.ts';
    let text = original(name).toString();
    text = text.replace('// Muse Listen hook: the one remaining SDK menu slot.\n', '');
    text = text.replace(', listen: 3', '');
    text = text.replace("  // Muse Listen hook: keep the original Muse item unchanged.\n  { id: MENU.listen, name: 'Muse Listen' },\n", '');
    equal(Buffer.from(text), working(name));
  });
}

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
// The frozen proof itself is the only Muse-named file this removal adds.
const MUSE_PROOF = new Set(['glasses/test-muse-frozen.sh', 'glasses/test-helpers/muse-frozen-check.mjs', 'glasses/test-helpers/muse-frozen-mutations.test.mjs']);
check('no added Muse path', () => {
  const extra = walk('glasses').filter(n => /muse/i.test(n) && !whole.has(n) && !MUSE_PROOF.has(n));
  if (extra.length) throw new Error(extra.join(', '));
});

// The shared files retain these exact release spans. Anchors are unique and missing/ambiguous anchors fail closed.
function span(source, start, end) {
  if (source.split(start).length !== 2) throw new Error(`missing or ambiguous start: ${start.trim()}`);
  if (source.split(end).length !== 2) throw new Error(`missing or ambiguous end: ${end.trim()}`);
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
  check(`${name}: ${label}`, () => equal(Buffer.from(select(deskFree(original(name).toString()))), Buffer.from(select(working(name).toString()))));
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
]) exact(main, label, s => block(label === 'glasses menu behavior' ? stripHook(s, 'live-menu') : s, marker));
// Single-line Muse branches and handlers must also retain exact source and order.
for (const [name, pattern] of [
  [model, /^.*(?:private museLines:|if \(d\.muse\)|if \(target.kind === 'muse'\) \{|s\.kind === 'confirm' && s\.muse|if \(kind === 'muse'\)).*$/gm],
  [main, /^.*(?:import .*Muse|import .*muse|askMuse|api\/muse|api\s*\(\s*[\'"`]muse(?:\/|[\'"`])|let urgentPaint =|let prevKind =|onDrawn:|const museShown =|const museTile =|muse: \(\)|if \(app === 'muse'\)|if \(id === MENU\.muse\)).*$/gm],
]) exact(name, 'Muse dispatch lines', s => [...s.matchAll(pattern)].map(m => m[0]).join('\n'));
check('main.ts: original paint body preserved', () => {
  const old = block(deskFree(original(main).toString()), 'function paint(): void {\n');
  const cur = block(stripHook(working(main).toString(), 'live-paint'), 'function paint(): void {\n');
  const hold = block(deskFree(git('show', `a742fa6:${main}`).toString()), 'function paint(): void {\n');
  if (cur !== old && cur !== hold) throw new Error('unreviewed paint addition or changed preserved body');
  const body = old.slice(old.indexOf('\n') + 1, old.lastIndexOf('\n')).trim();
  if (!cur.includes(body)) throw new Error('original paint body changed; agent scheduling must be additive');
});

for (const failure of failures) console.error(`  FAIL  ${failure}`);
console.log(`${passed} passed, ${failures.length} failed (Muse/menu/Tiles frozen to ${RELEASE.slice(0, 7)})`);
process.exitCode = failures.length ? 1 : 0;
