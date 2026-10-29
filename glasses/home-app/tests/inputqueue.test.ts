import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData } from '../src/model';
import { Tiles, DEFAULT_LAYOUT, type TileContext, type TileEffect, type OpenTarget } from '../src/tiles';
import { makeHandle } from '../src/inputflow';
import { InputQueue, MAX_QUEUED, type InputSource } from '../src/inputqueue';
import { SettleWaiters } from '../src/settle';
import type { Input } from '../src/model';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = {
  now: NOW, paused: false, machines: [{ name: 'lap', online: true }, { name: 'm1', online: true }],
  sessions: [
    { agent: 'claude', name: 'Claude', session: 'a', state: 'working', page: 'agent-status', at: NOW / 1000 - 120, workspace: '1', machine: 'lap', pane: 'p1' },
    { agent: 'codex', name: 'Codex', session: 'b', state: 'done', page: 'black-team', at: NOW / 1000 - 600, workspace: '', machine: 'm1', pane: 'p2' },
  ],
  pending: [], messages: [{ id: 7, name: 'Mum', unread: true, when: 5, snippet: 'Call me', fromMe: false }], muse: true,
};

/** The real model and Tiles, wired like main.ts, with a gate standing in for "the glasses show it". */
function rig(opts: { tiles?: boolean } = {}) {
  const model = new HomeModel();
  model.update(data);
  const tiles = new Tiles();
  tiles.setLayout(DEFAULT_LAYOUT);
  let tilesActive = opts.tiles ?? false;
  let fromTiles = false;
  const log: string[] = [];
  const ctx = (): TileContext => ({ data, now: NOW, timeZone: 'UTC', terminal: () => ['x'], chat: () => ['hi'], muse: () => ({ question: 'q', reply: 'a' }), reminders: () => [], url: () => null });
  const showing = () => tilesActive && !fromTiles;
  const apply = makeHandle({
    model, tiles, tileCtx: ctx, showingTiles: showing,
    inOpenedScreen: () => tilesActive && fromTiles,
    leaveTiles: () => { tilesActive = false; model.goHome(); },
    backToTiles: () => { fromTiles = false; },
    paint: () => {},
    runTileEffect: (e: TileEffect) => { if (e.kind === 'open') { fromTiles = true; model.openTarget(e.target as OpenTarget); } },
    runModelAction: () => {},
    saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {},
    now: () => NOW,
  });
  const gate = { open: true, release: [] as (() => void)[] };
  const queue = new InputQueue({
    apply,
    screen: () => (showing() ? 'tiles' : model.screenKind),
    settled: () => (gate.open ? Promise.resolve() : new Promise<void>(r => gate.release.push(r))),
    log: (n, d) => log.push(`${n} ${d}`),
  });
  const press = (...inputs: Input[]) => inputs.forEach(i => queue.push(i, 'remote'));
  const idle = () => new Promise(r => setTimeout(r, 15));
  return { model, tiles, queue, log, press, idle, gate, ctx, state: () => (showing() ? `tiles:${JSON.stringify(tiles.render(ctx()))}` : `${model.screenKind}:${model.render(NOW)}`), apply };
}

test('remote select on home opens the first item (Agents)', async () => {
  const r = rig();
  r.press('select');
  await r.idle();
  assert.equal(r.model.screenKind, 'agents');
  assert.deepEqual(r.log, ['input select from remote on home', 'shown agents']);
});

test('remote select on the agents list picks the row the selection is on', async () => {
  const r = rig();
  r.press('select');
  await r.idle();
  r.press('down', 'select');
  await r.idle();
  assert.equal(r.model.screenKind, 'agent');
  assert.equal(r.model.terminalTarget()?.machine, 'm1'); // the second row (Codex on m1), not the first
});

test('Tiles <-> Home: each remote press is routed by what is shown when it runs', async () => {
  const r = rig({ tiles: true });
  r.gate.open = false; // the glasses are slow
  r.press('back', 'select'); // leave Tiles, then open the first item of Home
  await r.idle();
  assert.equal(r.log.filter(l => l.startsWith('input')).length, 1);
  assert.match(r.log[0], /^input back from remote on tiles$/);
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.equal(r.model.screenKind, 'agents'); // the select went to Home, not to a tile
  assert.ok(r.log.includes('input select from remote on home'));
});

test('a press during a slow render waits for it', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('select', 'down');
  await r.idle();
  assert.equal(r.model.screenKind, 'agents');
  assert.deepEqual(r.log, ['input select from remote on home']); // down has not run
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.deepEqual(r.log.slice(1), ['shown agents', 'input down from remote on agents']);
});

test('rapid down, down, back gives the same result as the same presses one at a time, on every screen', async () => {
  const setups: [string, (r: ReturnType<typeof rig>) => void][] = [
    ['home', () => {}],
    ['agents', r => r.model.goTo('agents')],
    ['agent', r => { r.model.goTo('agents'); r.apply('select'); }],
    ['messages', r => r.model.goTo('messages')],
    ['muse', r => r.model.goTo('muse')],
  ];
  for (const tilesOn of [false, true]) setups.push([`tiles(${tilesOn})`, () => {}]);
  for (const [name, prep] of setups) {
    const fast = rig({ tiles: name === 'tiles(true)' });
    const slow = rig({ tiles: name === 'tiles(true)' });
    prep(fast); prep(slow);
    fast.press('down', 'down', 'back');
    await fast.idle();
    for (const i of ['down', 'down', 'back'] as Input[]) slow.apply(i);
    assert.equal(fast.state(), slow.state(), name);
    assert.equal(fast.log.filter(l => l.startsWith('input ')).length, 3, name);
  }
});

test('touch and remote share the queue and are logged with their source', async () => {
  const r = rig();
  r.gate.open = false;
  r.queue.push('down', 'touch');
  r.queue.push('select', 'remote');
  await r.idle();
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.ok(r.log.includes('input down from touch on home'));
  assert.ok(r.log.some(l => l.startsWith('input select from remote on')));
  assert.ok(!r.log.some(l => l.startsWith('remote.applied')));
});

test('at most 5 wait: the oldest remote presses are dropped, touch never', async () => {
  const r = rig();
  r.gate.open = false;
  r.queue.push('down', 'touch'); // runs, then waits for the glasses
  for (let i = 0; i < 8; i++) r.queue.push('down', 'remote');
  assert.equal(r.queue.length, MAX_QUEUED);
  assert.equal(r.log.filter(l => l.startsWith('input.dropped')).length, 3);
  r.queue.push('up', 'touch');
  assert.equal(r.queue.length, MAX_QUEUED); // a remote one made room for the touch
  assert.ok(!r.log.some(l => l.startsWith('input.dropped') && l.includes('touch')));
});

test('a failing apply does not stop the queue', async () => {
  const log: string[] = [];
  const q = new InputQueue({ apply: i => { if (i === 'up') throw new Error('boom'); }, screen: () => 's', settled: async () => {}, log: (n, d) => log.push(`${n} ${d}`) });
  q.push('up', 'remote'); q.push('down', 'remote');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(log.includes('input.error boom'));
  assert.ok(log.includes('input down from remote on s'));
});

test('settle: resolves when notified settled, or at the cap', async () => {
  const w = new SettleWaiters();
  let ok = false;
  let done = false;
  void w.wait(() => ok, 1000).then(() => { done = true; });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(done, false);
  w.notify(() => ok);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(done, false); // notified, but not settled
  ok = true;
  w.notify(() => ok);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(done, true);
  const t0 = Date.now();
  await new SettleWaiters().wait(() => false, 30);
  assert.ok(Date.now() - t0 >= 25);
  await new SettleWaiters().wait(() => true, 1000); // already settled: no wait
});
