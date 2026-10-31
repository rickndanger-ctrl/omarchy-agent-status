import test from 'node:test';
import assert from 'node:assert/strict';
import { OsEventTypeList, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { InputQueue } from '../src/inputqueue';
import { makeHandle, makeHoldHandle, type FlowHost } from '../src/inputflow';
import { HomeModel, type Action, type HomeData } from '../src/model';
import { AgentVoice, AgentConfirmExpiry } from '../src/agent-voice';
import { Latest } from '../src/latest';
import { Tiles } from '../src/tiles';
import { GLASSES_MENU } from '../src/menu';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r)); };
const gate = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const data: HomeData = { now: 100000, paused: false, machines: [{ name: 'Dell', online: true }],
  sessions: [{ machine: 'Dell', pane: 'orchestrator', agent: 'claude', session: 'fixture-session', name: 'Orchestrator',
    state: 'working', page: 'fixture', at: 100, workspace: '' }], pending: [], messages: [], muse: true, voice: true };

async function rig() {
  const model = new HomeModel(); model.update(data); model.openTarget({ kind: 'agent', key: 'Dell/orchestrator' });
  const latest = new Latest(), tiles = new Tiles(), actions: Action[] = [], mics: boolean[] = [], uploads: Uint8Array[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>(); let sequence = 0, now = 100000;
  const state = { foreground: true, blank: false, tiles: false, recording: null as Uint8Array[] | null,
    render: null as Promise<void> | null, asr: null as Promise<string> | null };
  let event!: (value: EvenHubEvent) => void, queue!: InputQueue, expiry!: AgentConfirmExpiry;
  const bridge = { onEvenHubEvent: (handler: typeof event) => { event = handler; return () => {}; },
    onDeviceStatusChanged: () => () => {}, getDeviceInfo: async () => ({ status: {} }),
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    rebuildPageContainer: async () => true, textContainerUpgrade: async () => true,
    audioControl: async (on: boolean) => { mics.push(on); return true; } } as unknown as EvenAppBridge;
  const visibleToken = () => state.foreground && !state.blank && !state.tiles ? model.agentHoldToken() : null;
  const glasses = new Glasses({ onInput: input => queue.push(input, 'touch'),
    onLongPress: () => { if (visibleToken() !== null) queue.pushHold(); }, onMenu: id => queue.pushMenu(id),
    onStatus: () => {}, onDevice: () => {}, onAudio: pcm => state.recording?.push(pcm),
    onForeground: value => { state.foreground = value; if (!value) { voice.abandon(); queue.clear('left the front'); expiry.sync(); } },
    bridge: async () => bridge }, GLASSES_MENU);
  const paint = () => { if (state.blank || state.tiles) voice.abandon(); expiry?.sync(); };
  const voice = new AgentVoice({ model, latest, now: () => now,
    recording: () => state.recording, setRecording: value => { state.recording = value; },
    microphone: on => glasses.microphone(on), transcribe: async audio => { uploads.push(audio); return state.asr ?? 'fixture private speech'; },
    diag: () => {}, changed: paint, failed: () => {} });
  const run = async (action: Action) => {
    actions.push(action);
    const agent = voice.run(action); if (agent) { await agent; paint(); return; }
    // The untouched Muse path is represented only at its I/O boundary.
    if (action.kind === 'startMic') { latest.next(); state.recording = []; await glasses.microphone(true); }
    if (action.kind === 'stopMic') { const id = latest.next(); await glasses.microphone(false); state.recording = null; if (latest.isLatest(id)) model.setTranscript('Muse fixture question', now); }
    if (action.kind === 'cancelMic') { latest.invalidate(); state.recording = null; await glasses.microphone(false); }
    paint();
  };
  const host: FlowHost = { model, tiles, now: () => now, paint, isBlank: () => state.blank, wake: () => { state.blank = false; },
    showingTiles: () => state.tiles, inOpenedScreen: () => false,
    leaveTiles: () => { state.tiles = false; }, backToTiles: () => { state.tiles = true; paint(); },
    tileCtx: () => ({ data, now, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null }),
    runTileEffect: () => {}, runModelAction: run, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {} };
  queue = new InputQueue({ apply: makeHandle(host), hold: makeHoldHandle(host), holdToken: visibleToken,
    menu: () => {}, foreground: () => state.foreground, generation: () => model.generation,
    screen: () => model.screenKind, log: () => {},
    settled: () => state.render ? state.render.then(() => 'rendered' as const) : Promise.resolve('rendered' as const) }, undefined, undefined, 10);
  expiry = new AgentConfirmExpiry({ deadline: () => model.agentConfirmDeadline(), expire: t => model.expireAgentConfirm(t), now: () => now,
    enqueue: fn => queue.pushExternal('agent-confirm-expiry', fn), changed: paint },
    ((fn: () => void, ms: number) => { const id = ++sequence; timers.set(id, { at: now + ms, fn }); return id; }) as unknown as typeof setTimeout,
    ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout);
  assert.equal(await glasses.connect(), true);
  const emit = (type: OsEventTypeList) => event({ sysEvent: { eventType: type } } as EvenHubEvent);
  const hold = () => { emit(OsEventTypeList.LONG_PRESS_EVENT); emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT); };
  const tap = () => emit(OsEventTypeList.CLICK_EVENT);
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) { const item = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!item || item[1].at > end) break;
      now = item[1].at; timers.delete(item[0]); item[1].fn(); }
    now = end; await flush();
  };
  const confirm = async () => { tap(); await flush(); event({ audioEvent: { audioPcm: Uint8Array.of(1, 2) } } as EvenHubEvent); hold(); await flush(); assert.equal(model.screenKind, 'confirm'); };
  return { model, queue, state, glasses, actions, mics, uploads, tap, hold, emit, advance, confirm, paint,
    close: () => { voice.abandon(); expiry.sync(); glasses.dispose(); } };
}

test('real SDK three touch taps on Orchestrator never stop, transcribe or send', async () => {
  const r = await rig(); try {
    for (let i = 0; i < 3; i++) { r.tap(); await flush(); }
    assert.deepEqual(r.mics, [true]); assert.deepEqual(r.uploads, []);
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
    assert.match(r.model.render(100000), /hold to stop/i);
  } finally { r.close(); }
});

test('real SDK tap plus separate stop/send holds sends exactly once to the frozen Orchestrator', async () => {
  const r = await rig(); try {
    await r.confirm(); r.hold(); await flush();
    const prompts = r.actions.filter(a => a.kind === 'prompt');
    assert.equal(prompts.length, 1); assert.equal(prompts[0].pane, 'orchestrator');
    assert.equal(prompts[0].text, 'fixture private speech'); assert.equal(r.uploads.length, 1);
    r.hold(); await flush(); assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 1);
  } finally { r.close(); }
});

test('two stop holds captured before the first frame settles cannot become a send after ASR', async () => {
  const r = await rig(), render = gate<void>(); try {
    r.state.render = render.promise; r.tap(); await flush();
    r.hold(); r.hold(); r.state.render = null; render.resolve(); await flush();
    assert.equal(r.model.screenKind, 'confirm'); assert.equal(r.uploads.length, 1);
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
  } finally { render.resolve(); r.close(); }
});

test('remote select retains the intentional three-select agent flow through the same queue', async () => {
  const r = await rig(); try {
    for (let i = 0; i < 3; i++) { r.queue.push('select', 'remote'); await flush(); }
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 1);
    assert.equal(r.model.screenKind, 'agent');
  } finally { r.close(); }
});

test('the production scheduler auto-cancels at exactly 20s without another input; repaint does not rearm', async () => {
  const r = await rig(); try {
    await r.confirm(); await r.advance(19999); r.paint();
    assert.equal(r.model.screenKind, 'confirm'); await r.advance(1);
    assert.equal(r.model.screenKind, 'agent');
    assert.doesNotMatch(r.model.render(120000), /fixture private speech/);
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
  } finally { r.close(); }
});

test('a send hold queued before expiry cannot send after its deadline even ahead of the expiry update', async () => {
  const r = await rig(), render = gate<void>(); try {
    await r.confirm(); r.state.render = render.promise; r.queue.push('up', 'touch'); await flush();
    r.hold(); await r.advance(20000); r.state.render = null; render.resolve(); await flush();
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
    assert.equal(r.model.screenKind, 'agent');
  } finally { render.resolve(); r.close(); }
});

test('Tiles or blank taking the front clears agent voice and suppresses later holds', async () => {
  for (const surface of ['tiles', 'blank'] as const) {
    const r = await rig(); try {
      await r.confirm(); r.state[surface] = true; r.paint(); r.hold(); await flush();
      assert.equal(r.model.agentHoldToken(), null); assert.equal(r.model.agentConfirmDeadline(), null);
      assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
    } finally { r.close(); }
  }
});

test('Muse keeps tap-stop/tap-send and ignores the separate agent hold path', async () => {
  const r = await rig(); try {
    r.model.openTarget({ kind: 'muse' }); r.hold(); await flush();
    for (let i = 0; i < 3; i++) { r.tap(); await flush(); }
    assert.equal(r.actions.filter(a => a.kind === 'askMuse').length, 1);
    assert.equal(r.actions.filter(a => a.kind === 'prompt').length, 0);
    assert.equal(r.uploads.length, 0, 'agent transcriber must never intercept Muse');
  } finally { r.close(); }
});
