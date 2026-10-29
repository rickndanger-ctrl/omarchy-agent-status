import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubPicker } from '../src/hubpick.ts';
import { MuseCache, MUSE_UNREACHABLE } from '../src/musecache.ts';
import { widgetFor, type TileContext } from '../src/tiles.ts';

const MINI1 = 'https://mini1.ts.net/hud/';
const NEO = 'https://neo.ts.net/hud/';
const MINI2 = 'https://mini2.ts.net/hud/';
const HUBS = [MINI1, NEO];
const T0 = 1_000_000;

test('a stored Mini 2 (not in HUBS) is dropped: the first request goes to Mini 1', () => {
  const p = new HubPicker(HUBS, '', MINI2, T0);
  assert.equal(p.staleStored, true);
  assert.deepEqual(p.order(), [MINI1, NEO]);
  assert.equal(p.allowed(MINI2), false);
  p.useHub(MINI2, T0); // never adopted
  assert.equal(p.current, MINI1);
});

test('a stored hub that is allowed is kept and tried first; the rest follow in HUBS order', () => {
  const p = new HubPicker(HUBS, '', NEO, T0);
  assert.equal(p.staleStored, false);
  assert.deepEqual(p.order(), [NEO, MINI1]);
  const three = new HubPicker([MINI1, NEO, 'https://x/hud/'], '', NEO, T0);
  assert.deepEqual(three.order(), [NEO, 'https://x/hud/', MINI1]);
});

test("the page's own address counts only if it is in HUBS", () => {
  assert.equal(new HubPicker(HUBS, NEO, '', T0).current, NEO);
  assert.equal(new HubPicker(HUBS, MINI2, '', T0).current, MINI1);
});

test('on Neo: no check for Mini 1 before 60 s, then one, and a healthy Mini 1 takes over', () => {
  const p = new HubPicker(HUBS, '', MINI1, T0);
  p.useHub(NEO, T0);                          // Mini 1 failed, Neo answered
  assert.equal(p.current, NEO);
  assert.equal(p.primaryCheckDue(T0 + 59_000), false);
  assert.equal(p.primaryCheckDue(T0 + 60_000), true);
  assert.equal(p.primaryCheckDue(T0 + 61_000), false); // at most one check a minute
  p.useHub(MINI1, T0 + 62_000);                // /api/health answered: back
  assert.equal(p.current, MINI1);
  assert.equal(p.primaryCheckDue(T0 + 200_000), false); // on the primary: nothing to check
});

test('hub names come from /api/health; both down reports name null and down', () => {
  const p = new HubPicker(HUBS, '', MINI1, T0);
  p.noteName(MINI1, 'Mini 1');
  assert.deepEqual(p.state(), { name: 'Mini 1', down: false });
  p.allFailed();
  assert.deepEqual(p.state(), { name: null, down: true });
  p.useHub(MINI1, T0 + 5);
  assert.deepEqual(p.state(), { name: 'Mini 1', down: false });
});

const clockCtx = (hub?: TileContext['hub']) => ({ data: null, now: T0, hub, terminal: () => null, chat: () => null, muse: () => null, reminders: () => null, url: () => null } as TileContext);
test('clock tile: last line says which hub, or that both are unreachable', () => {
  const w = widgetFor('clock');
  assert.equal(w.body(clockCtx({ name: 'Neo', down: false }), 27).at(-1), 'via Neo');
  assert.equal(w.body(clockCtx({ name: null, down: true }), 27).at(-1), 'Mini 1 and Neo unreachable');
  assert.ok(!w.body(clockCtx(), 27).join('\n').includes('via'));
});

test('Muse startup: nothing is read before the first /api/home, then exactly one read; a failure offers Retry', () => {
  const c = new MuseCache();
  assert.equal(c.pageFetchStart(0, false), null);       // data has not arrived yet
  assert.equal(c.pageFetchStart(0, false), null);
  const stamp = c.pageFetchStart(0, true);               // first poll succeeded
  assert.notEqual(stamp, null);
  assert.equal(c.pageFetchStart(0, true), null);        // exactly one read for this page view
  c.fetchFailed(stamp!);
  assert.equal(c.get(), MUSE_UNREACHABLE);
  const w = widgetFor('muse');
  const ctx = { ...clockCtx(), muse: () => c.get() } as TileContext;
  assert.deepEqual(w.body(ctx, 27), ["Muse: can't reach"]);
  assert.equal(w.actions(ctx)[0].id, 'retry');
  assert.deepEqual(w.act('retry', ctx), { kind: 'action', action: { kind: 'loadMuse' } });
  assert.equal(c.pageFetchStart(0, true), null);        // Retry is a tap, not a timer: still no automatic read
});

test('clock tile: the worst case (rain, battery, hub) fits in 8 lines and shows the hub', () => {
  const data = { now: T0, paused: false, machines: [], sessions: [], pending: [], messages: null, muse: false, weather: { temp: 12, desc: 'Cloudy', hi: 14, lo: 8, rainAt: '4 PM', rainChance: 70 } };
  const w = widgetFor('clock');
  const base = { ...clockCtx(), data, battery: 80 } as TileContext;
  const via = w.body({ ...base, hub: { name: 'Neo', down: false } }, 27);
  assert.ok(via.length <= 8, String(via.length));
  assert.ok(via.includes('Glasses 80% · via Neo'));
  assert.ok(via.every(l => l.length <= 27));
  const down = w.body({ ...base, hub: { name: null, down: true } }, 27);
  assert.ok(down.length <= 8, String(down.length));
  assert.ok(down.includes('Mini 1 and Neo unreachable'));
});
