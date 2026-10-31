import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { HomeModel, type HomeData } from '../src/model';
import { MENU, GLASSES_MENU } from '../src/menu';
import { HomeListen } from '../src/listen/home';
import type { ListenHubPort } from '../src/listen/hub';
import { InputQueue } from '../src/inputqueue';

const data: HomeData = { now: 1000, paused: false, voice: true, muse: true,
  machines: [{ name: 'Fixture', online: true }], sessions: [], pending: [], messages: [] };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function transport(audio: (on: boolean) => Promise<boolean> = async () => true, onAudio: (pcm: Uint8Array) => void = () => {}) {
  const pages: { textObject: { content: string }[] }[] = [];
  const upgrades: { containerID: number; content: string }[] = [];
  let event: (value: EvenHubEvent) => void = () => {};
  const bridge = {
    onEvenHubEvent: (callback: typeof event) => { event = callback; return () => {}; }, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ batteryLevel: 90 }),
    createStartUpPageContainer: async (page: typeof pages[number]) => { pages.push(page); return StartUpPageCreateResult.success; },
    rebuildPageContainer: async (page: typeof pages[number]) => { pages.push(page); return true; },
    textContainerUpgrade: async (change: typeof upgrades[number]) => { upgrades.push(change); return true; },
    audioControl: audio,
  } as unknown as EvenAppBridge;
  const glasses = new Glasses({ bridge: async () => bridge, onInput: () => {}, onMenu: () => {},
    onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio }, GLASSES_MENU);
  return { glasses, pages, upgrades, emit: (value: EvenHubEvent) => event(value) };
}

function hubFixture() {
  const chunks: Uint8Array[] = [], stops: string[] = [];
  let id = 0;
  const hub: ListenHubPort = {
    start: async () => ({ id: `fixture-${++id}`, startedAt: 1000 }),
    chunk: async (_id, _seq, pcm) => { chunks.push(pcm); return { ok: true, lines: [{ t: 0, text: 'Fixture transcript' }] }; },
    stop: async id => { stops.push(id); },
    poll: async id => ({ id, startedAt: 1000, state: 'listening', now_t: 6000,
      lines: [{ t: 0, text: 'Beginning' }, { t: 3000, text: 'Anchor transcript' }],
      notes: [{ t: 5000, at_t: 0, text: 'First fixture note' }, { t: 6000, at_t: 3000, text: 'Useful fixture note' }], muse: { state: 'idle' } }),
    waitInput: async () => ({ seq: 0, inputs: [] }),
  };
  return { hub, chunks, stops };
}

test('Home row opens the distinct idle Listen screen and Back preserves the existing Muse entry', () => {
  const model = new HomeModel(); model.update(data);
  for (let i = 0; i < 20 && !/> Muse Listen$/m.test(model.render(1000)); i++) model.input('down', 1000, 'remote');
  assert.match(model.render(1000), /> Muse Listen$/m);
  assert.equal(model.input('select', 1000, 'remote'), null);
  assert.equal(model.screenKind, 'museListen');
  assert.equal(model.micWanted(), false);
  assert.equal(model.input('back', 1000), null);
  assert.equal(model.screenKind, 'home');
  model.goListen(); assert.equal(model.screenKind, 'museListen');
  assert.equal(GLASSES_MENU.find(item => item.id === MENU.listen)?.name, 'Muse Listen');
  assert.equal(GLASSES_MENU.find(item => item.id === MENU.muse)?.name, 'Muse');
  assert.equal(GLASSES_MENU.length, 10);
});

test('Listen uses two serialized boxes, changed-side updates, and a full rebuild on leaving', async () => {
  const f = transport();
  try {
    assert.equal(await f.glasses.connect(), true);
    f.glasses.setListenFrame('idle', 'Listening idle', 'MUSE');
    assert.equal(await f.glasses.settled(5000), 'rendered');
    const count = f.pages.length;
    assert.equal(f.pages.at(-1)?.textObject.length, 2);
    f.glasses.setListenFrame('idle', 'Listening new transcript', 'MUSE');
    assert.equal(await f.glasses.settled(5000), 'rendered');
    assert.equal(f.pages.length, count);
    assert.equal(f.upgrades.at(-1)?.content, 'Listening new transcript');
    f.glasses.setText('HOME');
    assert.equal(await f.glasses.settled(5000), 'rendered');
    assert.equal(f.pages.at(-1)?.textObject.length, 1);
  } finally { f.glasses.dispose(); }
});

test('raw Listen microphone completion fences a following legacy owner until off is acknowledged', async () => {
  const on = deferred<boolean>(), off = deferred<boolean>();
  const calls: boolean[] = [];
  const f = transport(async wanted => { calls.push(wanted); return calls.length === 1 ? on.promise : calls.length === 2 ? off.promise : true; });
  try {
    await f.glasses.connect();
    const opening = f.glasses.listenMicrophone(true);
    await flush();
    assert.deepEqual(calls, [true]);
    assert.equal(f.glasses.microphoneBusy(), true);
    const closing = f.glasses.listenMicrophone(false);
    const nextOwner = f.glasses.microphone(true);
    await flush(); assert.deepEqual(calls, [true]);
    on.resolve(true); await opening; await flush();
    assert.deepEqual(calls, [true, false]);
    assert.equal(f.glasses.microphoneBusy(), true);
    off.resolve(true); await closing; await nextOwner;
    assert.deepEqual(calls, [true, false, true]);
    await f.glasses.microphone(false);
    assert.equal(f.glasses.microphoneBusy(), false);
  } finally { f.glasses.dispose(); }
});

test('an unconfirmed legacy microphone stop keeps Listen acquisition unavailable', async () => {
  const f = transport(async on => on);
  try {
    await f.glasses.connect();
    assert.equal(await f.glasses.microphone(true), true);
    assert.equal(await f.glasses.microphone(false), false);
    assert.equal(f.glasses.microphoneBusy(), true);
  } finally { f.glasses.dispose(); }
});

test('SDK PCM routes exclusively to Listen; remote starts, touch stops, note selects anchor, leave turns mic off', async () => {
  const fixture = hubFixture(), audio: boolean[] = [], legacy: Uint8Array[] = [];
  let controller: HomeListen;
  const f = transport(async on => { audio.push(on); return true; }, pcm => { if (!controller.onAudio(pcm)) legacy.push(pcm); });
  controller = new HomeListen({ hub: () => fixture.hub,
    mic: { on: () => f.glasses.listenMicrophone(true), off: () => f.glasses.listenMicrophone(false) },
    busy: () => f.glasses.microphoneBusy(), changed: () => {}, leave: () => {}, now: () => 7000 });
  try {
    await f.glasses.connect(); controller.enter();
    await controller.input('select', 'touch');
    assert.deepEqual(audio, []);
    const start = controller.input('select', 'remote');
    assert.equal(controller.ownsMic, true, 'Claims before hub/mic startup await');
    await start;
    f.emit({ audioEvent: { audioPcm: new Uint8Array(288_000) } } as EvenHubEvent);
    await flush();
    assert.equal(fixture.chunks.length, 1);
    assert.deepEqual(legacy, []);
    await controller.poll(); await controller.input('down', 'remote');
    assert.equal(controller.view().transcriptAt, 0);
    assert.match(controller.frame().right, /Useful fixture\s+note/);
    await controller.input('select', 'touch');
    assert.equal(controller.ownsMic, false);
    assert.equal(audio.at(-1), false);
    assert.equal(f.glasses.microphoneBusy(), false);
    await controller.input('select', 'remote');
    await controller.leave();
    assert.equal(controller.view().active, false);
    assert.equal(controller.ownsMic, false);
    assert.ok(fixture.stops.length >= 2);
  } finally { await controller.leave(); f.glasses.dispose(); }
});

test('actual main menu/paint hooks reenter idle Listen after same-screen and nonnavigation menu cleanup', async () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const hook = (name: string) => {
    const start = `  // Muse Listen hook BEGIN ${name}\n`, end = `  // Muse Listen hook END ${name}`;
    assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
    return source.split(start)[1].split(end)[0];
  };
  const fixture = hubFixture(), model = new HomeModel(); model.update(data); model.goListen();
  const scope: Record<string, any> = { model, listenVisible: false, listenHoldToken: {}, recording: null,
    MENU, blank: false, tilesActive: false, fromTiles: false, status: '',
    showingListen: () => model.screenKind === 'museListen', glasses: { setListenFrame: () => {} },
    $: () => ({}), syncAgentConfirmExpiry: () => {}, run: () => {}, leaveDesk: () => {}, wake: () => {} };
  const paint = new Function('scope', `with(scope) { ${hook('live-paint')} }`);
  const Menu = Object.getPrototypeOf(async function() {}).constructor;
  const menu = new Menu('scope', 'id', `with(scope) { ${hook('live-menu')} }`);
  const controller = new HomeListen({ hub: () => fixture.hub, mic: { on: async () => true, off: async () => true },
    busy: () => false, changed: () => scope.paint(), leave: () => model.goHome(), now: () => 1000 });
  scope.homeListen = controller; scope.paint = () => paint(scope);
  try {
    scope.paint(); await controller.input('select', 'remote');
    assert.equal(controller.view().phase, 'listening');
    await menu(scope, MENU.listen);
    assert.equal(controller.view().active, true);
    assert.equal(controller.ownsMic, false);
    await controller.input('select', 'remote');
    assert.equal(controller.view().phase, 'listening');
    await menu(scope, MENU.pause); scope.paint();
    assert.equal(controller.view().active, true);
    await controller.input('select', 'remote');
    assert.equal(controller.view().phase, 'listening');
  } finally { scope.showingListen = () => false; await controller.leave(); }
});

test('actual Listen arrival hook keeps double-down timing across a real queue frame wait', async () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = '  // Muse Listen hook BEGIN arrival-navigation\n', end = '  // Muse Listen hook END arrival-navigation';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const body = source.split(start)[1].split(end)[0];
  const arrivalHandler = new Function('scope', 'input', 'source', `with(scope) { ${body} }`);
  for (const [gap, expected] of [[100, null], [401, 1]] as const) {
    let now = 1000;
    const fixture = hubFixture(); let busyResolve!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { busyResolve = resolve; });
    const frame = new Promise<void>(resolve => { release = resolve; });
    const queue = new InputQueue({ apply: () => held, menu: () => {}, generation: () => 0,
      foreground: () => true, screen: () => 'fixture', settled: async () => { await frame; return 'rendered'; },
      log: () => {} });
    let controller!: HomeListen;
    controller = new HomeListen({ hub: () => fixture.hub, mic: { on: async () => true, off: async () => true },
      busy: () => false, changed: () => {}, leave: () => {}, now: () => 7000 });
    controller.enter(); await controller.input('select', 'remote'); await controller.poll();
    const scope = { showingListen: () => true, homeListen: controller, inputQueue: queue, performance: { now: () => now } };
    queue.push('select', 'remote'); // occupies the actual queue while its frame remains unsettled
    await flush(); assert.equal(queue.length, 0);
    now += 100; arrivalHandler(scope, 'down', 'touch');
    now += gap; arrivalHandler(scope, 'down', 'remote');
    assert.equal(queue.length, 0, 'Listen selection bypasses render wait and leaves no stale timing token in the queue');
    assert.equal(controller.view().selectedNoteIndex, expected);
    busyResolve(); release(); await new Promise(resolve => setTimeout(resolve, 0));
    await controller.leave();
  }
});
