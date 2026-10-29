// Real glasses: on the agent page a press waited 7-13 s for its frame. The agent page is a big text that renders slowly,
// and every 1.2 s tick pushes updates (terminal, tiles, poll) that each wait for their frame before the next press runs.
// Times here are scaled down 10x: a render takes 100 ms (1 s on the glasses), a tick comes every 120 ms (1.2 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData } from '../src/model';
import { Tiles, DEFAULT_LAYOUT, type TileContext } from '../src/tiles';
import { makeHandle } from '../src/inputflow';
import { InputQueue, MAX_QUEUED } from '../src/inputqueue';
import { TerminalCache } from '../src/terminalcache';
import type { SettleResult } from '../src/settle';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const RENDER_MS = 100, TICK_MS = 120, CAP_MS = 150; // 1 s, 1.2 s, 1.5 s on the glasses
const data: HomeData = {
  now: NOW, paused: false, machines: [{ name: 'lap', online: true }],
  sessions: [{ agent: 'claude', name: 'Claude', session: 'a', state: 'working', page: 'agent-status', at: NOW / 1000 - 120, workspace: '1', machine: 'lap', pane: 'p1' }],
  pending: [], messages: [], muse: true,
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Glasses that take RENDER_MS to show a changed text, one render at a time; settled() honours its cap. */
function slowGlasses() {
  let want = '', shown = '', busy = false;
  const waiters = new Set<() => void>();
  const pump = async () => {
    if (busy || want === shown) return;
    busy = true;
    const target = want;
    await sleep(RENDER_MS);
    shown = target; busy = false;
    for (const w of [...waiters]) w();
    void pump();
  };
  return {
    set(text: string) { want = text; void pump(); },
    settled(capMs = CAP_MS): Promise<SettleResult> {
      if (!busy && want === shown) return Promise.resolve('rendered');
      return new Promise(resolve => {
        const done = (r: SettleResult) => { clearTimeout(timer); waiters.delete(check); resolve(r); };
        const check = () => { if (!busy && want === shown) done('rendered'); };
        const timer = setTimeout(() => done('capped'), capMs);
        waiters.add(check);
      });
    },
    get shown() { return shown; },
  };
}

function rig(slowFetch?: () => Promise<void>) {
  const model = new HomeModel();
  model.update(data);
  const tiles = new Tiles();
  tiles.setLayout(DEFAULT_LAYOUT);
  const glasses = slowGlasses();
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  let mark = '';
  const paint = () => glasses.set(model.render(NOW) + mark);
  const log: string[] = [];
  const t0 = Date.now();
  const stamp = () => Date.now() - t0;
  let n = 0;
  const apply = makeHandle({
    isBlank: () => false, wake: () => {}, model, tiles,
    tileCtx: (): TileContext => ({ data, now: NOW, timeZone: 'UTC', terminal: () => ['x'], chat: () => ['hi'], muse: () => ({ question: 'q', reply: 'a' }), reminders: () => [], url: () => null }),
    showingTiles: () => false, inOpenedScreen: () => false, leaveTiles: () => {}, backToTiles: () => {},
    paint, runTileEffect: () => {}, runModelAction: () => {}, saveLayout: () => {}, refreshTiles: () => {},
    refreshTerminal: () => { if (slowFetch) void slowFetch(); }, now: () => NOW,
  });
  const queue = new InputQueue({
    apply, menu: () => {}, generation: () => model.generation, foreground: () => true, screen: () => model.screenKind,
    settled: capMs => glasses.settled(capMs),
    log: (name, detail) => { if (name === 'shown' || name === 'settle-capped' || name === 'input' || name === 'input.dropped') log.push(`${stamp()} ${name} ${detail}`); },
  });
  /** What the 1.2 s interval does on the agent page: new terminal text, a poll, a tiles refresh, each through the queue. */
  const tick = () => {
    n++;
    queue.pushExternal('terminal', () => { model.setTerminal('lap/p1', [...lines, `tick ${n}`]); paint(); });
    queue.pushExternal('poll', () => { mark = ` p${n}`; model.update({ ...data, now: NOW + n }); paint(); });
    queue.pushExternal('tiles', () => { mark += ` t${n}`; paint(); });
  };
  return { model, queue, glasses, log, stamp, tick, lines };
}

test('agent page with 1 s renders and 1.2 s ticks: three downs are each shown within the cap', async () => {
  const r = rig();
  r.model.openTarget({ kind: 'agent', key: 'lap/p1' });
  r.model.setTerminal('lap/p1', r.lines);
  r.queue.pushExternal('terminal', () => {}); // let the queue start
  const timer = setInterval(r.tick, TICK_MS);
  await sleep(2 * TICK_MS);
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) { starts.push(r.stamp()); r.queue.push('up', 'remote'); await sleep(30); }
  await sleep(CAP_MS * 6);
  clearInterval(timer);
  // For each press: how long from pushing it until its frame was shown (or the cap passed).
  const shown = r.log.filter(l => /shown|settle-capped/.test(l)).map(l => Number(l.split(' ')[0]));
  // A press waits at most for the render in flight, then its own frame (the presses before it count too).
  const waited = starts.map((st, i) => (shown.filter(x => x >= st)[i] ?? Infinity) - st - i * (RENDER_MS + 5));
  console.log('press waits (ms, scaled 10x):', waited.join(' '), '\n' + r.log.join('\n'));
  for (const w of waited) assert.ok(w <= RENDER_MS + CAP_MS + 100, `a press took ${w} ms`);
});

test('Back leaves an agent page at once even though its terminal fetch is stuck for 5 s', async () => {
  const r = rig(() => new Promise<void>(r => setTimeout(r, 5000).unref()));
  r.model.openTarget({ kind: 'agent', key: 'lap/p1' });
  r.model.setTerminal('lap/p1', r.lines);
  const start = Date.now();
  r.queue.push('back', 'remote');
  while (r.model.screenKind !== 'agents' && r.model.screenKind !== 'home' && Date.now() - start < 3000) await sleep(5);
  const took = Date.now() - start;
  console.log('back took', took, 'ms; now on', r.model.screenKind);
  assert.ok(took < 50, `back took ${took} ms`);
  await r.glasses.settled(1000);
  assert.ok(Date.now() - start < 500, 'home is shown within 0.5 s');
});

test('Back on an agent page drops the downs queued behind it: Home is shown, its cursor has not moved', async () => {
  const r = rig();
  r.model.openTarget({ kind: 'agent', key: 'lap/p1' });
  r.model.setTerminal('lap/p1', r.lines);
  r.queue.push('up', 'remote'); // being shown while the rest is pressed
  r.queue.push('back', 'remote');
  for (let i = 0; i < 3; i++) r.queue.push('down', 'remote');
  await sleep(CAP_MS * 4);
  assert.equal(r.model.screenKind, 'home');
  assert.equal(r.glasses.shown, r.model.render(NOW));
  const only = rig();
  only.model.openTarget({ kind: 'agent', key: 'lap/p1' });
  only.queue.push('up', 'remote');
  only.queue.push('back', 'remote');
  await sleep(CAP_MS * 4);
  assert.equal(r.model.render(NOW), only.model.render(NOW), 'cursor unchanged');
  assert.equal(r.log.filter(l => l.includes('input.dropped') && l.includes('left agent')).length, 3, r.log.join('\n'));
});

/** A queue over a tiny fake app: a cursor, a screen name, and glasses that need `renderMs` to show anything. */
function tiny(renderMs: number) {
  const st = { screen: 'home', cursor: 0, alert: false, gen: 0 };
  const log: string[] = [];
  let busy = false;
  const queue = new InputQueue({
    apply: i => { if (i === 'down') st.cursor++; if (i === 'back') { st.screen = 'home'; st.gen++; } },
    menu: id => { if (id === 12) { st.screen = 'settings'; st.cursor = 0; st.gen++; } },
    generation: () => st.gen, foreground: () => true, screen: () => st.screen,
    settled: async () => { busy = true; await sleep(renderMs); busy = false; return 'rendered' as const; },
    log: (n, d) => log.push(`${n} ${d}`),
  });
  void busy;
  return { st, queue, log };
}

test('presses every 300 ms for 5 s (real time here: every 120 ms for 2.5 s): a waiting alert still shows within about 1.5 s', async () => {
  const t = tiny(250); // each press takes longer to show than the next one arrives: presses are always waiting
  t.queue.push('down', 'touch');
  let alertAt = -1;
  const t0 = Date.now();
  t.queue.pushExternal('alert', () => { alertAt = Date.now() - t0; t.st.alert = true; });
  // real-time 1 s defer limit: keep pressing for 2.5 s
  const timer = setInterval(() => t.queue.push('down', 'touch'), 120);
  await sleep(2500);
  clearInterval(timer);
  console.log('alert shown after', alertAt, 'ms');
  assert.ok(alertAt >= 0 && alertAt <= 1500, `alert shown after ${alertAt} ms`);
});

test('a failed terminal fetch forgets the text: an identical later success is applied and clears the error', () => {
  const c = new TerminalCache();
  const lines = ['a', 'b'];
  assert.equal(c.shouldApply('k', lines, false), true);
  assert.equal(c.shouldApply('k', lines, true), false, 'same text: no repaint');
  assert.equal(c.shouldApply('k', null, true), true, 'a failure is shown');
  assert.equal(c.shouldApply('k', lines, true), true, 'identical text after a failure replaces the error');
  assert.equal(c.shouldApply('k', lines, true), false);
  const model = new HomeModel(); model.update(data);
  model.openTarget({ kind: 'agent', key: 'lap/p1' });
  model.setTerminal('lap/p1', null);
  assert.ok(model.render(NOW).includes('Could not read'));
  model.setTerminal('lap/p1', lines);
  assert.ok(!model.render(NOW).includes('Could not read'));
});

test('a remote menu choice that changes the screen (settings) drops the downs queued behind it; the settings cursor stays', async () => {
  const t = tiny(40);
  t.queue.push('down', 'remote'); // being shown
  t.queue.pushMenu(12, 'remote');
  for (let i = 0; i < 3; i++) t.queue.push('down', 'remote');
  await sleep(400);
  assert.equal(t.st.screen, 'settings');
  assert.equal(t.st.cursor, 0, t.log.join('\n'));
  assert.equal(t.log.filter(l => l.startsWith('input.dropped') && l.includes('left home')).length, 3);
});

test('remote menu entries count against the remote cap, not the touch cap', async () => {
  const t = tiny(100);
  t.queue.push('down', 'remote');
  for (let i = 0; i < MAX_QUEUED + 3; i++) t.queue.pushMenu(99, 'remote');
  assert.equal(t.log.filter(l => l.startsWith('input.dropped') && l.includes('queue full')).length, 3, t.log.join('\n'));
});
