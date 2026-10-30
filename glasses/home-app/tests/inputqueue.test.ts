import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData } from '../src/model';
import { Tiles, DEFAULT_LAYOUT, type TileContext, type TileEffect, type OpenTarget } from '../src/tiles';
import { makeHandle } from '../src/inputflow';
import { InputQueue, MAX_QUEUED, type InputSource } from '../src/inputqueue';
import { SettleWaiters, Serial, type SettleResult } from '../src/settle';
import { Latest } from '../src/latest';
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
  const calls: string[] = [];
  const ctx = (): TileContext => ({ data, now: NOW, timeZone: 'UTC', terminal: () => ['x'], chat: () => ['hi'], muse: () => ({ question: 'q', reply: 'a' }), reminders: () => [], url: () => null });
  const showing = () => tilesActive && !fromTiles;
  const apply = makeHandle({ isBlank: () => false, wake: () => {},
    model, tiles, tileCtx: ctx, showingTiles: showing,
    inOpenedScreen: () => tilesActive && fromTiles,
    leaveTiles: () => { tilesActive = false; model.goHome(); calls.push('paint'); },
    backToTiles: () => { fromTiles = false; },
    paint: () => { calls.push('paint'); },
    runTileEffect: (e: TileEffect) => { calls.push(`effect:${e.kind}`); if (e.kind === 'open') { fromTiles = true; model.openTarget(e.target as OpenTarget); } },
    runModelAction: () => {},
    saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {},
    now: () => NOW,
  });
  const gate = { open: true, result: 'rendered' as SettleResult, release: [] as (() => void)[] };
  let flips = 0;
  let was = showing();
  const generation = () => { const n = showing(); if (n !== was) { flips++; was = n; } return model.generation + flips; };
  const menus: number[] = [];
  const flags = { foreground: true, menuJob: null as Promise<void> | null };
  const queue = new InputQueue({
    apply, menu: id => { menus.push(id); if (id === 4) model.goHome(); return flags.menuJob ?? undefined; }, generation, foreground: () => flags.foreground,
    screen: () => (showing() ? 'tiles' : model.screenKind),
    settled: () => (gate.open ? Promise.resolve(gate.result) : new Promise<SettleResult>(r => gate.release.push(() => r(gate.result)))),
    log: (n, d) => log.push(`${n} ${d}`),
  });
  const press = (...inputs: Input[]) => inputs.forEach(i => queue.push(i, 'remote'));
  const idle = () => new Promise(r => setTimeout(r, 15));
  return { model, tiles, queue, log, calls, menus, flags, press, idle, gate, ctx, state: () => (showing() ? `tiles:${JSON.stringify(tiles.render(ctx()))}` : `${model.screenKind}:${model.render(NOW)}`), apply };
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

test('a failing apply does not stop the queue', async () => {
  const log: string[] = [];
  const q = new InputQueue({ apply: i => { if (i === 'up') throw new Error('boom'); }, menu: () => {}, generation: () => 0, foreground: () => true, screen: () => 's', settled: async () => 'rendered' as const, log: (n, d) => log.push(`${n} ${d}`) });
  q.push('up', 'remote'); q.push('down', 'remote');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(log.includes('input.error boom'));
  assert.ok(log.includes('input down from remote on s'));
});

test('settle: resolves with the state when it arrives, or "capped"', async () => {
  const w = new SettleWaiters();
  let state: SettleResult | null = null;
  let got = '';
  void w.wait(() => state, 1000).then(r => { got = r; });
  w.notify(() => state);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(got, ''); // notified, not settled yet
  state = 'not-visible';
  w.notify(() => state);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(got, 'not-visible');
  assert.equal(await new SettleWaiters().wait(() => null, 30), 'capped');
  assert.equal(await new SettleWaiters().wait(() => 'rendered', 1000), 'rendered');
});

// ---- Codex review fixes ----

test('(1) a screen opened by a tile is painted right after the effect, before the next press', async () => {
  const withEffect = rig({ tiles: true });
  withEffect.press('select', 'select', 'select'); // page -> choose -> tile -> its action menu
  await withEffect.idle();
  withEffect.calls.length = 0;
  withEffect.press('select'); // first menu item (Ask Muse) -> an 'open' effect
  await withEffect.idle();
  const i = withEffect.calls.indexOf('effect:open');
  assert.ok(i >= 0, withEffect.calls.join());
  assert.equal(withEffect.calls[i + 1], 'paint', withEffect.calls.join());
});

test('(2) a long-press menu choice goes through the same queue, in order, and waits for the glasses', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('down');
  r.queue.pushMenu(4);
  await r.idle();
  assert.deepEqual(r.menus, []); // waits behind the press
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.deepEqual(r.menus, [4]);
  assert.ok(r.log.includes('menu 4 from touch on home'));
});

test('(3) leaving the front or disconnecting clears what is waiting (input.cancelled)', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('down', 'down', 'select');
  r.queue.pushMenu(4);
  await r.idle();
  r.queue.clear('left the front');
  assert.equal(r.queue.length, 0);
  assert.equal(r.log.filter(l => l.startsWith('input.cancelled')).length, 3);
  r.gate.open = true;
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.equal(r.log.filter(l => l.startsWith('input ')).length, 1); // only the one already running
  assert.deepEqual(r.menus, []);
});

test('(a) overflow: when full the NEW press is dropped; nothing waiting is removed; touch and menu cap at 10 by the same rule', async () => {
  const r = rig();
  r.gate.open = false;
  r.queue.push('select', 'touch'); // runs, then waits
  r.press('down', 'up', 'select', 'back', 'select'); // 5 waiting
  assert.equal(r.queue.length, MAX_QUEUED);
  r.press('down', 'back');
  assert.equal(r.queue.length, MAX_QUEUED);
  assert.equal(r.log.filter(l => l.startsWith('input.dropped') && l.endsWith('(queue full)')).length, 2);
  assert.ok(r.log.includes('input.dropped down from remote (queue full)'));
  r.gate.open = true;
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.deepEqual(r.log.filter(l => l.startsWith('input ')).map(l => l.split(' on ')[0]), ['input select from touch', 'input down from remote', 'input up from remote', 'input select from remote', 'input back from remote', 'input select from remote']);
  const t = rig();
  t.gate.open = false;
  t.queue.push('select', 'touch');
  for (let i = 0; i < 12; i++) t.queue.push('down', 'touch');
  t.queue.pushMenu(4);
  assert.equal(t.queue.length, 10);
  assert.equal(t.log.filter(l => l.startsWith('input.dropped')).length, 3);
});

test('(b) presses are ignored while the app is not in front; after not-visible the rest of the queue is cleared', async () => {
  const r = rig();
  r.flags.foreground = false;
  r.press('select');
  r.queue.pushMenu(4);
  await r.idle();
  assert.equal(r.model.screenKind, 'home');
  assert.deepEqual(r.log, ['input.ignored select from remote (not in front)', 'input.ignored menu 4 (not in front)']);
  r.flags.foreground = true;
  const n = rig();
  n.gate.result = 'not-visible';
  n.press('down', 'down', 'select');
  await n.idle();
  assert.equal(n.log.filter(l => l.startsWith('input ')).length, 1); // the other two would have been blind
  assert.equal(n.log.filter(l => l.startsWith('input.cancelled')).length, 2);
  assert.ok(n.log.includes('not-visible home'));
});

test('(c) polls and refreshes take their turn: earlier presses act on what was seen, later ones wait for the new frame', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('select'); // runs: opens Agents; waits for the glasses
  r.press('down'); // queued before the update
  r.queue.pushExternal('poll', () => { r.calls.push('update'); });
  r.press('back'); // queued after it
  await r.idle();
  r.gate.open = true;
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  const order = r.log.filter(l => l.startsWith('input ')).map(l => l.split(' ')[1]);
  assert.deepEqual(order, ['select', 'down', 'back']);
  const upd = r.calls.indexOf('update');
  assert.ok(upd >= 0);
  // one waiting update per name is merged and keeps its order
  const m = rig();
  m.gate.open = false;
  m.press('down');
  const seen: string[] = [];
  m.queue.pushExternal('tiles', () => seen.push('a'));
  m.queue.pushExternal('tiles', () => seen.push('b'));
  m.gate.open = true;
  m.gate.release.splice(0).forEach(f => f());
  await m.idle();
  assert.deepEqual(seen, ['a', 'b']);
});

test('(c) an update that brings an alert makes the earlier queued press stale; ordinary updates do not', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('down');
  r.queue.pushExternal('poll', () => r.model.update({ ...data, pending: [{ id: 'p9', agent: 'Claude', page: 'p', tool: 'Bash', summary: 'x', at: NOW, machine: 'm1' }] }));
  r.press('select'); // pressed while the home list was still shown
  r.gate.open = true;
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  // Presses go before waiting updates: the select acts on the home list the owner saw, then the alert pops up (stale presses
  // for a screen an alert replaced are covered by (8)).
  assert.ok(r.log.some(l => l.startsWith('input select from remote on home')), r.log.join('\n'));
  assert.ok(!r.log.some(l => l.startsWith('input.stale')), r.log.join('\n'));
  assert.equal(r.model.screenKind, 'approval');
  const ok = rig();
  ok.gate.open = false;
  ok.press('down');
  ok.press('select');
  ok.queue.pushExternal('poll', () => ok.model.update(data));
  ok.gate.open = true;
  ok.gate.release.splice(0).forEach(f => f());
  await ok.idle();
  assert.ok(!ok.log.some(l => l.startsWith('input.stale')));
  assert.equal(ok.model.screenKind, 'messages'); // down then select: the second item
});

test('(d) a promise from apply/menu is awaited before the next press, but only up to the cap', async () => {
  const r = rig();
  let done!: () => void;
  r.flags.menuJob = new Promise<void>(res => { done = res; });
  r.queue.pushMenu(4);
  r.press('select');
  await r.idle();
  assert.equal(r.log.filter(l => l.startsWith('input ')).length, 0); // Pause-style menu still waiting for the hub
  done();
  await r.idle();
  assert.equal(r.log.filter(l => l.startsWith('input ')).length, 1);
  const log: string[] = [];
  const q = new InputQueue({ apply: () => {}, menu: () => new Promise<void>(() => {}), generation: () => 0, foreground: () => true, screen: () => 's', settled: async () => 'rendered' as const, log: (n, d) => log.push(`${n} ${d}`) }, 5, 10, 30);
  q.pushMenu(1);
  q.push('down', 'remote');
  await new Promise(r2 => setTimeout(r2, 100));
  assert.ok(log.includes('input down from remote on s')); // the never-ending menu job was given up on after the cap
});

test('(e)(f) only the newest request counts: a late answer for an older one is ignored', () => {
  const l = new Latest();
  const first = l.next();
  const second = l.next();
  assert.equal(l.isLatest(first), false);
  assert.equal(l.isLatest(second), true);
  l.invalidate(); // a cancel
  assert.equal(l.isLatest(second), false);
  const third = l.next();
  assert.equal(l.isLatest(third), true);
});

test('(6) microphone jobs run one after another, in order, even when a start is slow', async () => {
  const s = new Serial();
  const order: string[] = [];
  const slowStart = s.run(async () => { await new Promise(r => setTimeout(r, 20)); order.push('start'); return true; });
  const stop = s.run(async () => { order.push('stop'); return false; });
  s.run(async () => { throw new Error('x'); }).catch(() => {});
  const after = s.run(async () => { order.push('after-error'); return true; });
  assert.deepEqual(await Promise.all([slowStart, stop, after]), [true, false, true]);
  assert.deepEqual(order, ['start', 'stop', 'after-error']);
});

test('(7) a chat that loads late is ignored when another chat or screen is open now', () => {
  const m = new HomeModel();
  m.update({ ...data, messages: [{ id: 7, name: 'Mum', unread: false, when: 5, snippet: 's', fromMe: false }, { id: 8, name: 'Dad', unread: false, when: 4, snippet: 's', fromMe: false }] });
  const msg = (text: string) => [{ from: 'x', fromMe: false, text, when: NOW }] as unknown as Parameters<HomeModel['setChat']>[0];
  m.openTarget({ kind: 'chat', id: 8, name: 'Dad' });
  m.setChat(msg('for Mum'), NOW, 7); // the answer for chat 7 arrives while 8 is open
  assert.doesNotMatch(m.render(NOW), /for Mum/);
  m.setChat(msg('for Dad'), NOW, 8);
  assert.match(m.render(NOW), /for Dad/);
  m.goTo('home');
  m.setChat(msg('late'), NOW, 8); // no chat open: nothing is written
  m.openTarget({ kind: 'chat', id: 8, name: 'Dad' });
  assert.doesNotMatch(m.render(NOW), /late/);
});

test('(8) a press queued before an alert changed the screen is dropped as input.stale; later ones run', async () => {
  const r = rig();
  r.gate.open = false;
  r.press('down'); // runs
  r.press('select'); // waits, meant for the home list
  r.model.update({ ...data, pending: [{ id: 'p9', agent: 'Claude', page: 'p', tool: 'Bash', summary: 'rm -rf x', at: NOW, machine: 'm1' }] }); // an approval pops up
  assert.equal(r.model.screenKind, 'approval');
  await r.idle();
  r.gate.release.splice(0).forEach(f => f());
  await r.idle();
  assert.ok(r.log.some(l => l.startsWith('input.stale select from remote on approval')), JSON.stringify(r.log));
  assert.equal(r.model.screenKind, 'approval'); // the select did not answer the approval
  r.gate.open = true;
  r.press('back');
  await r.idle();
  assert.ok(r.log.includes('input back from remote on approval'));
});

test('(9) the log says what really happened: shown, settle-capped or not-visible', async () => {
  for (const [result, word] of [['rendered', 'shown'], ['capped', 'settle-capped'], ['not-visible', 'not-visible']] as const) {
    const r = rig();
    r.gate.result = result;
    r.press('select');
    await r.idle();
    assert.equal(r.log[1], `${word} agents`);
  }
});
test('diag: every press is logged as input.queued when it arrives, and one that has the queue\'s turn for too long is reported as input.stuck', async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const q = new InputQueue({
    apply: () => {}, menu: () => {}, foreground: () => true, generation: () => 0, screen: () => 'tiles',
    settled: () => gate.then(() => 'rendered' as SettleResult), // the glasses never confirm the frame
    log: () => {}, trace: (n, d) => log.push(`${n} ${d}`),
  }, undefined, undefined, undefined, 60);
  q.push('select', 'touch');
  q.push('down', 'remote');
  q.pushMenu(3, 'touch');
  assert.deepEqual(log.filter(l => l.startsWith('input.queued')), ['input.queued select from touch', 'input.queued down from remote (0 waiting)', 'input.queued menu 3 from touch']);
  await new Promise(r => setTimeout(r, 200));
  const stuck = log.filter(l => l.startsWith('input.stuck'));
  assert.equal(stuck.length, 1, log.join(' | '));
  assert.match(stuck[0], /input\.stuck \d+ ms on select from touch \(2 waiting\)/);
  release();
  await new Promise(r => setTimeout(r, 50));
  // a press that is handled in time never reports stuck
  const log2: string[] = [];
  const ok = new InputQueue({ apply: () => {}, menu: () => {}, foreground: () => true, generation: () => 0, screen: () => 'tiles', settled: async () => 'rendered' as SettleResult, log: () => {}, trace: (n, d) => log2.push(`${n} ${d}`) }, undefined, undefined, undefined, 60);
  ok.push('select', 'touch');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(log2.filter(l => l.startsWith('input.stuck')).length, 0);
});
