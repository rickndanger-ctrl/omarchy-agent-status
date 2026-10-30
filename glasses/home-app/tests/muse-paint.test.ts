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
import { ShownWatch } from '../src/shownwatch';

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

test('a forgotten (hung) write that lands later may have overwritten the resent frame: the newest is sent once more', async () => {
  const calls: { text: string; at: number }[] = [];
  const t0 = Date.now();
  const lifecycle: string[] = [];
  let landLate: (ok: boolean) => void = () => {};
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {}, onStatus: () => {},
    onLifecycle: e => lifecycle.push(e),
    renderTimeoutMs: 100, hungWriteMs: 400,
    bridge: async () => controlled(calls, t0, text => (text === 'hung text' ? new Promise<boolean>(r => { landLate = r; }) : Promise.resolve(true))),
  }, GLASSES_MENU);
  await g.connect();
  g.setText('hung text');
  await sleep(150);
  g.setText('newest text');
  await sleep(900); // the hard limit passed: the hung write was forgotten and the newest sent
  const before = calls.filter(c => c.text === 'newest text').length;
  assert.equal(before, 1, calls.map(c => c.text).join(','));
  landLate(true); // ... and now the old write lands, possibly over it
  await sleep(1000);
  assert.equal(calls.filter(c => c.text === 'newest text').length, 2, calls.map(c => c.text).join(','));
  assert.equal(calls.at(-1)?.text, 'newest text');
  assert.ok(lifecycle.includes('frame held: late write, resent'), lifecycle.join('|'));
  g.dispose();
});

test('the final Muse reply is drawn within 0.5 s of done even with a 150 ms render, partial replies in flight, refreshes and presses queued; onDrawn reports it', async () => {
  const frames: { at: number; text: string }[] = [];
  const t0 = Date.now();
  const model = new HomeModel(); model.update(data); model.goTo('muse');
  const drawn: { at: number; text: string }[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onDrawn: text => drawn.push({ at: Date.now() - t0, text }),
    bridge: async () => bridge(frames, t0, 150),
  }, GLASSES_MENU);
  await g.connect();
  const paint = (urgent = false) => g.setText(model.render(NOW), urgent);
  paint();
  await g.settled(2000);
  // Muse typing: a partial every 700 ms, drawn only when the glasses are idle (as main.ts does), plus refresh-style repaints.
  const partials = ['Yes, I can', 'Yes, I can hear you. The connection', 'Yes, I can hear you. The connection looks good'];
  for (const p of partials) {
    await sleep(700);
    model.setMuseAnswer('hear me?', p);
    if (!g.busy()) paint();
    paint(); // a refresh while a write may be in flight: only the newest text is ever sent
  }
  await sleep(60); // done arrives right after a partial was written (inside the 450 ms pacing window)
  const final = 'Yes, I can hear you. The connection looks good and everything is coming through fine.';
  model.setMuseAnswer('hear me?', final);
  const doneAt = Date.now() - t0;
  paint(true); // main.ts: the final reply is urgent
  await g.settled(2000);
  const last = drawn.filter(d => d.text.includes('coming through fine')).at(0);
  assert.ok(last, `the final reply was drawn (${JSON.stringify(drawn.map(d => d.at))})`);
  assert.ok(last!.at - doneAt <= 500, `drawn ${last!.at - doneAt} ms after done`);
  assert.equal(g.upToDate(), true);
  g.dispose();
});

function drawRig(renderMs = 150) {
  const t0 = Date.now();
  const drawn: { at: number; text: string }[] = [];
  const watch = new ShownWatch();
  const shown: number[] = [];
  const g = new Glasses({
    onInput: () => {}, onMenu: () => {}, onStatus: () => {}, onForeground: () => {}, onDevice: () => {}, onAudio: () => {},
    onDrawn: text => { drawn.push({ at: Date.now() - t0, text }); const ms = watch.drawn(text, Date.now()); if (ms !== null) shown.push(Date.now() - t0); },
    bridge: async () => bridge([], t0, renderMs),
  }, GLASSES_MENU);
  return { g, drawn, watch, shown, t0 };
}

test('an urgent final frame preempts the 450 ms timer a partial paint scheduled: drawn without the pacing wait', async () => {
  const { g, drawn, t0 } = drawRig(150);
  try {
    await g.connect();
    g.setText('Yes, I can');
    await g.settled(2000);
    g.setText('Yes, I can hear'); // a partial right after a write: the 450 ms timer is scheduled
    await sleep(20);
    const askedAt = Date.now() - t0;
    g.setText('Yes, I can hear you. All good.', true);
    await g.settled(2000);
    const final = drawn.find(d => d.text.includes('All good'));
    assert.ok(final);
    assert.ok(final!.at - askedAt < 350, `drawn ${final!.at - askedAt} ms after the urgent paint (the timer would have cost 450 ms)`);
  } finally { g.dispose(); }
});

test('muse.shown only for the exact final frame: a partial with the same start does not count, and an older write in flight is not "up to date"', async () => {
  const { g, drawn, watch, shown } = drawRig(150);
  try {
    await g.connect();
    const partial = 'Muse: Yes, I can hear';
    const final = 'Muse: Yes, I can hear you. The connection looks good.';
    g.setText(partial);
    await g.settled(2000);
    assert.ok(drawn.some(d => d.text === partial));
    assert.equal(shown.length, 0);
    // a write for another partial is in flight when the final is asked for
    g.setText('Muse: Yes, I can hear you.');
    await sleep(350); // that write has started (pacing 450 ms from the last write, 150 ms render)
    assert.equal(g.busy(), true, 'a write is in flight');
    g.setText(final, true);
    watch.expect(g.wantedText()!, Date.now());
    assert.equal(g.upToDate(), false, 'not up to date while an older write is in flight');
    await g.settled(2000);
    assert.equal(shown.length, 1, 'reported once, after the final frame');
    assert.equal(drawn.at(-1)!.text, final);
    assert.equal(g.upToDate(), true);
  } finally { g.dispose(); }
});

test('ShownWatch: only the exact expected text, once', () => {
  const w = new ShownWatch();
  assert.equal(w.drawn('x', 5), null);
  w.expect('Muse: Yes, I can hear you', 100);
  assert.equal(w.drawn('Muse: Yes, I can hear', 150), null);
  assert.equal(w.drawn('Muse: Yes, I can hear you', 400), 300);
  assert.equal(w.drawn('Muse: Yes, I can hear you', 500), null);
});

test('ShownWatch.expectOnScreen: not armed when Muse is not the painted screen (muse.shown is never logged for another screen)', () => {
  const w = new ShownWatch();
  assert.equal(w.expectOnScreen(false, 'Home text', 100), false);
  assert.equal(w.drawn('Home text', 300), null, 'a frame of the other screen is not "the Muse reply"');
  assert.equal(w.expectOnScreen(true, null, 100), false, 'tiles or no single frame: nothing to wait for');
  assert.equal(w.expectOnScreen(true, 'Muse: hi', 100), true);
  assert.equal(w.drawn('Muse: hi', 250), 150);
});

test('a long question + reply: the answer\'s first line is in the first drawn frame, and muse.shown fires only for that frame; scrolled past the answer top it is not armed', async () => {
  const { g, drawn, watch, shown } = drawRig(150);
  const model = new HomeModel(); model.update(data); model.goTo('muse');
  try {
    await g.connect();
    g.setText(model.render(NOW));
    await g.settled(2000);
    const q = 'a very long question about everything '.repeat(6);
    model.setMuseAnswer(q, 'The reply begins right here.\nAnd carries on for a bit.');
    g.setText(model.render(NOW), true);
    assert.equal(watch.expectOnScreen(model.museAnswerInView(), g.wantedText(), Date.now()), true);
    assert.equal(shown.length, 0);
    await g.settled(2000);
    assert.equal(shown.length, 1);
    const first = drawn.at(-1)!.text;
    assert.match(first, /Muse: The reply begins right here\./);
    assert.ok(first.split('\n').slice(0, 4).join('\n').includes('Muse: The reply'), 'within the first lines');
    // the owner scrolled the answer's top away: the frame would not show it, so nothing is armed
    for (let i = 0; i < 2; i++) model.input('down', NOW);
    model.setMuseAnswer(q, 'x\n'.repeat(30));
    model.input('down', NOW); model.input('down', NOW); model.input('down', NOW);
    assert.equal(model.museAnswerInView(), false);
    assert.equal(watch.expectOnScreen(model.museAnswerInView(), 'whatever', Date.now()), false);
  } finally { g.dispose(); }
});

// ---- muse-layout review: loadMuse out of date, scrollback kept, conversation asks, gave up ----
import { MuseCache, MUSE_UNREACHABLE } from '../src/musecache';
import { pollMuseJob } from '../src/musepoll';

test('a /muse read that began before an ask started or ended is out of date (MuseCache.isCurrent), like the tile', () => {
  const c = new MuseCache();
  const stamp = c.fetchStart();
  assert.equal(c.isCurrent(stamp), true);
  c.askStart('q');
  assert.equal(c.isCurrent(stamp), false, 'an ask began during the read');
  assert.equal(c.fetchStart(), null, 'no read while an ask is in flight');
  assert.equal(c.isCurrent(null), false);
  c.askEnd();
  assert.equal(c.isCurrent(stamp), false, 'and it ended since: still stale');
  assert.equal(c.isCurrent(c.fetchStart()), true);
});

test('the Muse screen reopened mid-ask shows the ask in progress; reopening keeps the scrollback of earlier answers; a conversation-sourced ask archives the old head', () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  m.setMuse({ question: 'old q', reply: 'old answer' });
  const a = m.beginMuseAsk('conversation summary question'); // what main does for an ask that did not come from this screen
  assert.equal(m.museIsNewest(a), true);
  m.goTo('muse'); // reopened: museLines cleared, nothing is fetched while the ask is in flight
  m.restoreMuse();
  const thinking = m.render(NOW);
  assert.match(thinking, /conversation summary question/);
  assert.match(thinking, /Muse is thinking…/);
  m.setMuseAnswer('conversation summary question', 'new answer', a);
  for (let i = 0; i < 2; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /earlier|old answer/, 'the previous answer was archived below');
  // reopen: the relay's latest replaces the head, the earlier answers stay
  m.goTo('muse');
  m.setMuse({ question: 'conversation summary question', reply: 'new answer' });
  for (let i = 0; i < 3; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /old answer/, 'scrollback survives a reload');
});

test('every poll failing (or never finishing) ends in "Muse took too long", not in "Muse is thinking…"', async () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  const ask = m.beginMuseAsk('will you answer?');
  let waits = 0;
  const finished = await pollMuseJob(async () => null, async () => { waits++; }, () => assert.fail('no job ever arrived'), 215);
  assert.equal(finished, false);
  assert.equal(waits, 215);
  // what main.ts does with `false`
  assert.equal(m.setMuseProblem('will you answer?', 'Muse took too long', ask), true);
  const text = m.render(NOW);
  assert.match(text, /Muse didn't get it: Muse took too long/);
  assert.doesNotMatch(text, /Muse is thinking/);
  const done = await pollMuseJob(async () => ({ status: 'done', question: 'q', reply: 'r' }), async () => {}, () => {}, 5);
  assert.equal(done, true);
  const never = await pollMuseJob(async () => ({ status: 'sending', question: 'q', reply: '' }), async () => {}, () => {}, 4);
  assert.equal(never, false);
});

test('ask 2 finishes, then older ask 1 finishes: reopening Muse (relay /latest = ask 1) never replaces ask 2; a fresh start is filled; unknown latest goes below', () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  const a1 = m.beginMuseAsk('first question');
  const a2 = m.beginMuseAsk('second question');
  assert.equal(m.setMuseAnswer('second question', 'ANSWER TWO', a2), true);
  assert.equal(m.setMuseAnswer('first question', 'ANSWER ONE', a1), false);
  m.goTo('muse'); // reopened: the relay's latest is ask 1
  assert.equal(m.setMuse({ question: 'first question', reply: 'ANSWER ONE' }), false, 'did not take the screen (nor the tile)');
  const text = m.render(NOW);
  assert.match(text, /You: second question/);
  assert.match(text, /Muse: ANSWER TWO/);
  assert.equal(m.render(NOW).match(/ANSWER ONE/g)?.length ?? 0, 1, 'known answer not added twice') ;
  // something the session has not seen is added below
  assert.equal(m.setMuse({ question: 'asked on the desk', reply: 'DESK ANSWER' }), false);
  for (let i = 0; i < 4; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /DESK ANSWER|ANSWER ONE/);
  // a fresh start (no ask this session) is filled from /latest
  const fresh = new HomeModel(); fresh.update(data); fresh.goTo('muse');
  assert.equal(fresh.setMuse({ question: 'q', reply: 'FROM RELAY' }), true);
  assert.match(fresh.render(NOW), /Muse: FROM RELAY/);
  assert.equal(fresh.setMuse(null), true);
});

test('pollMuseJob gives up by the wall clock (150 s from the ask), not by the poll count: slow reads end it early', async () => {
  let t = 0;
  let reads = 0;
  const finished = await pollMuseJob(
    async () => { reads++; t += 8000; return { status: 'sending', question: 'q', reply: '' }; }, // each read takes 8 s
    async () => { t += 700; },
    () => {}, 215, { at: 150_000, now: () => t },
  );
  assert.equal(finished, false);
  assert.ok(t >= 150_000 && t < 150_000 + 9000, `stopped at ${t} ms`);
  assert.ok(reads < 20, `${reads} reads, not 215`);
  // a final answer that arrives with the last read still counts
  t = 149_000;
  assert.equal(await pollMuseJob(async () => { t += 2000; return { status: 'done', question: 'q', reply: 'r' }; }, async () => {}, () => {}, 215, { at: 150_000, now: () => t }), true);
});

import { applyMuseLatest } from '../src/musesync';

test('tile and screen share the /latest rule: ask 2 final, ask 1 read via /latest (tile refresh or loadMuse) -> both keep ask 2', () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  const tile = new MuseCache();
  const a1 = m.beginMuseAsk('first question');
  const a2 = m.beginMuseAsk('second question');
  tile.askStart('second question');
  m.setMuseAnswer('second question', 'ANSWER TWO', a2);
  tile.askReply('second question', 'ANSWER TWO');
  m.setMuseAnswer('first question', 'ANSWER ONE', a1); // the older ask finishes later: below the newest, never the tile
  tile.askEnd();
  // the tile's own timed read: /latest is ask 1
  const stamp = tile.fetchStart();
  assert.equal(applyMuseLatest(m, tile, stamp, { question: 'first question', reply: 'ANSWER ONE' }, tile.startRead()), false);
  assert.deepEqual(tile.get(), { question: 'second question', reply: 'ANSWER TWO' }, 'the tile keeps ask 2');
  assert.match(m.render(NOW), /Muse: ANSWER TWO/, 'and so does the screen');
  // loadMuse goes through the same helper
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'first question', reply: 'ANSWER ONE' }, tile.startRead()), false);
  assert.deepEqual(tile.get(), { question: 'second question', reply: 'ANSWER TWO' });
  // a read that began before an ask is dropped (stale stamp)
  const old = tile.fetchStart();
  tile.askStart('third'); tile.askEnd();
  assert.equal(applyMuseLatest(m, tile, old, { question: 'x', reply: 'y' }, tile.startRead()), false);
  // a fresh session (no ask) takes /latest on screen and tile
  const fm = new HomeModel(); fm.update(data); fm.goTo('muse');
  const ft = new MuseCache();
  assert.equal(applyMuseLatest(fm, ft, ft.fetchStart(), { question: 'q', reply: 'FROM RELAY' }, ft.startRead()), true);
  assert.deepEqual(ft.get(), { question: 'q', reply: 'FROM RELAY' });
  assert.match(fm.render(NOW), /Muse: FROM RELAY/);
  // a failed read on a session with nothing to show marks the tile unreachable; with an answer it changes nothing
  assert.equal(applyMuseLatest(fm, ft, ft.fetchStart(), null, ft.startRead()), false);
  assert.deepEqual(ft.get(), { question: 'q', reply: 'FROM RELAY' });
  const em = new HomeModel(); em.update(data); em.goTo('muse');
  const et = new MuseCache();
  assert.equal(applyMuseLatest(em, et, et.fetchStart(), null, et.startRead()), true);
  assert.equal(et.get(), MUSE_UNREACHABLE);
});

test('two /latest reads sharing a stamp: the newer finishes first, the older one finishing later changes nothing (screen and tile)', () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  const tile = new MuseCache();
  const stamp = tile.fetchStart();
  const tileRead = tile.startRead(); // the tile's read starts first (older relay answer is on its way)
  const screenRead = tile.startRead(); // the screen's load starts later and returns the newer answer
  assert.equal(applyMuseLatest(m, tile, stamp, { question: 'q', reply: 'NEWER' }, screenRead), true);
  assert.equal(applyMuseLatest(m, tile, stamp, { question: 'q', reply: 'OLDER' }, tileRead), false);
  assert.deepEqual(tile.get(), { question: 'q', reply: 'NEWER' });
  assert.match(m.render(NOW), /Muse: NEWER/);
  assert.doesNotMatch(m.render(NOW), /OLDER/);
  // a read that started later and finishes later still applies
  assert.equal(applyMuseLatest(m, tile, stamp, { question: 'q', reply: 'NEWEST' }, tile.startRead()), true);
  assert.match(m.render(NOW), /Muse: NEWEST/);
});

test('a failed /latest read never advances the order and never replaces an answer; the unreachable note is only for nothing to show', () => {
  const m = new HomeModel(); m.update(data); m.goTo('muse');
  const tile = new MuseCache();
  const stamp = tile.fetchStart();
  const older = tile.startRead();
  const newer = tile.startRead();
  // the newer read fails first, then the older one succeeds: its answer is shown
  assert.equal(applyMuseLatest(m, tile, stamp, null, newer), true, 'nothing to show yet: the unreachable note');
  assert.match(m.render(NOW), /Couldn't reach Muse/);
  assert.equal(applyMuseLatest(m, tile, stamp, { question: 'q', reply: 'THE ANSWER' }, older), true, 'the older success is not dropped by the failure');
  assert.match(m.render(NOW), /Muse: THE ANSWER/);
  assert.deepEqual(tile.get(), { question: 'q', reply: 'THE ANSWER' });
  // a failure with an answer on screen and tile: both stay
  assert.equal(applyMuseLatest(m, tile, stamp, null, tile.startRead()), false);
  assert.match(m.render(NOW), /Muse: THE ANSWER/);
  assert.doesNotMatch(m.render(NOW), /Couldn't reach/);
  assert.deepEqual(tile.get(), { question: 'q', reply: 'THE ANSWER' });
});
