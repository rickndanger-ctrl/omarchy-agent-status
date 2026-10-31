// Read-only gate mutation proof. All edits are confined to a disposable release snapshot.
import { test } from 'node:test';
import { hooks } from './listen-frozen-hooks.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gate = path.join(repo, 'glasses/test-helpers/orch-hold-frozen.mjs');
const release = '03f7bcf2cba3bd17ab501356347ad969e73a0877';
function fixture(change, accepts = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'listen-frozen-'));
  const edit = (name, fn) => {
    const p = path.join(dir, name);
    writeFileSync(p, fn(readFileSync(p, 'utf8')));
  };
  try {
    const archive = execFileSync('git', ['-C', repo, 'archive', release, 'glasses'], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    change(dir, edit);
    const result = spawnSync(process.execPath, [gate, dir], { encoding: 'utf8' });
    assert.equal(result.status === 0, accepts, result.stdout + result.stderr);
    if (!accepts) assert.match(result.stderr, /  FAIL  /, 'must reject via preservation check, not process error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const model = 'glasses/home-app/src/model.ts';
const main = 'glasses/home-app/src/main.ts';
test('unmodified release passes', () => fixture(() => {}, true));
test('Listen-only module and exact additive menu item pass', () => fixture((dir, edit) => {
  mkdirSync(path.join(dir, 'glasses/home-app/src/listen'));
  writeFileSync(path.join(dir, 'glasses/home-app/src/listen/screen.ts'), 'export const screen = "Listen";\n');
  edit('glasses/home-app/src/menu.ts', s => s.replace('export const MENU = { ', '// Muse Listen hook: the one remaining SDK menu slot.\nexport const MENU = { ').replace('hideOldTexts: 1 };', 'hideOldTexts: 1, listen: 3 };').replace("  { id: MENU.muse, name: 'Muse' },\n", "  { id: MENU.muse, name: 'Muse' },\n  // Muse Listen hook: keep the original Muse item unchanged.\n  { id: MENU.listen, name: 'Muse Listen' },\n"));
}, true));
test('changed Muse rendering fails', () => fixture((_, edit) => edit(model, s => s.replace('const MUSE_CHROME =', 'const MUSE_CHROME = /* changed */'))));
test('added untracked Muse file fails', () => fixture(dir => writeFileSync(path.join(dir, 'glasses/home-app/src/new-muse.ts'), '// alternate Muse')));
test('added Muse symlink fails', () => fixture(dir => symlinkSync('/dev/null', path.join(dir, 'glasses/home-app/src/new-muse.ts'))));
test('deleted Muse file fails', () => fixture(dir => rmSync(path.join(dir, 'glasses/home-app/src/musecache.ts'))));
test('replaced frozen file with identical-content symlink fails', () => fixture(dir => {
  const p = path.join(dir, 'glasses/home-app/src/musecache.ts');
  writeFileSync(path.join(dir, 'copy.ts'), readFileSync(p)); rmSync(p); symlinkSync(path.join(dir, 'copy.ts'), p);
}));
test('missing start anchor fails', () => fixture((_, edit) => edit(model, s => s.replace('const MUSE_CHROME', 'const RENAMED_CHROME'))));
test('ambiguous start anchor fails', () => fixture((_, edit) => edit(model, s => s + '\n// const MUSE_CHROME\n')));
test('missing end anchor fails', () => fixture((_, edit) => edit(model, s => s.replace('const OLD_TEXT_S', 'const RENAMED_OLD_TEXT_S'))));
test('ambiguous end anchor fails', () => fixture((_, edit) => edit(model, s => s + '\n// const OLD_TEXT_S\n')));
test('missing route anchor fails', () => fixture((_, edit) => edit(main, s => s.replace("    } else if (action.kind === 'askMuse') {\n", "    } else if (action.kind === 'askRenamed') {\n"))));
test('changed old menu routing fails', () => fixture((_, edit) => edit(main, s => s.replace("if (id === MENU.muse) { model.goTo('muse');", "if (id === MENU.muse) { model.goTo('home');"))));
test('changed original paint body fails', () => fixture((_, edit) => edit(main, s => s.replace("  $('glass').textContent = preview;", "  $('glass').textContent = 'changed';"))));
test('unreviewed menu id fails', () => fixture((_, edit) => edit('glasses/home-app/src/menu.ts', s => s.replace('MENU = { ', 'MENU = { listen: 13, '))));

test('new unreviewed Muse dispatch fails', () => fixture((_, edit) => edit(main, s => s + "\nfunction hidden() { return api('muse/new'); }\n")));

test('reviewed additive paint/menu hooks pass with every original byte preserved', () => fixture((_, edit) => edit(main, s => s.replace('function paint(): void {\n', 'function paint(): void {\n' + hooks['live-paint']).replace("async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n", "async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n" + hooks['live-menu'])), true));
test('Listen hook cannot redirect Muse routing', () => fixture((_, edit) => edit(main, s => s.replace("async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n", "async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n" + hooks['live-menu'].replace('model.goListen()', "model.goTo('muse')")))));
test('Listen hook cannot alter the old Muse menu item', () => fixture((_, edit) => edit(main, s => s.replace("async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n", "async function menu(id: number, source: InputSource = 'touch'): Promise<void> {\n" + hooks['live-menu'].replace('MENU.listen', 'MENU.muse')))));
test('duplicate reviewed hook fails', () => fixture((_, edit) => edit(main, s => s.replace('function paint(): void {\n', 'function paint(): void {\n' + hooks['live-paint'].repeat(2)))));
test('missing hook end marker fails', () => fixture((_, edit) => edit(main, s => s.replace('function paint(): void {\n', 'function paint(): void {\n' + hooks['live-paint'].replace('  // Muse Listen hook END live-paint\n', '')))));
test('arbitrary additive paint code fails', () => fixture((_, edit) => edit(main, s => s.replace('function paint(): void {\n', 'function paint(): void {\n  unexpectedSideEffect();\n'))));
