import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InputQueue, REMOTE_HOLD_MS } from '../src/inputqueue';
import { INTERNAL_MENU } from '../src/menu';
import { HomeModel, type HomeData } from '../src/model';
import { Tiles, normalizeLayout, type TileContext } from '../src/tiles';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const data: HomeData = { now: 1000, paused: false, machines: [], sessions: [], pending: [], messages: null, muse: false };
const ctx: TileContext = { data, now: 1000, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null };

function rig(kind: 'home' | 'tiles' | 'opener' = 'home', gate?: Promise<void>) {
  const model = new HomeModel(); model.update(data);
  const tiles = new Tiles(); tiles.setLayout(normalizeLayout({ pages: [{ left: 'clock', right: 'empty' }] }));
  const events: string[] = [];
  // A screen where a remote up opens something (so it must wait until it cannot be part of a hold).
  const opener = { highlighted: 0, input: (_input: string, _at: number) => ({ kind: 'open' as const }) };
  let opened = 0, settings = false;
  const screen = () => settings ? 'settings' : kind;
  const state = () => kind === 'tiles' ? JSON.stringify(tiles.render(ctx)) : model.render(1000);
  const queue = new InputQueue({
    apply: input => { events.push(input); if (kind === 'home') model.input(input, 1000); else if (kind === 'tiles') tiles.input(input, ctx); else if (opener.input(input, Date.now()).kind === 'open') opened++; },
    menu: () => { events.push('settings'); settings = true; },
    captureRemoteUp: () => kind === 'tiles' ? tiles.capturePosition() : model.capturePosition(),
    holdRemoteUp: () => kind === 'opener',
    foreground: () => true, generation: () => model.generation, screen,
    settled: () => gate ? gate.then(() => 'rendered' as const) : Promise.resolve('rendered' as const),
    log: () => {},
  });
  return { model, tiles, opener, queue, state, events, get opened() { return opened; }, get settings() { return settings; } };
}

test('Home remote up applies immediately and hold-up restores the previous selection', async () => {
  const r = rig(); r.model.input('down', 1000); const before = r.state();
  r.queue.push('up', 'remote');
  assert.notEqual(r.state(), before);
  r.queue.pushMenu(INTERNAL_MENU.settings, 'remote'); await sleep(10);
  assert.equal(r.state(), before); assert.deepEqual(r.events, ['up', 'settings']);
});

test('Tiles page, focus, scroll and menu position are restored', async () => {
  for (const setup of [[], ['select'], ['select', 'select'], ['select', 'select', 'select']] as const) {
    const r = rig('tiles');
    for (const input of setup) r.tiles.input(input, ctx);
    const before = r.state(); r.queue.push('up', 'remote'); r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
    await sleep(10); assert.equal(r.state(), before, setup.join(','));
  }
});

test('a scrolled tile returns to its exact offset, including at the scroll boundary', () => {
  const tiles = new Tiles();
  tiles.setLayout(normalizeLayout({ pages: [{ left: 'url:demo', right: 'empty' }] }));
  const longCtx: TileContext = { ...ctx, url: () => ({ title: 'Long', lines: Array.from({ length: 30 }, (_, i) => `line ${i}`), actions: [] }) };
  tiles.input('select', longCtx); tiles.input('select', longCtx);
  for (let i = 0; i < 5; i++) tiles.input('down', longCtx);
  const before = JSON.stringify(tiles.render(longCtx));
  const undo = tiles.capturePosition(); tiles.input('up', longCtx);
  assert.notEqual(JSON.stringify(tiles.render(longCtx)), before);
  undo(); assert.equal(JSON.stringify(tiles.render(longCtx)), before);
});

test('touch ups, older remote ups and intervening presses are not undone', async () => {
  for (const which of ['touch', 'old', 'intervening'] as const) {
    const r = rig(); r.model.input('down', 1000); r.model.input('down', 1000);
    r.queue.push('up', which === 'touch' ? 'touch' : 'remote'); await sleep(10);
    if (which === 'old') await sleep(REMOTE_HOLD_MS + 20);
    if (which === 'intervening') { r.queue.push('down', 'remote'); await sleep(10); }
    const after = r.state(); r.queue.pushMenu(INTERNAL_MENU.settings, 'remote'); await sleep(10);
    assert.equal(r.state(), after, which);
  }
});

test('queued up and settings preserve order and undo only after up executes', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const r = rig('home', gate); r.model.input('down', 1000); r.model.input('down', 1000);
  r.queue.push('down', 'touch'); const before = r.state();
  r.queue.push('up', 'remote'); r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  release(); await sleep(20);
  assert.equal(r.state(), before); assert.deepEqual(r.events, ['down', 'up', 'settings']);
});

test('an unsolicited screen change prevents restoring a snapshot onto the new screen', async () => {
  let gen = 0, position = 4, restored = 0;
  const q = new InputQueue({
    apply: () => { position--; }, menu: () => {}, generation: () => gen, foreground: () => true,
    screen: () => 'home', settled: () => Promise.resolve('rendered' as const), log: () => {},
    captureRemoteUp: () => { const was = position; return () => { restored++; position = was; }; },
  });
  q.push('up', 'remote'); await sleep(10); gen++;
  q.pushMenu(INTERNAL_MENU.settings, 'remote'); await sleep(10);
  assert.equal(restored, 0); assert.equal(position, 3);
});

test('a deferred remote up in a hold never opens the highlighted item', async () => {
  const r = rig('opener'); const highlight = r.opener.highlighted;
  r.queue.push('up', 'remote'); r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await sleep(30); assert.equal(r.opened, 0); assert.equal(r.settings, true); assert.equal(r.opener.highlighted, highlight);
});

test('a deferred remote up alone opens after the hold window', async () => {
  const r = rig('opener'); r.queue.push('up', 'remote'); await sleep(50); assert.equal(r.opened, 0);
  await sleep(REMOTE_HOLD_MS + 30); assert.equal(r.opened, 1);
});

test('startup routes the remote settings through the queue', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /inputQueue\.pushMenu\(INTERNAL_MENU\.settings, 'remote'\)/);
});
