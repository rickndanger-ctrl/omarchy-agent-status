// The Desk (test): grid + menu + taskbar, the head pointer with a fake IMU, and IMU on/off with the real Glasses transport.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StartUpPageCreateResult, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { GLASSES_MENU, GLASSES_MENU_MAX } from '../src/menu';
import { HomeModel, type HomeData } from '../src/model';
import { Desk, DESK_APPS, fakePose, type DeskHost } from '../src/desk';
import { Pointer, DEFAULT_POINTER, gravity, tilt, type Sample } from '../src/deskpointer';
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
  const desk = new Desk(host, DEFAULT_POINTER);
  return { r, desk };
}
/** Hold a head tilt (degrees) for `ms`, one sample every 100 ms. */
function hold(r: { t: number }, desk: Desk, roll: number, pitch: number, ms: number) {
  for (let i = 0; i < ms / 100; i++) { r.t += 100; desk.imuSample(gravity(roll, pitch)); }
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

test('12 degrees of roll is one step right; 4 degrees is none; coming back to the centre re-arms', async () => {
  const { r, desk } = rig();
  await desk.enter();
  hold(r, desk, 0, 0, 400); // the centre is found from the first 300 ms
  hold(r, desk, 4, 0, 2000);
  assert.equal(desk.highlighted, 'muse', '4 degrees does nothing');
  hold(r, desk, 12, 0, 1000);
  await flush();
  assert.equal(desk.highlighted, 'messages');
  assert.match(r.diag.join('\n'), /desk\.move 0->1 \d+/);
  hold(r, desk, 0, 0, 600); // head back: armed again
  hold(r, desk, 0, 12, 1000); // pitch 12 = one row down (default direction)
  await flush();
  assert.equal(desk.highlighted, 'clock');
});

test('held past the step angle it repeats every 0.8 s, and only then', () => {
  const p = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1 });
  for (const t0 of [-300, -200, -100, 0]) p.sample(t0, gravity(0, 0));
  const moves: number[] = [];
  for (let t = 100; t <= 3000; t += 100) if (p.sample(t, gravity(14, 0))) moves.push(t);
  assert.deepEqual(moves, [100, 900, 1700, 2500]);
  assert.equal(p.sample(3100, gravity(8, 0)), null, 'between the two angles nothing happens and nothing re-arms');
  assert.equal(p.sample(3200, gravity(3, 0)), null);
  assert.deepEqual(p.sample(3300, gravity(-14, 0)), { dCol: -1, dRow: 0 }, 're-armed under 5 degrees: one step left');
});

test('swap axes and invert X / Y flip the direction', () => {
  const run = (o: Partial<typeof DEFAULT_POINTER>, roll: number, pitch: number) => {
    const p = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1, ...o });
    for (const t0 of [-300, -200, -100, 0]) p.sample(t0, gravity(0, 0));
    return p.sample(100, gravity(roll, pitch));
  };
  assert.deepEqual(run({}, 14, 0), { dCol: 1, dRow: 0 });
  assert.deepEqual(run({ invertX: true }, 14, 0), { dCol: -1, dRow: 0 });
  assert.deepEqual(run({}, 0, 14), { dCol: 0, dRow: 1 });
  assert.deepEqual(run({ invertY: true }, 0, 14), { dCol: 0, dRow: -1 });
  assert.deepEqual(run({ swapAxes: true }, 14, 0), { dCol: 0, dRow: 1 }, 'roll now moves rows');
  assert.deepEqual(run({ swapAxes: true }, 0, 14), { dCol: 1, dRow: 0 }, 'pitch now moves columns');
  assert.deepEqual(run({ swapAxes: true, invertX: true, invertY: true }, 14, 0), { dCol: 0, dRow: -1 });
});

test('the phone switches reach a Desk that is already open', async () => {
  const { r, desk } = rig();
  await desk.enter();
  desk.setPointerOptions({ invertX: true });
  hold(r, desk, 0, 0, 400);
  hold(r, desk, -12, 0, 1000); // left, inverted = right
  await flush();
  assert.equal(desk.highlighted, 'messages');
});

test('the centre is re-taken on a press: a new resting tilt is the new zero', async () => {
  const { r, desk } = rig();
  await desk.enter();
  hold(r, desk, 0, 0, 300);
  hold(r, desk, 20, 0, 100); // swung away a little (not far enough yet to step)
  desk.input('down', 1); desk.input('back', 2); // presses: next sample is the centre
  hold(r, desk, 25, 0, 2000); // resting at 25 degrees: it is the centre now
  assert.equal(desk.highlighted, 'muse');
  hold(r, desk, 37, 0, 1000); // +12 from it
  await flush();
  assert.equal(desk.highlighted, 'messages');
});

test('one noisy first sample (+6 deg) does not become the centre: the median of the first 300 ms does', () => {
  const p = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1 });
  p.sample(0, gravity(6, 0));
  for (const t of [100, 200, 300]) p.sample(t, gravity(0, 0));
  assert.deepEqual(p.sample(400, gravity(12, 0)), { dCol: 1, dRow: 0 });
});

test('no steps while the centre is being found, even for a big tilt', () => {
  const p = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1 });
  for (const t of [0, 100, 200]) assert.equal(p.sample(t, gravity(30, 0)), null);
});

test('a fixed tilted rest pose (x=-0.3, z=0.95) taken as the centre gives no move; +12 degrees from it gives one', async () => {
  const { r, desk } = rig();
  await desk.enter();
  const rest: Sample = { x: -0.3, y: 0, z: 0.95 };
  for (let i = 0; i < 40; i++) { r.t += 100; desk.imuSample(rest); }
  assert.equal(desk.highlighted, 'muse');
  const base = tilt(rest).roll; // about -17.5 degrees
  for (let i = 0; i < 10; i++) { r.t += 100; desk.imuSample(gravity(base + 12, 0)); }
  await flush();
  assert.equal(desk.highlighted, 'messages');
});

test('a tilt under the step angle drifts into the centre only inside the re-arm zone', () => {
  const p = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1 });
  for (const t0 of [-300, -200, -100, 0]) p.sample(t0, gravity(0, 0));
  for (let t = 100; t <= 3000; t += 100) assert.equal(p.sample(t, gravity(4, 0)), null);
  // 4 degrees held for 3 s became the centre (inside the zone): now +12 from it is a step, +12 from the old centre would not be
  assert.deepEqual(p.sample(3100, gravity(16, 0)), { dCol: 1, dRow: 0 });
  const q = new Pointer({ ...DEFAULT_POINTER, lowpassMs: 1 });
  for (const t0 of [-300, -200, -100, 0]) q.sample(t0, gravity(0, 0));
  for (let t = 100; t <= 3000; t += 100) q.sample(t, gravity(8, 0)); // tilted between the angles: no centre drift
  assert.equal(q.sample(3100, gravity(-4, 0)), null, '8 degrees held for 3 s is not a new centre, so -4 is nowhere near a step');
});

test('desk.tilt is logged every 0.5 s for the first 30 s after the Desk opens, then stops', async () => {
  const { r, desk } = rig();
  await desk.enter();
  for (let i = 0; i < 400; i++) { desk.imuSample(gravity(3, -2)); r.t += 100; }
  const lines = r.diag.filter(d => d.startsWith('desk.tilt'));
  assert.ok(lines.length >= 59 && lines.length <= 61, `${lines.length} lines`);
  assert.match(lines[0], /^desk\.tilt roll=3\.0 pitch=-2\.0 raw=\d\.\d\d,-0\.0\d,\d\.\d\d$/);
});

test('desk.imu is logged once, after the first 10 s, with pace, rate and ranges', async () => {
  const { r, desk } = rig();
  await desk.enter();
  for (let i = 0; i <= 105; i++) { desk.imuSample({ x: -0.5 + (i % 5) * 0.2, y: -(i % 3) * 0.1, z: 0.9 }); r.t += 100; }
  const lines = r.diag.filter(d => d.startsWith('desk.imu'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^desk\.imu pace=100 rate=\d+(\.\d)?Hz x=\[-0\.5,0\.3\] y=\[-0\.2,0\] z=\[0\.9,0\.9\]$/);
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
  hold(r, desk, 30, 0, 2000);
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

test('?imu=fake: the scripted head (gravity in g) walks the highlight right, down, left, up; off without the flag; stops on leave', async () => {
  const mk = (fake: boolean) => {
    const r = { t: 0, imu: [] as boolean[], diag: [] as string[], paints: 0 };
    const host: DeskHost = { imu: async o => { r.imu.push(o); return false; }, paint: () => { r.paints++; }, settled: async () => {}, diag: (n, d) => r.diag.push(`${n} ${d}`), now: () => r.t };
    return { r, desk: new Desk(host, DEFAULT_POINTER, { fake }) };
  };
  const g = fakePose(500);
  assert.ok(Math.abs(Math.hypot(g.x, g.y, g.z) - 1) < 1e-9, 'a unit gravity vector');
  assert.ok(Math.abs(tilt(fakePose(1300)).roll - 14) < 1e-6, 'the scripted tilt is 14 degrees');
  const { r, desk } = mk(true);
  await desk.enter();
  assert.ok(desk.imuOn);
  const path: string[] = [desk.highlighted];
  try {
    for (let ms = 0; ms <= 9000; ms += 100) {
      r.t = ms;
      desk.imuSample(fakePose(ms));
      if (path.at(-1) !== desk.highlighted) path.push(desk.highlighted);
    }
  } finally { desk.leave(); }
  assert.deepEqual(path, ['muse', 'messages', 'clock', 'reminders', 'muse']);
  assert.ok(r.paints >= 1);
  assert.ok(!desk.imuOn);
  const off = mk(false);
  await off.desk.enter();
  assert.ok(!off.desk.imuOn, 'without the flag nothing is scripted');
});

test('real timers, slow settle (9 ms): the fake head still goes right and then down', async () => {
  const log: string[] = [];
  const host: DeskHost = { imu: async () => false, paint: () => {}, settled: () => sleep(9), diag: (n, d) => { if (n === 'desk.move') log.push(d.split(' ')[0]); }, now: () => Date.now() };
  const desk = new Desk(host, DEFAULT_POINTER, { fake: true });
  await desk.enter();
  await sleep(3800);
  desk.leave();
  assert.deepEqual(log.slice(0, 2), ['0->1', '1->4'], log.join(' '));
});
