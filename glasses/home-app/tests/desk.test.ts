// The Desk (test): grid + menu + taskbar, the head pointer with a fake IMU, and IMU on/off with the real Glasses transport.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StartUpPageCreateResult, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { GLASSES_MENU, GLASSES_MENU_MAX } from '../src/menu';
import { HomeModel, type HomeData } from '../src/model';
import { Desk, DESK_APPS, fakePose, type DeskHost } from '../src/desk';
import { Pointer, DEFAULT_POINTER, type Sample } from '../src/deskpointer';
import { makeHandle, type FlowHost } from '../src/inputflow';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = { now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: [], muse: true, studio: { at: NOW, machines: [], feed: [] } };

/** A Desk with a fake clock, a fake IMU switch and a paint that takes `renderMs`. */
function rig(renderMs = 0) {
  const r = { t: 0, imu: [] as boolean[], paints: 0, diag: [] as string[], settledAt: [] as number[], pendingSettles: [] as (() => void)[] };
  const host: DeskHost = {
    imu: async open => { r.imu.push(open); return true; },
    paint: () => { r.paints++; },
    settled: () => (renderMs ? new Promise<void>(res => { r.pendingSettles.push(res); }) : Promise.resolve()),
    diag: (n, d) => r.diag.push(`${n} ${d}`),
    now: () => r.t,
  };
  const desk = new Desk(host, { ...DEFAULT_POINTER, smoothing: 1, deadZone: 8, recenterMs: 1000 });
  return { r, desk };
}
/** Feed samples every 100 ms from the current pose to `to`. */
function drive(r: { t: number }, desk: Desk, from: Sample, to: Sample, steps = 3) {
  for (let i = 1; i <= steps; i++) {
    r.t += 100;
    desk.imuSample({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, z: 0 });
  }
}
const flush = () => sleep(0);

test('the grid has the nine apps, a taskbar line, and fits 10 lines of 56 characters', () => {
  const { desk } = rig();
  assert.deepEqual(DESK_APPS.map(a => a.label), ['Muse', 'Messages', 'Agents', 'Reminders', 'Clock', 'Listen', 'Studio', 'Settings', 'Tiles']);
  const lines = desk.render().split('\n');
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= 56, `"${l}" is ${l.length}`);
  assert.ok(lines.some(l => l.startsWith('Taskbar:')));
  assert.match(desk.render(), /\[ +Muse +\]/); // the first cell is highlighted
});

test('up or tap opens the highlighted app; double-tap goes Home; two downs within 400 ms go Home', () => {
  const { desk } = rig();
  assert.deepEqual(desk.input('up', 1000), { kind: 'open', app: 'muse' });
  assert.deepEqual(desk.input('select', 2000), { kind: 'open', app: 'muse' });
  assert.deepEqual(desk.input('back', 3000), { kind: 'home' });
  assert.equal(desk.input('down', 5000), null); // first down: menu
  assert.ok(desk.menuOpen);
  assert.deepEqual(desk.input('down', 5300), { kind: 'home' }); // second within 400 ms
  assert.ok(!desk.menuOpen);
  assert.equal(desk.input('down', 7000), null);
  assert.equal(desk.input('down', 7500), null); // 500 ms apart: moves in the menu, not Home
  assert.match(desk.render(), /\[Minimize\]/);
});

test('the menu: Open, Minimize (taskbar), Close (off the taskbar), Back; Back from an app minimizes it', () => {
  const { desk } = rig();
  desk.input('down', 0);
  assert.deepEqual(desk.input('select', 100), { kind: 'open', app: 'muse' }); // Open
  desk.input('down', 1000); desk.input('down', 2000); // Minimize
  assert.equal(desk.input('select', 3000), null);
  assert.deepEqual(desk.minimizedApps, ['muse']);
  assert.match(desk.render(), /Taskbar: Muse/);
  desk.appBack('agents');
  assert.deepEqual(desk.minimizedApps, ['muse', 'agents']);
  desk.input('down', 5000); desk.input('down', 6000); desk.input('down', 7000); // Close
  desk.input('select', 8000);
  assert.deepEqual(desk.minimizedApps, ['agents']);
  desk.input('down', 9000); desk.input('down', 10000); desk.input('down', 11000); desk.input('down', 12000); // Back
  assert.equal(desk.input('select', 13000), null);
  assert.ok(!desk.menuOpen);
});

test('a fake IMU moves the highlight one cell per head turn, and the move is logged', async () => {
  const { r, desk } = rig();
  await desk.enter();
  assert.deepEqual(r.imu, [true]);
  desk.imuSample({ x: 0, y: 0, z: 0 });
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }); // turn right
  await flush();
  assert.equal(desk.highlighted, 'messages');
  assert.equal(r.paints, 1);
  assert.match(r.diag.join('\n'), /desk\.move 0->1 \d+/);
  drive(r, desk, { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }); // head back to the middle re-arms
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 0, y: -20, z: 0 }); // pitch down = the row below
  await flush();
  assert.equal(desk.highlighted, 'clock');
  // staying turned does not keep moving
  drive(r, desk, { x: 0, y: -20, z: 0 }, { x: 0, y: -20, z: 0 }, 5);
  assert.equal(desk.highlighted, 'clock');
});

test('the dead zone holds still; the edge of the grid stops the move', async () => {
  const { r, desk } = rig();
  await desk.enter();
  desk.imuSample({ x: 0, y: 0, z: 0 });
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 });
  drive(r, desk, { x: 5, y: 5, z: 0 }, { x: -5, y: 0, z: 0 });
  await flush();
  assert.equal(desk.highlighted, 'muse');
  assert.equal(r.paints, 0);
  drive(r, desk, { x: -5, y: 0, z: 0 }, { x: -40, y: 0, z: 0 }); // left of column 0: nothing to move to
  await flush();
  assert.equal(desk.highlighted, 'muse');
  assert.equal(r.paints, 0, 'no repaint when the target cell does not change');
});

test('holding still re-centres, and so does any press', async () => {
  const { r, desk } = rig();
  await desk.enter();
  desk.imuSample({ x: 0, y: 0, z: 0 });
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }); // -> messages
  for (let i = 0; i < 12; i++) { r.t += 100; desk.imuSample({ x: 20, y: 0, z: 0 }); } // ~1 s still: x=20 is the new centre
  await flush();
  assert.equal(desk.highlighted, 'messages');
  drive(r, desk, { x: 20, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }); // another turn right from the new centre
  await flush();
  assert.equal(desk.highlighted, 'agents');
  // a press re-centres: the pose at the next sample is the centre, so a small drift from it does nothing
  desk.input('down', 1); desk.input('back', 2);
  desk.imuSample({ x: 100, y: 0, z: 0 });
  drive(r, desk, { x: 100, y: 0, z: 0 }, { x: 103, y: 0, z: 0 });
  assert.equal(desk.highlighted, 'agents');
});

test('moves while a frame is in flight are painted once, after it settles (never faster than the glasses)', async () => {
  const { r, desk } = rig(100);
  await desk.enter();
  desk.imuSample({ x: 0, y: 0, z: 0 });
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }); // -> messages, paint 1 in flight
  assert.equal(r.paints, 1);
  desk.input('up', 0); // (a press re-centres)
  desk.imuSample({ x: 20, y: 0, z: 0 });
  drive(r, desk, { x: 20, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }); // -> agents while paint 1 is unsettled
  assert.equal(r.paints, 1, 'no second paint until the first settles');
  assert.equal(desk.highlighted, 'agents');
  r.t += 80; r.pendingSettles.shift()!(); await flush();
  assert.equal(r.paints, 2, 'the newest cell is painted once');
  assert.match(r.diag.join('\n'), /desk\.move 0->1 \d+/);
});

test('no IMU (the Even app says no): the menu stays open across 10 s of retry timers, and "could not start" is logged once', async () => {
  const { r, desk } = rig();
  let asked = 0;
  (desk as unknown as { host: DeskHost }).host.imu = async () => { asked++; return false; };
  await desk.enter();
  assert.equal(asked, 1);
  desk.input('down', 1000);
  assert.ok(desk.menuOpen);
  for (let i = 0; i < 4; i++) { r.t += 3000; await desk.resume(); } // main.ts's 3 s timer
  assert.ok(desk.menuOpen, 'the menu is still open');
  assert.equal(asked, 1, 'no retries after a failure');
  await desk.resume(true); // the app came back to the front: one more try, still no reset
  assert.equal(asked, 2);
  assert.ok(desk.menuOpen);
  assert.equal(r.diag.filter(d => d === 'desk.imu could not start').length, 1);
});

test('desk.imu is logged once, after the first 10 s, with pace, rate and ranges', async () => {
  const { r, desk } = rig();
  await desk.enter();
  for (let i = 0; i <= 105; i++) { desk.imuSample({ x: i % 5, y: -(i % 3), z: 9 }); r.t += 100; }
  const lines = r.diag.filter(d => d.startsWith('desk.imu'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^desk\.imu pace=100 rate=\d+(\.\d)?Hz x=\[0,4\] y=\[-2,0\] z=\[9,9\]$/);
});

test('pointer: pure maths with an injected sample stream', () => {
  const p = new Pointer({ ...DEFAULT_POINTER, smoothing: 1 });
  assert.equal(p.sample(0, { x: 0, y: 0, z: 0 }), null);
  assert.deepEqual(p.sample(100, { x: 12, y: 0, z: 0 }), { dCol: 1, dRow: 0 });
  assert.equal(p.sample(200, { x: 14, y: 0, z: 0 }), null); // still turned: no second step
  assert.equal(p.sample(300, { x: 0, y: 0, z: 0 }), null); // back through the dead zone re-arms
  assert.deepEqual(p.sample(400, { x: 0, y: 12, z: 0 }), { dCol: 0, dRow: -1 });
});

// --- IMU on/off through the real Glasses transport ----------------------------------------------------------------------
const rigs: Glasses[] = [];
after(() => { for (const g of rigs) g.dispose(); });
function glassesRig() {
  const calls: boolean[] = [];
  const state: { handler: ((e: unknown) => void) | null } = { handler: null };
  const samples: Sample[] = [];
  let offs = 0;
  const bridge = {
    onEvenHubEvent: (h: (e: unknown) => void) => { state.handler = h; return () => {}; }, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    rebuildPageContainer: async () => true, textContainerUpgrade: async () => true,
    audioControl: async () => true, shutDownPageContainer: async () => true,
    imuControl: async (open: boolean) => { calls.push(open); return true; },
  } as unknown as EvenAppBridge;
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onImu: s => samples.push(s), onImuOff: () => { offs++; }, bridge: async () => bridge,
  }, GLASSES_MENU);
  rigs.push(g);
  return { g, calls, samples, offs: () => offs, send: (e: unknown) => state.handler!(e) };
}
const sys = (eventType: number, imuData?: { x: number; y: number; z: number }) => ({ sysEvent: { eventType, imuData } });

test('IMU samples arrive only while tracking is on; they are not taken for a tap', async () => {
  const t = glassesRig();
  await t.g.connect();
  t.send(sys(OsEventTypeList.IMU_DATA_REPORT, { x: 1, y: 2, z: 3 }));
  assert.equal(t.samples.length, 0);
  assert.equal(await t.g.imu(true), true);
  t.send(sys(OsEventTypeList.IMU_DATA_REPORT, { x: 1, y: 2, z: 3 }));
  assert.deepEqual(t.samples, [{ x: 1, y: 2, z: 3 }]);
  assert.deepEqual(t.calls, [true]);
  await t.g.imu(false);
  assert.deepEqual(t.calls, [true, false]);
});

for (const [name, event] of [['foreground exit', OsEventTypeList.FOREGROUND_EXIT_EVENT], ['app exit', OsEventTypeList.SYSTEM_EXIT_EVENT], ['abnormal exit', OsEventTypeList.ABNORMAL_EXIT_EVENT]] as const) {
  test(`IMU is switched off on ${name}`, async () => {
    const t = glassesRig();
    await t.g.connect();
    await t.g.imu(true);
    t.send(sys(event));
    assert.deepEqual(t.calls, [true, false]);
    assert.equal(t.offs(), 1);
    t.send(sys(OsEventTypeList.IMU_DATA_REPORT, { x: 1, y: 1, z: 1 }));
    assert.equal(t.samples.length, 0, 'late samples are ignored');
  });
}

test('IMU is switched off on reconnect', async () => {
  const t = glassesRig();
  await t.g.connect();
  await t.g.imu(true);
  t.send(sys(OsEventTypeList.SYSTEM_EXIT_EVENT));
  await t.g.connect();
  assert.equal(t.offs(), 1);
  assert.deepEqual(t.calls, [true, false]);
});

test('leaving the Desk switches the IMU off', async () => {
  const { r, desk } = rig();
  await desk.enter();
  desk.leave();
  await flush();
  assert.deepEqual(r.imu, [true, false]);
  desk.imuSample({ x: 0, y: 0, z: 0 });
  drive(r, desk, { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 });
  assert.equal(desk.highlighted, 'muse', 'no moves once tracking is off');
  desk.imuLost(); // the transport switched it off (background)
  await desk.resume();
  assert.deepEqual(r.imu, [true, false, true], 'coming back to the front switches it on again');
});

// --- Home row, startup, flow ----------------------------------------------------------------------------------------------
test('Home has a Desk (test) row within 10 lines, and selecting it asks main to open the Desk; the menu stays within 10', () => {
  const m = new HomeModel();
  m.update(data);
  const lines = m.render(NOW).split('\n');
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  for (let i = 0; i < 12; i++) m.input('down', NOW); // scroll to the end of the list
  assert.match(m.render(NOW), /Desk \(test\)/);
  assert.ok(m.render(NOW).split('\n').length <= 10);
  assert.deepEqual(m.input('select', NOW), { kind: 'openDesk' });
  assert.ok(GLASSES_MENU.length <= GLASSES_MENU_MAX);
});

test('startup does not load the Desk: main.ts imports it only with import() and as a type', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import (?!type)[^;]*from '\.\/desk(pointer)?';/m);
  assert.match(src, /import\('\.\/desk'\)/);
  for (const f of ['model.ts', 'inputflow.ts', 'glasses.ts', 'tiles.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /from '\.\/desk(pointer)?'/, f);
  }
});

test('the press flow: the Desk takes every press while showing; an app opened from it returns to the Desk when it goes Home', () => {
  const model = new HomeModel(); model.update(data);
  let desk = true, app = false, inputs: string[] = [], back = 0;
  const host = {
    model, tiles: {}, tileCtx: () => ({}), showingTiles: () => false, inOpenedScreen: () => false, leaveTiles: () => {}, backToTiles: () => {},
    paint: () => {}, isBlank: () => false, wake: () => {}, runTileEffect: () => {}, runModelAction: () => {}, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => NOW,
    showingDesk: () => desk, deskInput: (i: string) => { inputs.push(i); }, inDeskApp: () => app, backToDesk: () => { back++; app = false; desk = true; },
  } as unknown as FlowHost;
  const handle = makeHandle(host);
  handle('up'); handle('back');
  assert.deepEqual(inputs, ['up', 'back']);
  desk = false; app = true; model.goTo('messages');
  handle('back'); // Messages -> Home -> the Desk
  assert.equal(back, 1);
  assert.equal(desk, true);
});

test('?imu=fake: the scripted head walks the highlight right, down, left, up; off without the flag; stops on leave', async () => {
  const mk = (fake: boolean) => {
    const r = { t: 0, imu: [] as boolean[], diag: [] as string[], paints: 0 };
    const host: DeskHost = { imu: async o => { r.imu.push(o); return false; }, paint: () => { r.paints++; }, settled: async () => {}, diag: (n, d) => r.diag.push(`${n} ${d}`), now: () => r.t };
    return { r, desk: new Desk(host, { ...DEFAULT_POINTER, smoothing: 1 }, { fake }) };
  };
  const { r, desk } = mk(true);
  await desk.enter();
  assert.ok(desk.imuOn);
  const path: string[] = [desk.highlighted];
  try {
    for (let ms = 0; ms <= 10_000; ms += 100) {
      r.t = ms;
      desk.imuSample(fakePose(ms));
      if (path.at(-1) !== desk.highlighted) path.push(desk.highlighted);
    }
  } finally { desk.leave(); }
  assert.deepEqual(path, ['muse', 'messages', 'clock', 'reminders', 'muse'].map(x => x));
  assert.ok(r.paints >= 1);
  desk.leave();
  assert.ok(!desk.imuOn);
  const off = mk(false);
  await off.desk.enter();
  assert.ok(!off.desk.imuOn, 'without the flag nothing is scripted');
});
