/** Independent renderer review: injected SDK, fake clock, no hub/device calls. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { OsEventTypeList, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { ListenGlasses, safeText } from '../src/glasses.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const frame = { left: '● Listening 00:00\n[00:00] fixture', right: 'MUSE\nNo notes yet' };

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const handlers = new Set<(event: EvenHubEvent) => void>();
  const calls: { kind: string; at: number }[] = [];
  const inputs: string[] = [], lifecycle: string[] = [], diagnostics: string[] = [];
  const mic: boolean[] = [];
  let failStartup = false;
  let heldText: ReturnType<typeof deferred<boolean>> | null = null;
  let heldMic: ReturnType<typeof deferred<boolean>> | null = null;
  let rejectText = false;
  const sdk = {
    onEvenHubEvent(callback: (event: EvenHubEvent) => void) { handlers.add(callback); return () => { handlers.delete(callback); }; },
    async createStartUpPageContainer() {
      calls.push({ kind: 'startup', at: Date.now() });
      if (failStartup) { failStartup = false; throw new Error('fixture failure'); }
      return StartUpPageCreateResult.success;
    },
    async rebuildPageContainer() { calls.push({ kind: 'rebuild', at: Date.now() }); return true; },
    async textContainerUpgrade(value: { containerID: number }) {
      calls.push({ kind: value.containerID === 1 ? 'left' : 'right', at: Date.now() });
      if (heldText) return heldText.promise;
      if (rejectText) { rejectText = false; return false; }
      return true;
    },
    async audioControl(on: boolean) { mic.push(on); return on && heldMic ? heldMic.promise : true; },
  };
  const glasses = new ListenGlasses({ bridge: async () => sdk as unknown as EvenAppBridge,
    onInput: input => { inputs.push(input); }, onAudio: () => {}, onLifecycle: event => { lifecycle.push(event); },
    onStatus: () => {}, diag: name => { diagnostics.push(name); }, now: () => Date.now() });
  glasses.setFrame(frame, 'session:listening');
  t.after(() => { glasses.dispose(); });
  return { glasses, handlers, calls, inputs, lifecycle, diagnostics, mic,
    failNextStartup: () => { failStartup = true; },
    holdText: () => { heldText = deferred<boolean>(); return heldText; },
    holdMic: () => { heldMic = deferred<boolean>(); return heldMic; },
    rejectNextText: () => { rejectText = true; },
    emit: (event: EvenHubEvent) => { for (const handler of [...handlers]) handler(event); },
  };
}

test('independent: reconnect after startup failure keeps one event subscription', async t => {
  const h = harness(t);
  h.failNextStartup();
  assert.equal(await h.glasses.connect(), false);
  const retry = h.glasses.connect();
  await drain(); t.mock.timers.tick(450); await drain();
  assert.equal(await retry, true);
  assert.equal(h.handlers.size, 1);
  h.emit({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
  assert.deepEqual(h.inputs, ['select']);
});

test('independent: known native input source may omit zero click type; unknown events never opt in', async t => {
  const h = harness(t);
  await h.glasses.connect();
  h.emit({ sysEvent: {} } as EvenHubEvent);
  h.emit({ textEvent: {} } as EvenHubEvent);
  h.emit({ listEvent: {} } as EvenHubEvent);
  h.emit({ sysEvent: { eventSource: 999 } } as unknown as EvenHubEvent);
  assert.deepEqual(h.inputs, []);
  // Native simulator capture: the known input source carries the default-zero
  // click with eventType omitted. This is distinct from an empty system event.
  h.emit({ sysEvent: { eventSource: 1 } } as EvenHubEvent);
  assert.deepEqual(h.inputs, ['select']);
  h.emit({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
  assert.deepEqual(h.inputs, ['select', 'select']);
});

test('independent: A-B-A boundary remains a rebuild after an in-flight text write', async t => {
  const h = harness(t);
  await h.glasses.connect();
  const held = h.holdText();
  const next = { ...frame, left: '● Listening 00:01\n[00:00] fixture' };
  h.glasses.setFrame(next, 'session:listening');
  t.mock.timers.tick(450); await drain();
  assert.deepEqual(h.calls.map(call => call.kind), ['startup', 'left']);
  h.glasses.setFrame({ ...next, left: '○ Stopped 00:01' }, 'session:stopped');
  h.glasses.setFrame(next, 'session:listening');
  held.resolve(true); await drain();
  t.mock.timers.tick(450); await drain();
  assert.ok(h.calls.some(call => call.kind === 'rebuild'));
});

test('independent: retry startup observes the same global 450ms pacing', async t => {
  const h = harness(t);
  h.failNextStartup();
  await h.glasses.connect();
  const retry = h.glasses.connect();
  await drain(); t.mock.timers.tick(450); await drain(); await retry;
  const starts = h.calls.filter(call => call.kind === 'startup');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 450);
});

test('independent: changed-box failure logs and retries the latest side without full rebuild', async t => {
  const h = harness(t);
  await h.glasses.connect();
  h.rejectNextText();
  h.glasses.setFrame({ ...frame, right: 'MUSE\n[00:01] useful note' }, 'session:listening');
  t.mock.timers.tick(450); await drain();
  assert.ok(h.diagnostics.includes('listen.frame.failed'));
  t.mock.timers.tick(450); await drain();
  assert.deepEqual(h.calls.map(call => call.kind), ['startup', 'right', 'right']);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 450);
});

test('independent: microphone off is serialized after a late microphone on', async t => {
  const h = harness(t);
  await h.glasses.connect();
  const held = h.holdMic();
  const on = h.glasses.microphone(true);
  await drain();
  const off = h.glasses.microphone(false);
  await drain();
  assert.deepEqual(h.mic, [true]);
  held.resolve(true); await on; await off;
  assert.deepEqual(h.mic, [true, false]);
});

test('independent: touch mapping and lifecycle are explicit; old exit subscriptions are inert', async t => {
  const h = harness(t);
  await h.glasses.connect();
  h.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } } as EvenHubEvent);
  h.emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } } as EvenHubEvent);
  h.emit({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent);
  assert.deepEqual(h.inputs, ['up', 'down', 'back']);
  const old = [...h.handlers][0];
  h.emit({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } } as EvenHubEvent);
  assert.deepEqual(h.lifecycle, ['exit']);
  const reopening = h.glasses.connect();
  await drain(); t.mock.timers.tick(450); await drain(); await reopening;
  old({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent);
  assert.deepEqual(h.inputs, ['up', 'down', 'back']);
});

test('independent: safe text respects UTF8 bytes and UTF16 units without partial graphemes', () => {
  const text = safeText('👨‍👩‍👧‍👦 e\u0301 漢字 '.repeat(300));
  assert.ok(text.length <= 950);
  assert.ok(new TextEncoder().encode(text).length <= 950);
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(text)), text);
  assert.ok(!text.endsWith('\u200d'));
  assert.equal(safeText('\ud800'), ' ');
});
