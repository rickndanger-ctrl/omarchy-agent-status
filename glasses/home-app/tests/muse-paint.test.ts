// Real glasses, 0.4.14: a voice ask on 'muse' got its reply from the hub, but no frame reached the glasses for 57 s until a
// touch. This drives the real Glasses class (fake bridge) and the real queue the way main.ts does: an ask action keeps
// running inside the queue, refreshes and presses are queued meanwhile, and the reply is painted directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StartUpPageCreateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
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
