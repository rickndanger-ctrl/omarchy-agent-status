// small-0427: the Muse tile ask returns to Tiles, full-screen Muse screens are page rebuilds, frame cut/failed logs, the remote 'settings' ignored on Muse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StartUpPageCreateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { HomeModel, type HomeData } from '../src/model';
import { Glasses, TEXT_SAFE_MAX } from '../src/glasses';
import { GLASSES_MENU } from '../src/menu';
import { remoteSettingsIgnored } from '../src/inputflow';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = { now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: [], muse: true, voice: true };
const askFrom = (m: HomeModel, target: object) => {
  assert.deepEqual(m.openTarget(target as never), { kind: 'startMic' });
  assert.deepEqual(m.input('select', NOW), { kind: 'stopMic' });
  m.setTranscript('what is on my calendar', NOW);
  return m.input('select', NOW) as { kind: string; fromTile?: true };
};

test('an ask started from the Muse TILE says so (the app goes back to Tiles); one from the full-screen Muse view does not', () => {
  const tile = new HomeModel(); tile.update(data);
  const a = askFrom(tile, { kind: 'muse', then: 'listen', fromTile: true });
  assert.equal(a.kind, 'askMuse');
  assert.equal(a.fromTile, true);
  const full = new HomeModel(); full.update(data); full.goTo('muse');
  full.openTarget({ kind: 'muse' } as never);
  assert.deepEqual(full.input('select', NOW), { kind: 'startMic' }, 'select on the Muse screen listens');
  full.input('select', NOW); full.setTranscript('again', NOW);
  const b = full.input('select', NOW) as { kind: string; fromTile?: true };
  assert.equal(b.kind, 'askMuse');
  assert.equal(b.fromTile, undefined);
  // "Talk again" keeps the origin
  const t2 = new HomeModel(); t2.update(data);
  t2.openTarget({ kind: 'muse', then: 'listen', fromTile: true } as never); t2.input('select', NOW); t2.setTranscript('x', NOW);
  t2.input('down', NOW); // Talk again
  assert.deepEqual(t2.input('select', NOW), { kind: 'startMic' });
  t2.input('select', NOW); t2.setTranscript('y', NOW);
  assert.equal((t2.input('select', NOW) as { fromTile?: true }).fromTile, true);
});

test('the remote settings button is ignored on Muse, listening and confirm; it still opens from Home and Tiles', () => {
  for (const s of ['muse', 'listen', 'confirm']) assert.equal(remoteSettingsIgnored(s), true, s);
  for (const s of ['home', 'tiles', 'agents', 'messages', 'desk']) assert.equal(remoteSettingsIgnored(s), false, s);
});

function rig() {
  const calls: { kind: string; text: string }[] = [];
  const life: string[] = [];
  let failNext = false;
  const bridge = {
    onEvenHubEvent: () => () => {}, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    rebuildPageContainer: async (c: { textObject?: { content?: string }[] }) => { calls.push({ kind: 'rebuild', text: c.textObject?.[0]?.content ?? '' }); return true; },
    textContainerUpgrade: async (u: { content?: string }) => { calls.push({ kind: 'upgrade', text: u.content ?? '' }); if (failNext) { failNext = false; return false; } return true; },
    audioControl: async () => true, shutDownPageContainer: async () => true,
  } as unknown as EvenAppBridge;
  const g = new Glasses({ onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onLifecycle: e => life.push(e), bridge: async () => bridge }, GLASSES_MENU);
  return { g, calls, life, failNext: () => { failNext = true; } };
}

test('forceRebuild sends the next frame as a full page rebuild, a plain text change stays an update', async () => {
  const { g, calls } = rig();
  try {
    await g.connect();
    g.setText('first'); await g.settled(3000);
    g.setText('second'); await g.settled(3000);
    assert.equal(calls.at(-1)!.kind, 'upgrade');
    g.forceRebuild(); g.setText('third'); await g.settled(3000);
    assert.deepEqual(calls.at(-1), { kind: 'rebuild', text: 'third' });
    g.setText('fourth'); await g.settled(3000);
    assert.equal(calls.at(-1)!.kind, 'upgrade');
  } finally { g.dispose(); }
});

test('a frame cut to the safe size and a failed write are logged', async () => {
  const { g, calls, life, failNext } = rig();
  try {
    await g.connect();
    g.setText('x'); await g.settled(3000);
    const long = 'word '.repeat(400);
    g.setText(long); await g.settled(3000);
    assert.ok(calls.at(-1)!.text.length <= TEXT_SAFE_MAX);
    assert.ok(life.some(l => /^frame cut \d+ -> 950 chars$/.test(l)), life.join(' | '));
    failNext(); g.setText('will fail'); await g.settled(3000);
    assert.ok(life.some(l => l.startsWith('frame failed ')), life.join(' | '));
  } finally { g.dispose(); }
});

test('the final answer arrives while a write is in flight: the forced rebuild is sticky, the NEXT draw is a rebuild carrying the answer', async () => {
  const calls: { kind: string; text: string }[] = [];
  const slow = (ms: number) => new Promise(r => setTimeout(r, ms));
  const bridge = {
    onEvenHubEvent: () => () => {}, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    rebuildPageContainer: async (c: { textObject?: { content?: string }[] }) => { await slow(30); calls.push({ kind: 'rebuild', text: c.textObject?.[0]?.content ?? '' }); return true; },
    textContainerUpgrade: async (u: { content?: string }) => { await slow(250); calls.push({ kind: 'upgrade', text: u.content ?? '' }); return true; }, // a slow update
    audioControl: async () => true, shutDownPageContainer: async () => true,
  } as unknown as EvenAppBridge;
  const g = new Glasses({ onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, bridge: async () => bridge }, GLASSES_MENU);
  try {
    await g.connect();
    g.setText('first'); await g.settled(3000);
    g.setText('partial answer'); // an update goes out (slow) ...
    for (let i = 0; i < 200 && !g.busy(); i++) await slow(10); // until the (250 ms) write has started
    assert.equal(g.busy(), true, 'a write is in flight');
    g.forceRebuild(); g.setText('the final answer', true); // ... and the final answer lands meanwhile
    await g.settled(5000);
    const last = calls.at(-1)!;
    assert.deepEqual(last, { kind: 'rebuild', text: 'the final answer' }, JSON.stringify(calls));
    // the sticky request is satisfied by a rebuild started AFTER it: the next plain change is an update again
    g.setText('later'); await g.settled(5000);
    assert.equal(calls.at(-1)!.kind, 'upgrade');
  } finally { g.dispose(); }
});
