// Real glasses, 0.4.14: a voice ask on 'muse' got its reply from the hub, but no frame reached the glasses for 57 s until a
// touch. This drives the real Glasses class (fake bridge) and the real queue the way main.ts does: an ask action keeps
// running inside the queue, refreshes and presses are queued meanwhile, and the reply is painted directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StartUpPageCreateResult, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { Glasses } from '../src/glasses';
import { GLASSES_MENU } from '../src/menu';
import { HomeModel, type HomeData } from '../src/model';
import { InputQueue } from '../src/inputqueue';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = { now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: [], muse: true };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function bridge(frames: { at: number; text: string }[], t0: number, renderMs: number, failOnce?: { text: string; done: boolean }) {
  return {
    onEvenHubEvent: () => () => {}, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async (u: { content?: string }) => { await sleep(renderMs); if (failOnce && !failOnce.done && (u.content ?? '').includes(failOnce.text)) { failOnce.done = true; return false; } frames.push({ at: Date.now() - t0, text: u.content ?? '' }); return true; },
    audioControl: async () => true, shutDownPageContainer: async () => true,
  } as unknown as EvenAppBridge;
}

test('a Muse reply painted while the ask action still runs in the queue reaches the glasses within 1 s', async () => {
  const frames: { at: number; text: string }[] = [];
  const t0 = Date.now();
  const model = new HomeModel(); model.update(data); model.goTo('muse');
  const queueRef: { q: InputQueue | null } = { q: null };
  const log: string[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onFrame: w => log.push(`${Date.now() - t0} frame ${model.screenKind} ${w}`),
    bridge: async () => bridge(frames, t0, 150),
  }, GLASSES_MENU);
  await g.connect();
  const paint = () => g.setText(model.render(NOW));
  paint();
  await g.settled(2000);
  // The ask job (stopMic -> askMuse in main.ts): the queue awaits it for at most 3 s; the reply is painted straight from it.
  let replyAt = 0, stopAt = 0;
  const ask = async () => {
    stopAt = Date.now() - t0;
    await sleep(2000);
    model.setMuseAnswer('hello?', 'The reply from Muse');
    replyAt = Date.now() - t0;
    paint();
    await sleep(4000); // the loop goes on after the reply
  };
  const q = new InputQueue({
    apply: input => { if (input === 'select') return ask(); model.input(input, NOW); paint(); },
    menu: () => {}, generation: () => model.generation, foreground: () => true, screen: () => model.screenKind,
    settled: capMs => g.settled(capMs), log: (n, d) => log.push(`${Date.now() - t0} ${n} ${d}`),
  });
  queueRef.q = q;
  q.push('select', 'remote'); // starts the ask job
  // refreshes and presses arrive while it runs
  const timer = setInterval(() => {
    q.pushExternal('terminal', () => { paint(); });
    q.pushExternal('poll', () => { model.update({ ...data, now: NOW + Date.now() }); paint(); });
    q.push('up', 'touch');
  }, 400);
  await sleep(4200);
  clearInterval(timer);
  const shown = frames.find(f => f.text.includes('The reply from Muse'));
  console.log('stop->reply', replyAt - stopAt, 'ms; reply frame at', shown?.at, 'ms (reply painted at', replyAt, ')\n' + log.join('\n'));
  assert.ok(shown, 'the reply reached the glasses');
  assert.ok(shown!.at - replyAt <= 1000, `reply shown ${shown!.at - replyAt} ms after it was painted`);
  g.dispose();
});

test('a failed update at the moment of the reply is retried by itself: the reply appears without another paint or a touch', async () => {
  const frames: { at: number; text: string }[] = [];
  const t0 = Date.now();
  const model = new HomeModel(); model.update(data); model.goTo('muse');
  const log: string[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: s => log.push(`${Date.now() - t0} status ${s}`), onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onLifecycle: e => log.push(`${Date.now() - t0} lifecycle ${e}`),
    bridge: async () => bridge(frames, t0, 50, { text: 'The reply from Muse', done: false }),
  }, GLASSES_MENU);
  await g.connect();
  g.setText(model.render(NOW));
  await g.settled(2000);
  model.setMuseAnswer('hello?', 'The reply from Muse');
  const paintedAt = Date.now() - t0;
  g.setText(model.render(NOW)); // the one and only paint of the reply
  await sleep(3000);
  const shown = frames.find(f => f.text.includes('The reply from Muse'));
  console.log(log.join('\n'), '\nreply painted', paintedAt, 'shown', shown?.at);
  assert.ok(shown, 'the reply reached the glasses');
  assert.ok(shown!.at - paintedAt <= 2500, `shown ${shown!.at - paintedAt} ms later`);
  g.dispose();
});

/** A bridge whose text writes the test controls: each call is recorded, and `reply` decides how it ends. */
function controlled(calls: { text: string; at: number }[], t0: number, reply: (text: string) => Promise<boolean>, events?: { handler?: (e: unknown) => void }) {
  return {
    onEvenHubEvent: (h: (e: unknown) => void) => { if (events) events.handler = h; return () => {}; }, onDeviceStatusChanged: () => () => {},
    getDeviceInfo: async () => ({ status: { batteryLevel: 80, isWearing: true } }),
    createStartUpPageContainer: async (c: { textObject?: { content?: string }[] }) => { const text = c.textObject?.[0]?.content; if (events && text !== undefined) calls.push({ text, at: Date.now() - t0 }); return StartUpPageCreateResult.success; },
    // a rebuild carries the whole page: its text container's content is what the glasses show
    rebuildPageContainer: async (c: { textObject?: { content?: string }[] }) => { const text = c.textObject?.[0]?.content; if (text !== undefined) calls.push({ text, at: Date.now() - t0 }); return true; },
    textContainerUpgrade: (u: { content?: string }) => { calls.push({ text: u.content ?? '', at: Date.now() - t0 }); return reply(u.content ?? ''); },
    audioControl: async () => true, shutDownPageContainer: async () => true,
  } as unknown as EvenAppBridge;
}

test('a failed update is not hammered: repainting the same text (the status callback does) waits for the 1.5 s retry', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  const ref: { g?: Glasses } = {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onStatus: s => { if (/failed/.test(s)) ref.g?.setText('the reply'); }, // main.ts: onStatus paints
    bridge: async () => controlled(calls, t0, async () => false),
  }, GLASSES_MENU);
  ref.g = g;
  await g.connect();
  g.setText('the reply');
  await sleep(1300);
  assert.equal(calls.filter(c => c.text === 'the reply').length, 1, JSON.stringify(calls));
  await sleep(1000); // past the retry
  assert.equal(calls.filter(c => c.text === 'the reply').length, 2, JSON.stringify(calls));
  g.setText('another text'); // a different frame may try at once
  await sleep(700);
  assert.ok(calls.some(c => c.text === 'another text'));
  g.dispose();
});

test('a timed-out write that lands late cannot leave stale text: nothing is sent while it is in flight, then the newest goes out', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  let releaseOld: (ok: boolean) => void = () => {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    renderTimeoutMs: 100,
    bridge: async () => controlled(calls, t0, text => (text === 'old text' ? new Promise<boolean>(r => { releaseOld = r; }) : Promise.resolve(true))),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('old text');
  await sleep(250); // the write timed out
  g.setText('newest text');
  await sleep(2000); // longer than the retry: still nothing sent over the old write
  assert.deepEqual(calls.map(c => c.text), ['old text'], 'nothing is sent while the old write is in flight');
  releaseOld(true); // the old write lands late
  await sleep(1200);
  assert.deepEqual(calls.map(c => c.text), ['old text', 'newest text'], 'the newest text is sent after it, so it is the last word');
  g.dispose();
});

test('a timed-out write that lands late after the wanted text went back to the shown one: the glasses are sent it again', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  let releaseOld: (ok: boolean) => void = () => {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    renderTimeoutMs: 100,
    bridge: async () => controlled(calls, t0, text => (text === 'B' ? new Promise<boolean>(r => { releaseOld = r; }) : Promise.resolve(true))),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('A');
  await sleep(700);
  g.setText('B');
  await sleep(250); // timed out
  g.setText('A'); // back to what is shown as far as the app knows
  releaseOld(true);
  await sleep(1500);
  const texts = calls.map(c => c.text);
  assert.equal(texts.at(-1), 'A', texts.join(','));
  assert.equal(texts.filter(t => t === 'A').length, 2, 'A is sent again after the late B: ' + texts.join(','));
  g.dispose();
});

test('a write that never settles is given up after the hard limit: the newest frame is sent as a rebuild and the log says so', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  const lifecycle: string[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    onLifecycle: e => lifecycle.push(e),
    renderTimeoutMs: 100, hungWriteMs: 500,
    bridge: async () => controlled(calls, t0, text => (text === 'hung text' ? new Promise<boolean>(() => {}) : Promise.resolve(true))),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('hung text');
  await sleep(250);
  g.setText('newest text');
  await sleep(300);
  assert.ok(!calls.some(c => c.text === 'newest text'), 'held while the write may still land');
  await sleep(900); // past the hard limit (and the 1.5 s retry is not needed: the limit sends it)
  assert.ok(calls.some(c => c.text === 'newest text'), calls.map(c => c.text).join(','));
  assert.ok(lifecycle.includes('frame held: write hung, resent'), lifecycle.join('|'));
  g.dispose();
});

test('a reconnect forgets a hung write: the newest frame goes out with the new page, nothing stays frozen', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  const events: { handler?: (e: unknown) => void } = {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    renderTimeoutMs: 100, hungWriteMs: 60_000,
    bridge: async () => controlled(calls, t0, text => (text === 'hung text' ? new Promise<boolean>(() => {}) : Promise.resolve(true)), events),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('hung text');
  await sleep(250);
  g.setText('newest text');
  events.handler?.({ sysEvent: { eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT } });
  assert.equal(await g.connect(), true);
  await sleep(200);
  assert.equal(calls.at(-1)?.text, 'newest text', calls.map(c => c.text).join(','));
  g.setText('after reconnect');
  assert.equal(await g.settled(2000), 'rendered');
  assert.equal(calls.at(-1)?.text, 'after reconnect');
  g.dispose();
});

test('settled() does not say rendered while a write is still in flight', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  let release: (ok: boolean) => void = () => {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    renderTimeoutMs: 100, hungWriteMs: 60_000,
    bridge: async () => controlled(calls, t0, text => (text === 'slow text' ? new Promise<boolean>(r => { release = r; }) : Promise.resolve(true))),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('base');
  assert.equal(await g.settled(2000), 'rendered');
  g.setText('slow text');
  await sleep(1800); // timed out and past the 1.5 s retry: the glasses may be tried again, but the write is still out there
  g.setText('base'); // wanted == shown as far as the app knows, yet the slow write may still land
  assert.equal(await g.settled(300), 'capped');
  release(true);
  await sleep(100);
  assert.equal(await g.settled(2000), 'rendered');
  g.dispose();
});
