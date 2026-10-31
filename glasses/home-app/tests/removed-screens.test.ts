// Muse Listen and Desk (test) were removed in 0.4.30. Whatever an older version saved about them (phone-page switches, a Tiles
// layout naming their tiles, a remembered layout) must load cleanly: ignored or an empty tile, no crash, no stale Home row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LayoutLoader, parseCachedLayout } from '../src/layoutcache';
import { GLASSES_MENU, GLASSES_MENU_MAX, MENU, setHideDone } from '../src/menu';
import { HomeModel, type HomeData } from '../src/model';
import { DEFAULT_LAYOUT, Tiles, normalizeLayout, type TileContext } from '../src/tiles';

const data: HomeData = { now: 1000, paused: false, machines: [{ name: 'Mini 1', online: true }], sessions: [], pending: [], messages: null, muse: true };
const ctx: TileContext = { data, now: 1000, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null };

// What an older build left in the phone's storage (localStorage), next to settings that still exist.
const OLD_SETTINGS: Record<string, string> = {
  'home.deskSwap': '1', 'home.deskInvX': '1', 'home.deskInvY': '0', 'home.listen': '1', 'home.museListen': '1',
  'home.hideDone': '1', 'home.hideOldTexts': '0', 'home.outline': '9', 'home.brightness': '3', 'home.tiles': '1',
};
const OLD_LAYOUT = { pages: [{ left: 'desk', right: 'listen' }, { left: 'museListen', right: 'muse' }, { left: 'clock', right: 'deskpointer' }, {}, { left: 'studio', right: 'messages' }] };

test('Home shows no Muse Listen or Desk row, whatever was saved', () => {
  const m = new HomeModel();
  m.hideDone = OLD_SETTINGS['home.hideDone'] === '1';
  m.update(data);
  const text = m.render(1000);
  assert.doesNotMatch(text, /listen|desk/i);
  for (let i = 0; i < 20; i++) { m.input('down', 1000 + i); assert.doesNotMatch(m.render(1000 + i), /muse listen|desk \(test\)/i); }
  assert.match(text, /Tiles/);
});

test('the glasses menu has no Listen or Desk item and stays within the SDK limit', () => {
  assert.ok(GLASSES_MENU.length <= GLASSES_MENU_MAX);
  assert.equal(GLASSES_MENU.length, 9);
  assert.equal(GLASSES_MENU.some(m => /listen|desk/i.test(m.name)), false);
  assert.equal(Object.keys(MENU).some(k => /listen|desk/i.test(k)), false);
});

test('a saved Tiles layout naming desk/listen tiles loads as empty tiles and keeps the rest', () => {
  const layout = normalizeLayout(OLD_LAYOUT);
  assert.equal(layout.pages.length, DEFAULT_LAYOUT.pages.length);
  assert.deepEqual(layout.pages[0], { left: 'empty', right: 'empty' });
  assert.deepEqual(layout.pages[1], { left: 'empty', right: 'muse' });
  assert.deepEqual(layout.pages[2], { left: 'clock', right: 'empty' });
  assert.deepEqual(layout.pages[4], { left: 'studio', right: 'messages' });
  const tiles = new Tiles(); tiles.setLayout(OLD_LAYOUT as never);
  for (let page = 0; page < layout.pages.length; page++) {
    const frame = tiles.render(ctx);
    assert.doesNotMatch(frame.left + frame.right, /listen|desk/i);
    tiles.input('down', ctx); // next page; must never throw on an emptied slot
  }
});

test('a remembered (cached) layout naming desk/listen tiles is repaired when Home starts', async () => {
  const applied: unknown[] = [];
  const kv = new Map([['home.layout', JSON.stringify(OLD_LAYOUT)]]);
  const loader = new LayoutLoader({
    get: () => kv.get('home.layout') ?? '', set: v => { kv.set('home.layout', v); },
    fetch: async () => OLD_LAYOUT, apply: l => { applied.push(l); }, after: () => {},
  });
  assert.deepEqual(parseCachedLayout(kv.get('home.layout')!)?.pages[0], { left: 'empty', right: 'empty' });
  loader.start(); await new Promise(r => setImmediate(r));
  assert.ok(applied.length >= 1);
  assert.doesNotMatch(kv.get('home.layout')!, /desk|listen/i, 'the repaired layout is what is remembered');
});

test('old desk/listen settings in storage are never read, and the settings that still exist still work', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/store\.(?:get|set)\('(home\.[A-Za-z.]+)'/g)].map(x => x[1]);
  assert.ok(keys.length > 5);
  for (const k of keys) assert.doesNotMatch(k, /desk|listen/i, k);
  assert.doesNotMatch(src, /desk-swap|desk-inv|home\.desk|home\.listen/i, 'no phone-page switches');
  const store = { get: (k: string) => OLD_SETTINGS[k] ?? '', set: (k: string, v: string) => { OLD_SETTINGS[k] = v; } };
  const m = new HomeModel();
  setHideDone(m, store, store.get('home.hideDone') === '1');
  assert.equal(m.hideDone, true);
  m.hideOldTexts = store.get('home.hideOldTexts') !== '0';
  assert.equal(m.hideOldTexts, false);
  m.update(data);
  assert.doesNotThrow(() => m.render(1000));
});
