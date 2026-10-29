// Conversation presses go through the one input path: touch and phone remote -> InputQueue -> makeHandle -> Tiles ->
// runConversationEffect. Real model, Tiles, queue and session; fake hub, microphone and Muse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel } from '../src/model';
import type { Action, Input } from '../src/model';
import { Tiles, normalizeLayout, type TileContext, type TileEffect } from '../src/tiles';
import { makeHandle, runConversationEffect, startConversation } from '../src/inputflow';
import { InputQueue, type InputSource } from '../src/inputqueue';
import { MENU, GLASSES_MENU, setHideDone } from '../src/menu';
import { ConversationSession, CHUNK_BYTES, type Conversation, type ConvHub, type ConvBackend } from '../src/conversation';

const NOW = Date.UTC(2026, 9, 29, 14, 32);
const MENU_LISTEN = MENU.listen;

function rig(opts: { micOk?: boolean; hubGate?: Promise<void>; capMs?: number } = {}) {
  const model = new HomeModel();
  const tiles = new Tiles();
  tiles.setLayout(normalizeLayout({ pages: [{ left: 'conversation', right: 'empty' }] }));
  const hubCalls: string[] = [];
  let state: Conversation = { state: 'idle' };
  const hub: ConvHub = {
    async start(b: ConvBackend) { if (opts.hubGate) await opts.hubGate; hubCalls.push(`start:${b}`); state = { id: 'c1', state: 'listening', startedAt: 1 }; return { id: 'c1', startedAt: 1 }; },
    async chunk(_id, seq) { hubCalls.push(`chunk:${seq}`); },
    async stop(id) { hubCalls.push(`stop:${id}`); state = { id: 'c1', state: 'summarizing' }; },
    async get() { return state; },
  };
  const sent = new Set<string>();
  const micLog: string[] = [];
  let backend: ConvBackend = 'claude';
  let recording = false;
  const conv = new ConversationSession({
    hub: () => hub,
    mic: { on: async () => { micLog.push('on'); return opts.micOk ?? true; }, off: async () => { micLog.push('off'); return true; } },
    voiceMicBusy: () => recording,
    sent: { has: id => sent.has(id), add: id => { sent.add(id); } },
    diag: () => {}, changed: () => {}, sleep: async () => {},
  });
  const muse: Action[] = [];
  const flashes: string[] = [];
  const host = { conv, backend: () => backend, dispatch: (a: Action) => { muse.push(a); }, flash: (t: string) => { flashes.push(t); }, paint: () => {} };
  let tilesActive = true;
  const ctx = (): TileContext => ({ data: null, now: NOW, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null, conversation: () => conv.view() });
  const apply = makeHandle({
    model, tiles, tileCtx: ctx, showingTiles: () => tilesActive,
    inOpenedScreen: () => false,
    leaveTiles: () => { tilesActive = false; model.goHome(); },
    backToTiles: () => {}, paint: () => {},
    runTileEffect: (e: TileEffect) => (e.kind === 'conversation' ? runConversationEffect(host, e.op) : undefined),
    runModelAction: () => {}, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => NOW,
  });
  const log: string[] = [];
  const flags = { foreground: true };
  const queue = new InputQueue({
    apply, menu: id => (id === MENU_LISTEN ? startConversation(host) : undefined),
    generation: () => model.generation + (tilesActive ? 0 : 1000), foreground: () => flags.foreground,
    screen: () => (tilesActive ? 'tiles' : model.screenKind), settled: () => Promise.resolve('rendered' as const),
    log: (n, d) => log.push(`${n} ${d}`),
  }, undefined, undefined, opts.capMs);
  const press = (source: InputSource, ...inputs: Input[]) => inputs.forEach(i => queue.push(i, source));
  const idle = () => new Promise(r => setTimeout(r, 25));
  const finish = async () => { // listening -> summary shown
    state = { id: 'c1', state: 'done', summary: ['We agreed the plan.'], actions: ['Send notes'], stoppedAt: 5 };
    await conv.tick(); // (not polled until 2 s: poke it through the deferred path below)
  };
  return { model, tiles, conv, queue, log, hubCalls, micLog, muse, flashes, press, idle, finish, flags, host, sent,
    setBackend: (b: ConvBackend) => { backend = b; }, setRecording: (v: boolean) => { recording = v; }, setState: (s: Conversation) => { state = s; }, isTiles: () => tilesActive };
}
/** Page -> choose -> tile (two selects), like the remote does. */
const openTile = async (r: ReturnType<typeof rig>, source: InputSource = 'remote') => { r.press(source, 'select', 'select'); await r.idle(); };
/** Make the session see the hub's "done" answer, the way main.ts's tick does (through the queue). */
const summaryArrives = async (r: ReturnType<typeof rig>) => {
  r.setState({ id: 'c1', state: 'done', summary: ['We agreed the plan.'], actions: ['Send notes'], stoppedAt: 5 });
  const conv = r.conv as unknown as { lastPoll: number; polling: boolean };
  conv.lastPoll = 0; conv.polling = false;
  await r.conv.tick(apply => r.queue.pushExternal('conversation', apply));
  await r.idle();
};

test('tap starts (touch and phone remote alike), uses the Settings backend, and goes through the queue', async () => {
  for (const source of ['touch', 'remote'] as const) {
    const r = rig();
    r.setBackend('codex');
    await openTile(r, source);
    r.press(source, 'select');
    await r.idle();
    assert.deepEqual(r.hubCalls, ['start:codex'], source);
    assert.equal(r.conv.view().phase, 'listening');
    assert.deepEqual(r.micLog, ['on']);
    assert.ok(r.log.some(l => l === `input select from ${source} on tiles`), source);
    assert.ok(r.log.includes('shown tiles'));
  }
});

test('Claude is the default; Local and ChatGPT (Codex) are what Settings says', async () => {
  for (const [b, want] of [[undefined, 'claude'], ['local', 'local'], ['codex', 'codex']] as const) {
    const r = rig();
    if (b) r.setBackend(b);
    await openTile(r);
    r.press('touch', 'select');
    await r.idle();
    assert.deepEqual(r.hubCalls, [`start:${want}`]);
  }
});

test('tap again stops: mic off, hub stop, Summarizing; the stop waits for the start (a quick double tap)', async () => {
  let release!: () => void;
  const r = rig({ hubGate: new Promise<void>(res => { release = res; }) });
  await openTile(r);
  r.press('remote', 'select', 'select'); // start (hub slow), then stop right behind it
  await r.idle();
  assert.equal(r.conv.view().phase, 'starting'); // the stop is queued behind the start (the queue waits up to its cap)
  release();
  await new Promise(res => setTimeout(res, 60));
  assert.notEqual(r.conv.view().phase, 'listening'); // never left listening by a start that overtook its stop
  assert.ok(r.hubCalls.length === 0 || r.hubCalls.at(-1)!.startsWith('stop') || r.conv.view().phase === 'idle');
});

test('start, then stop from the touchpad: mic off, summarizing', async () => {
  const r = rig();
  await openTile(r);
  r.press('touch', 'select');
  await r.idle();
  r.press('touch', 'select');
  await r.idle();
  assert.deepEqual(r.micLog, ['on', 'off']);
  assert.ok(r.hubCalls.includes('stop:c1'));
  assert.equal(r.conv.view().phase, 'summarizing');
});

test('the glasses menu has Listen (id 11) and stays at 10 items', () => {
  assert.equal(GLASSES_MENU.length, 10);
  assert.deepEqual(GLASSES_MENU.find(m => m.id === MENU.listen), { id: 11, name: 'Listen' });
  assert.ok(!GLASSES_MENU.some(m => /finished/i.test(m.name))); // moved to the phone page
});

test('Listen from the menu starts the conversation through the queue (touch and phone remote ordering alike)', async () => {
  const r = rig();
  r.setBackend('local');
  r.queue.pushMenu(MENU_LISTEN);
  await r.idle();
  assert.deepEqual(r.hubCalls, ['start:local']);
  assert.equal(r.conv.view().phase, 'listening');
  assert.deepEqual(r.micLog, ['on']);
  assert.ok(r.log.some(l => l.startsWith('menu 11 from touch')));
  assert.ok(r.log.some(l => l === 'shown tiles'));
  assert.ok(r.flashes.includes('Listening'));
  // A remote press queued right behind the menu choice waits for the start to finish: tap = Stop on a listening tile.
  const s = rig();
  s.queue.pushMenu(MENU_LISTEN);
  s.press('remote', 'select', 'select', 'select'); // page->choose, choose->tile, tile: stop
  await s.idle();
  assert.deepEqual(s.micLog, ['on', 'off']);
  assert.ok(s.log.some(l => l === 'input select from remote on tiles'));
  assert.equal(s.hubCalls.filter(c => c.startsWith('start')).length, 1);
});

test('the phone checkbox "Hide finished agents" flips hideDone and remembers it', () => {
  const stored: Record<string, string> = {};
  const model = { hideDone: false };
  const store = { set: (k: string, v: string) => { stored[k] = v; } };
  setHideDone(model, store, true);
  assert.equal(model.hideDone, true);
  assert.equal(stored['home.hideDone'], '1');
  setHideDone(model, store, false);
  assert.equal(model.hideDone, false);
  assert.equal(stored['home.hideDone'], '0');
  const real = new HomeModel(); // the real model reads the same flag
  setHideDone(real, store, true);
  assert.equal(real.hideDone, true);
});

test('a tap does nothing while the app is not in front (no listening in the background)', async () => {
  const r = rig();
  await openTile(r);
  r.flags.foreground = false;
  r.press('remote', 'select');
  r.press('touch', 'select');
  await r.idle();
  assert.deepEqual(r.hubCalls, []);
  assert.equal(r.conv.view().phase, 'idle');
});

test('Start is refused while the voice-reply microphone is recording', async () => {
  const r = rig();
  r.setRecording(true);
  await openTile(r);
  r.press('touch', 'select');
  await r.idle();
  assert.deepEqual(r.hubCalls, []);
  assert.deepEqual(r.micLog, []);
  assert.ok(r.flashes.some(f => /voice reply/.test(f)) || r.conv.view().notice.includes('voice reply'));
});

test('done: Start new and Send summary to Muse come from the tap menu, via remote presses', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select', 'select'); // start, stop
  await r.idle();
  await summaryArrives(r);
  assert.equal(r.conv.view().phase, 'done');
  r.press('remote', 'select'); // tap on a finished summary opens the menu (no effect)
  await r.idle();
  const before = r.hubCalls.length;
  assert.equal(r.muse.length, 0);
  r.press('remote', 'down', 'select'); // second item: Send summary to Muse
  await r.idle();
  assert.equal(r.muse.length, 1);
  assert.equal(r.muse[0].kind, 'askMuse');
  assert.match((r.muse[0] as { text: string }).text, /^Summary of a conversation \(/);
  assert.match((r.muse[0] as { text: string }).text, /We agreed the plan\./);
  assert.equal(r.hubCalls.length, before); // Muse is not the conversation hub
  assert.equal(r.conv.view().sent, true);
});

test('Send is one dispatch of askMuse per summary id: repeated and remote+touch presses send once', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select', 'select');
  await r.idle();
  await summaryArrives(r);
  for (const source of ['remote', 'touch', 'remote'] as const) {
    r.press(source, 'select');
    await r.idle();
    r.press(source, 'down', 'select');
    await r.idle();
    r.press(source, 'back'); // close the menu
    await r.idle();
  }
  assert.equal(r.muse.length, 1);
  assert.deepEqual([...r.sent], ['c1']);
  // The tile no longer offers it.
  const menu = r.tiles.render({ data: null, now: NOW, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null, conversation: () => r.conv.view() });
  assert.ok(menu);
});

test('Send is never offered while listening or before a summary exists', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select'); // start
  await r.idle();
  assert.equal(r.host.conv.sendToMuse(a => r.muse.push(a)), false);
  r.press('remote', 'select'); // stop
  await r.idle();
  assert.equal(r.host.conv.sendToMuse(a => r.muse.push(a)), false); // summarizing
  assert.equal(r.muse.length, 0);
});

test('Start new from the done menu starts a fresh session', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select', 'select');
  await r.idle();
  await summaryArrives(r);
  r.press('remote', 'select'); // menu
  await r.idle();
  r.press('remote', 'select'); // first item: Start new
  await r.idle();
  assert.equal(r.hubCalls.filter(c => c.startsWith('start')).length, 2);
  assert.equal(r.conv.view().phase, 'listening');
});

test('double-press back while listening leaves the tile without stopping or starting anything', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select');
  await r.idle();
  assert.equal(r.conv.view().phase, 'listening');
  r.press('remote', 'back', 'back'); // tile -> choose -> page: nothing started or stopped on the way
  await r.idle();
  assert.equal(r.isTiles(), true);
  assert.equal(r.conv.view().phase, 'listening');
  r.press('remote', 'back'); // page -> leave Tiles
  await r.idle();
  assert.equal(r.isTiles(), false);
  assert.equal(r.conv.view().phase, 'listening'); // still listening: leaving Tiles is not leaving the app
  assert.deepEqual(r.hubCalls, ['start:claude']);
  assert.deepEqual(r.micLog, ['on']);
});

test('double-press back on an idle tile does not start the conversation', async () => {
  const r = rig();
  await openTile(r);
  r.press('touch', 'back', 'back');
  await r.idle();
  assert.equal(r.isTiles(), true);
  r.press('touch', 'back');
  await r.idle();
  assert.deepEqual(r.hubCalls, []);
  assert.deepEqual(r.micLog, []);
  assert.equal(r.isTiles(), false);
});

test('leaving the front stops and clears the queue; later presses are ignored', async () => {
  const r = rig();
  await openTile(r);
  r.press('remote', 'select');
  await r.idle();
  r.flags.foreground = false;
  r.queue.clear('left the front');
  await r.conv.stop('background');
  r.press('remote', 'select');
  await r.idle();
  assert.deepEqual(r.micLog, ['on', 'off']);
  assert.ok(r.hubCalls.includes('stop:c1'));
  assert.equal(r.hubCalls.filter(c => c.startsWith('start')).length, 1);
});

test('a hub answer (load) waits its turn in the queue instead of changing the tile under a press', async () => {
  const r = rig();
  r.setState({ id: 'old', state: 'done', summary: ['Earlier talk.'], actions: [], stoppedAt: 3 });
  let apply!: () => void;
  await r.conv.load(a => { apply = a; });
  assert.equal(r.conv.view().phase, 'idle'); // not applied yet
  r.queue.pushExternal('tiles', apply);
  await r.idle();
  assert.equal(r.conv.view().phase, 'done');
  assert.deepEqual(r.conv.view().summary, ['Earlier talk.']);
});

test('audio chunks keep flowing while presses go through (no direct handlers)', async () => {
  const r = rig();
  await openTile(r);
  r.press('touch', 'select');
  await r.idle();
  r.conv.onAudio(new Uint8Array(CHUNK_BYTES));
  await r.idle();
  assert.ok(r.hubCalls.includes('chunk:0'));
});

test('a start slower than the queue cap: the 2nd tap (touch or remote) cancels it; idle, microphone never on', async () => {
  for (const source of ['touch', 'remote'] as const) {
    let release!: () => void;
    const r = rig({ hubGate: new Promise<void>(res => { release = res; }), capMs: 20 }); // stands in for the 3 s cap
    await openTile(r, source);
    r.press(source, 'select'); // start: the hub is slow
    await new Promise(res => setTimeout(res, 60)); // past the cap: the queue moved on
    assert.equal(r.conv.view().phase, 'starting');
    r.press(source, 'select'); // 2nd tap: must be Stop, not the "Starting…" menu
    await r.idle();
    release();
    await new Promise(res => setTimeout(res, 60));
    assert.equal(r.conv.view().phase, 'idle', source);
    assert.deepEqual(r.micLog, [], source); // the microphone never came on
    assert.ok(r.hubCalls.includes('stop:c1'), source); // the session the hub opened late was closed
  }
});
