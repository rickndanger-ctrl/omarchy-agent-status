import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutLoader, parseCachedLayout } from '../src/layoutcache.ts';
import { DEFAULT_LAYOUT, Tiles, normalizeLayout, type Layout, type TileContext } from '../src/tiles.ts';

const CUSTOM: Layout = { pages: [{ left: 'clock', right: 'studio' }, ...DEFAULT_LAYOUT.pages.slice(1)] };
const HUB: Layout = { pages: [{ left: 'messages', right: 'muse' }, ...DEFAULT_LAYOUT.pages.slice(1)] };

function rig(cached = '') {
  const kv = new Map<string, string>(cached ? [['home.layout', cached]] : []);
  const applied: Layout[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let calls = 0;
  let answer: () => Promise<unknown> = async () => { throw new Error('down'); };
  const loader = new LayoutLoader({
    get: () => kv.get('home.layout') ?? '',
    set: v => { kv.set('home.layout', v); },
    fetch: () => { calls++; return answer(); },
    apply: l => { applied.push(l); },
    after: (ms, fn) => { timers.push({ ms, fn }); },
  });
  return { kv, applied, timers, loader, calls: () => calls, answer: (f: () => Promise<unknown>) => { answer = f; } };
}
const flush = () => new Promise(r => setImmediate(r));

test('a cached layout is shown before the hub answers', async () => {
  const r = rig(JSON.stringify(CUSTOM));
  r.answer(() => new Promise(() => {})); // the hub never answers
  r.loader.start();
  await flush();
  assert.deepEqual(r.applied, [normalizeLayout(CUSTOM)]);
});

test('garbage in the cache is ignored: nothing applied, the default stays', async () => {
  for (const junk of ['not json', '{"pages": 5}', 'null', '[]', '{"pages":[]}']) {
    assert.equal(parseCachedLayout(junk), null, junk);
  }
  const r = rig('{{{');
  r.answer(() => new Promise(() => {}));
  r.loader.start();
  await flush();
  assert.deepEqual(r.applied, []);
});

test('a fetched layout replaces the cached one and is stored; saving stores too', async () => {
  const r = rig(JSON.stringify(CUSTOM));
  r.answer(async () => HUB);
  r.loader.start();
  await flush();
  assert.deepEqual(r.applied.at(-1), normalizeLayout(HUB));
  assert.deepEqual(JSON.parse(r.kv.get('home.layout')!), normalizeLayout(HUB));
  r.loader.remember(CUSTOM);
  assert.deepEqual(JSON.parse(r.kv.get('home.layout')!), normalizeLayout(CUSTOM));
});

test('a failed first fetch retries after 2, 5 and 10 s, then leaves it to the 60 s timer', async () => {
  const r = rig();
  r.loader.start();
  await flush();
  assert.deepEqual(r.timers.map(t => t.ms), [2000]);
  r.timers.shift()!.fn(); await flush();
  assert.deepEqual(r.timers.map(t => t.ms), [5000]);
  r.timers.shift()!.fn(); await flush();
  assert.deepEqual(r.timers.map(t => t.ms), [10000]);
  r.timers.shift()!.fn(); await flush();
  assert.deepEqual(r.timers, []);                     // quick retries are over
  assert.equal(r.calls(), 4);
  r.loader.load(); await flush();                     // the existing 60 s timer calls load(): one fetch, no new quick retry
  assert.equal(r.calls(), 5);
  assert.deepEqual(r.timers, []);
});

test('a success ends the quick retries', async () => {
  const r = rig();
  r.loader.start();
  await flush();
  r.answer(async () => HUB);
  r.timers.shift()!.fn(); await flush();
  assert.deepEqual(r.applied.at(-1), normalizeLayout(HUB));
  assert.deepEqual(r.timers, []);
});

test('Start in Tiles opens on page 1, and a layout arriving later does not move you', () => {
  const t = new Tiles();
  t.resetPage();
  const ctx = { data: null, now: 0, terminal: () => null, chat: () => null, muse: () => null, reminders: () => null, url: () => null } as TileContext;
  assert.equal(t.render(ctx).page, 0);
  t.setLayout(CUSTOM);
  t.setLayout(HUB);
  assert.equal(t.render(ctx).page, 0);
  t.input('down', ctx);
  t.setLayout(CUSTOM); // later layouts keep the page you are on
  assert.equal(t.render(ctx).page, 1);
  t.resetPage();
  assert.equal(t.render(ctx).page, 0);
});
