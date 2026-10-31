import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StartUpPageCreateResult, validateEvenHubPageContainer, utf8ByteLength,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { ListenGlasses, safeText, TEXT_SAFE_MAX } from '../src/glasses';
import { createListenApp } from '../src/main';
import type { ListenHubPort } from '../src/hub';

function bridge() {
  const pages: { kind: string; value: unknown }[] = [];
  const updates: { containerID: number; content: string }[] = [];
  const mic: boolean[] = [];
  const errors: string[] = [];
  const accept = (kind: string, value: unknown) => {
    const checked = validateEvenHubPageContainer(value as Parameters<typeof validateEvenHubPageContainer>[0]);
    if ('valid' in checked && !checked.valid) { errors.push(kind); return false; }
    pages.push({ kind, value }); return true;
  };
  const sdk = {
    onEvenHubEvent: () => () => {},
    createStartUpPageContainer: async (value: unknown) => accept('startup', value) ? StartUpPageCreateResult.success : StartUpPageCreateResult.invalid,
    rebuildPageContainer: async (value: unknown) => accept('rebuild', value),
    textContainerUpgrade: async (value: { containerID: number; content: string }) => { updates.push(value); return true; },
    audioControl: async (on: boolean) => { mic.push(on); return true; },
  } as unknown as EvenAppBridge;
  return { sdk, pages, updates, mic, errors };
}

test('real SDK validation accepts startup and start/stop two-box rebuilds', async () => {
  const fake = bridge();
  const g = new ListenGlasses({ bridge: async () => fake.sdk, onAudio: () => {}, onInput: () => {}, onLifecycle: () => {}, onStatus: () => {} });
  try {
    g.setFrame({ left: '○ Ready 00:00\nSelect to start', right: 'MUSE\nNo notes yet' }, 'idle');
    assert.equal(await g.connect(), true);
    g.setFrame({ left: '● Listening 00:01\n[00:00] Fixture speech', right: 'MUSE\n[00:01] Fixture note' }, 'fixture:on');
    assert.equal(await g.settled(), 'rendered');
    g.setFrame({ left: '○ Mic off 00:02\n[00:00] Fixture speech', right: 'MUSE\n[00:01] Fixture note' }, 'fixture:off');
    assert.equal(await g.settled(), 'rendered');
    assert.deepEqual(fake.errors, []);
    assert.deepEqual(fake.pages.map(page => page.kind), ['startup', 'rebuild', 'rebuild']);
    for (const page of fake.pages) {
      const value = page.value as { containerTotalNum: number; textObject: { xPosition: number; width: number; isEventCapture: number; containerID: number; content: string }[] };
      assert.equal(value.containerTotalNum, 2);
      assert.deepEqual(value.textObject.map(box => [box.xPosition, box.width]), [[0, 288], [288, 288]]);
      assert.equal(value.textObject.reduce((n, box) => n + box.isEventCapture, 0), 1);
      assert.equal(new Set(value.textObject.map(box => box.containerID)).size, 2);
      for (const box of value.textObject) assert.ok(utf8ByteLength(box.content) <= TEXT_SAFE_MAX);
    }
    assert.deepEqual(fake.mic, [], 'Connecting or rendering must never enable the microphone');
  } finally { g.dispose(); }
});

test('stable boxes are not rewritten; transcript-only timer change leaves notes untouched', async () => {
  const fake = bridge();
  const g = new ListenGlasses({ bridge: async () => fake.sdk, onAudio: () => {}, onInput: () => {}, onLifecycle: () => {}, onStatus: () => {} });
  const initial = { left: '● Listening 00:01', right: 'MUSE\n[00:01] Stable note' };
  try {
    g.setFrame(initial, 'fixture:on'); await g.connect();
    g.setFrame(initial, 'fixture:on');
    assert.equal(await g.settled(), 'rendered'); assert.equal(fake.updates.length, 0);
    g.setFrame({ ...initial, left: '● Listening 00:02' }, 'fixture:on');
    assert.equal(await g.settled(), 'rendered');
    assert.deepEqual(fake.updates.map(item => item.containerID), [1]);
    assert.equal(fake.pages.length, 1);
  } finally { g.dispose(); }
});

test('glasses font filtering retains Listening indicators and phone history stays outside the transport', () => {
  assert.equal(safeText('● Listening 00:01\n“café” 🎉 中文 —\n○ Stopped'), '● Listening 00:01\n"café"   -\n○ Stopped');
  assert.equal(safeText('Cafe\u0301\ttext\u0000'), 'Café  text');
  const capped = safeText('● Listening 00:01\n' + 'é'.repeat(950));
  assert.ok(capped.length <= 950);
  assert.ok(utf8ByteLength(capped) <= 950);
  assert.ok(capped.startsWith('● Listening'));
  assert.ok(!/[\ud800-\udfff]/.test(safeText('\ud800')));
});

test('startup failure status and diagnostics never copy native exception or content', async () => {
  const fake = bridge(), diagnostics: string[] = [], statuses: string[] = [];
  fake.sdk.createStartUpPageContainer = async () => { throw new Error('PRIVATE_NATIVE_CONTENT'); };
  const g = new ListenGlasses({ bridge: async () => fake.sdk, onAudio: () => {}, onInput: () => {}, onLifecycle: () => {},
    onStatus: value => statuses.push(value), diag: value => diagnostics.push(value) });
  try {
    assert.equal(await g.connect(), false);
    assert.deepEqual(diagnostics, ['listen.frame.failed']);
    assert.ok(!statuses.join(' ').includes('PRIVATE'));
  } finally { g.dispose(); }
});

test('creating the controller is inert: no bridge, hub, poll or microphone before explicit connect/start', async () => {
  let hubs = 0, bridges = 0, mics = 0;
  const fake = bridge();
  const app = createListenApp({ hub: () => { hubs++; return {} as ListenHubPort; },
    bridge: async () => { bridges++; return fake.sdk; }, mic: { on: async () => { mics++; return true; }, off: async () => true } });
  try {
    assert.equal(hubs, 0); assert.equal(bridges, 0); assert.equal(mics, 0);
    assert.equal(app.view().phase, 'idle'); assert.equal(app.view().micOn, false);
  } finally { await app.close(); }
});
