// Quick settings: opened by the phone remote's "settings" and by a Home row; Display off, Brightness, Close app, Back.
// Real model, Tiles, queue and input flow; fake glasses state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData, type Input } from '../src/model';
import { Tiles, normalizeLayout, type TileContext } from '../src/tiles';
import { makeHandle, openSettings, runSettingsAction } from '../src/inputflow';
import { InputQueue, type InputSource } from '../src/inputqueue';
import { INTERNAL_MENU } from '../src/menu';
import { RemoteInput } from '../src/remote';

const NOW = Date.UTC(2026, 9, 29, 14, 32);
const data: HomeData = {
  now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: null, muse: false,
};

function rig(opts: { tiles?: boolean } = {}) {
  const model = new HomeModel();
  model.update(data);
  const tiles = new Tiles();
  tiles.setLayout(normalizeLayout({ pages: [{ left: 'clock', right: 'empty' }] }));
  const st = { blank: false, tilesActive: opts.tiles ?? false, fromTiles: false, brightness: 4, stored: [] as number[], closed: 0, applied: [] as string[] };
  const showing = () => st.tilesActive && !st.fromTiles;
  const ctx = (): TileContext => ({ data, now: NOW, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null });
  const settingsHost = {
    model, isBlank: () => st.blank, wake: () => { st.blank = false; }, setBlank: () => { st.blank = true; },
    showingTiles: showing, markOpenedFromTile: () => { st.fromTiles = true; }, returnToTiles: () => { if (st.tilesActive && st.fromTiles) st.fromTiles = false; },
    saveBrightness: (v: number) => { st.brightness = v; st.stored.push(v); }, closeApp: async () => { st.closed++; }, paint: () => {},
  };
  const apply = makeHandle({
    model, tiles, tileCtx: ctx, showingTiles: showing, inOpenedScreen: () => st.tilesActive && st.fromTiles,
    leaveTiles: () => { st.tilesActive = false; model.goHome(); }, backToTiles: () => { st.fromTiles = false; },
    paint: () => {}, isBlank: () => st.blank, wake: settingsHost.wake,
    runTileEffect: () => {},
    runModelAction: action => { st.applied.push(action.kind); return runSettingsAction(settingsHost, action).job as Promise<void> | undefined; },
    saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => NOW,
  });
  const log: string[] = [];
  let flips = 0; let was = showing();
  const generation = () => { const n = showing(); if (n !== was) { flips++; was = n; } return model.generation + flips; };
  const queue = new InputQueue({
    apply, menu: id => { if (st.blank) { settingsHost.wake(); return; } if (id === INTERNAL_MENU.settings) openSettings(settingsHost); },
    generation, foreground: () => true, screen: () => (showing() ? 'tiles' : model.screenKind), settled: () => Promise.resolve('rendered' as const),
    log: (n, d) => log.push(`${n} ${d}`),
  });
  const press = (source: InputSource, ...inputs: Input[]) => inputs.forEach(i => queue.push(i, source));
  const idle = () => new Promise(r => setTimeout(r, 25));
  return { model, queue, st, log, press, idle, text: () => model.render(NOW) };
}

test('the remote parses "settings" like the other buttons and it goes through the queue as a remote menu choice', async () => {
  const seen: string[] = [];
  let calls = 0;
  const remote = new RemoteInput({
    hub: () => 'https://hub.test/hud/', token: () => 't', active: () => true, apply: input => seen.push(input),
    fetch: (async () => {
      calls++;
      if (calls > 1) await new Promise(r => setTimeout(r, 200)); // later waits stay open (and yield to the timers)
      return new Response(JSON.stringify(calls === 1 ? { seq: 1, inputs: [{ seq: 1, input: 'settings' }, { seq: 2, input: 'bogus' }] } : { seq: 1, inputs: [] }));
    }) as typeof fetch,
    sleep: async () => {},
  });
  remote.sync();
  await new Promise(r => setTimeout(r, 20));
  remote.stop();
  assert.deepEqual(seen.slice(0, 1), ['settings']);
  const r = rig();
  r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await r.idle();
  assert.equal(r.model.screenKind, 'settings');
  assert.match(r.text(), /^QUICK SETTINGS$/m);
  assert.ok(r.log.some(l => l.startsWith('menu 12 from remote')));
  for (const row of ['> Display off', 'Brightness: 4 of 4', 'Close app', 'Back']) assert.ok(r.text().includes(row), row);
  assert.ok(r.text().split('\n').length <= 10);
});

test('Home row "Settings" opens it, from touch and from remote presses', async () => {
  for (const source of ['touch', 'remote'] as const) {
    const r = rig();
    r.press(source, 'down', 'select'); // Agents, Settings (no Messages/Muse in this data)
    await r.idle();
    assert.equal(r.model.screenKind, 'settings', source);
  }
});

test('Brightness cycles 1..4, is saved each time, and every value is valid for the glasses', async () => {
  const r = rig();
  r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await r.idle();
  r.press('remote', 'down'); // Brightness
  await r.idle();
  r.press('touch', 'select', 'select', 'select', 'select');
  await r.idle();
  assert.deepEqual(r.st.stored, [1, 2, 3, 4]);
  assert.match(r.text(), /Brightness: 4 of 4/);
  assert.ok(r.st.stored.every(v => v >= 0 && v <= 4));
});

test('Display off blanks; the next press or remote action wakes it and is NOT passed on', async () => {
  for (const wakeBy of ['touch', 'remote', 'settings'] as const) {
    const r = rig();
    r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
    await r.idle();
    r.press('touch', 'select'); // Display off
    await r.idle();
    assert.equal(r.st.blank, true);
    const screenBefore = r.model.screenKind; const cursorBefore = r.text();
    if (wakeBy === 'settings') r.queue.pushMenu(INTERNAL_MENU.settings, 'remote'); else r.press(wakeBy, 'down');
    await r.idle();
    assert.equal(r.st.blank, false, wakeBy);
    assert.equal(r.model.screenKind, screenBefore);
    assert.equal(r.text(), cursorBefore, `${wakeBy}: the wake press did nothing else`);
  }
});

test('Close app asks the glasses to shut down (confirm on the glasses); Back returns Home', async () => {
  const r = rig();
  r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await r.idle();
  r.press('remote', 'down', 'down', 'select'); // Close app
  await r.idle();
  assert.equal(r.st.closed, 1);
  assert.equal(r.model.screenKind, 'settings'); // the glasses confirm; the app stays until they do
  r.press('remote', 'down', 'select'); // Back
  await r.idle();
  assert.equal(r.model.screenKind, 'home');
});

test('double-tap is Back, also when Settings was opened from Tiles (returns to Tiles)', async () => {
  const r = rig();
  r.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await r.idle();
  r.press('touch', 'back');
  await r.idle();
  assert.equal(r.model.screenKind, 'home');
  const t = rig({ tiles: true });
  t.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await t.idle();
  assert.equal(t.st.fromTiles, true);
  assert.equal(t.model.screenKind, 'settings');
  t.press('touch', 'back');
  await t.idle();
  assert.equal(t.st.fromTiles, false); // back in Tiles
  t.queue.pushMenu(INTERNAL_MENU.settings, 'remote');
  await t.idle();
  t.press('remote', 'down', 'down', 'down', 'select'); // the Back row
  await t.idle();
  assert.equal(t.st.fromTiles, false);
});
