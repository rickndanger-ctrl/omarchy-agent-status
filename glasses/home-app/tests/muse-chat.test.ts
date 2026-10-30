// The Muse screen is a clean chat of this session; the tile shows the same chat; the relay's /latest only seeds an empty session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData } from '../src/model';
import { widgetFor } from '../src/tiles';
import { MuseCache } from '../src/musecache';
import { applyMuseLatest } from '../src/musesync';
import { makeHandle, type FlowHost } from '../src/inputflow';
import { firstAnswer } from '../src/hubpick';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = { now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: [], muse: true, voice: true };
const open = () => { const m = new HomeModel(); m.update(data); m.goTo('muse'); return m; };
const screen = (m: HomeModel) => m.render(NOW).split('\n');
const longQ = 'a long question about everything '.repeat(7);
const reply = (n: number, extra = 0) => `Reply ${n} starts here.` + '\nmore words in this reply'.repeat(extra);

test('3 back-and-forths = 6 turns in order; after every reply the newest reply is in the first frame; the question is one line', () => {
  const m = open();
  const t = NOW;
  for (let i = 1; i <= 3; i++) {
    const ask = m.beginMuseAsk(i === 1 ? longQ : `Question ${i}`, t + i * 1000);
    assert.match(screen(m).join('\n'), /Muse is thinking…/);
    m.setMuseAnswer('q', reply(i, i === 3 ? 12 : 1), ask);
    const rows = screen(m);
    assert.ok(rows.length <= 10, `${rows.length} lines`);
    assert.ok(rows.some(l => l.startsWith(`Muse: Reply ${i} starts here.`)), `reply ${i} is on screen:\n${rows.join('\n')}`);
    for (const l of rows) assert.ok(l.length <= 56, l);
  }
  const youLines = screen(m).filter(l => l.startsWith('You: '));
  assert.ok(youLines.every(l => l.length <= 56));
  // scroll up through the whole chat: You/Muse alternate, six turns
  for (let i = 0; i < 10; i++) m.input('up', NOW);
  const all: string[] = [];
  for (let i = 0; i < 10; i++) { all.push(...screen(m)); m.input('down', NOW); }
  const turns = [...new Set(all.filter(l => /^(You|Muse): /.test(l)))];
  assert.equal(turns.filter(l => l.startsWith('You: ')).length, 3);
  assert.equal(turns.filter(l => l.startsWith('Muse: ')).length, 3);
  assert.doesNotMatch(all.join('\n'), /earlier|──/, 'no lists, no history rules');
});

test('the question is clipped to ONE line with an ellipsis, the reply starts right under it', () => {
  const m = open();
  const ask = m.beginMuseAsk(longQ, NOW);
  m.setMuseAnswer('q', 'The answer.', ask);
  const rows = screen(m);
  const i = rows.findIndex(l => l.startsWith('You: '));
  assert.ok(rows[i].endsWith('…') && rows[i].length <= 56);
  assert.equal(rows[i + 1], 'Muse: The answer.');
});

test('the tile shows every reply of the session: the latest "Muse: …" under one line of the question', () => {
  const m = open();
  const cache = new MuseCache();
  const ctx = () => ({ data, now: NOW, terminal: () => null, chat: () => null, muse: () => m.museTileView() ?? cache.get(), museWaiting: () => m.museTileView()?.waiting ?? false, reminders: () => [], url: () => null }) as never;
  const w = widgetFor('muse');
  for (let i = 1; i <= 3; i++) {
    const ask = m.beginMuseAsk(`Question ${i}`, NOW + i);
    assert.deepEqual(w.body(ctx(), 27), [`You: Question ${i}`, 'Muse: Muse is thinking…']);
    m.setMuseAnswer('q', `Answer number ${i}`, ask);
    assert.deepEqual(w.body(ctx(), 27), [`You: Question ${i}`, `Muse: Answer number ${i}`], `reply ${i} is on the tile`);
  }
  // an older ask answering late fills its own turn in the chat; the tile keeps the latest exchange
  const a4 = m.beginMuseAsk('Question 4', NOW + 10);
  const a5 = m.beginMuseAsk('Question 5', NOW + 11);
  m.setMuseAnswer('q', 'Answer five', a5);
  m.setMuseAnswer('q', 'Answer four (late)', a4);
  assert.deepEqual(w.body(ctx(), 27), ['You: Question 5', 'Muse: Answer five']);
  assert.match(screen(m).join('\n') + (m.input('up', NOW), screen(m).join('\n')), /Answer four \(late\)/);
});

test('waiting and problem turns are in the chat and on the tile; the relay never adds lists', () => {
  const m = open();
  const ask = m.beginMuseAsk('Will you answer?', NOW);
  m.setMuseWaiting(ask, true);
  assert.match(screen(m).join('\n'), /Muse: Muse is busy, waiting…/);
  assert.equal(m.museTileView()?.waiting, true);
  m.setMuseWaiting(ask, false);
  m.setMuseProblem('q', 'Muse is updating or busy', ask);
  assert.match(screen(m).join(' '), /Muse didn't get it: Muse is updating or busy\./);
});

test('30 minutes without Muse = the next ask starts a fresh chat; sooner keeps the chat', () => {
  const m = open();
  const a1 = m.beginMuseAsk('Old question', NOW);
  m.setMuseAnswer('q', 'Old answer', a1);
  m.beginMuseAsk('Soon after', NOW + 29 * 60_000);
  assert.match(screen(m).join('\n') + (m.input('up', NOW), m.input('up', NOW), screen(m).join('\n')), /Old question/);
  const fresh = open();
  const b1 = fresh.beginMuseAsk('Old question', NOW);
  fresh.setMuseAnswer('q', 'Old answer', b1);
  // the answer arrives (activity) at about NOW; 31 minutes later the next ask is a new session
  fresh.beginMuseAsk('New session question', Date.now() + 31 * 60_000);
  const text = screen(fresh).join('\n');
  assert.match(text, /You: New session question/);
  assert.doesNotMatch(text, /Old question|Old answer/);
});

test('the relay /latest only SEEDS an empty session: its one exchange; once a chat exists it changes nothing (screen and tile)', () => {
  const m = open();
  const tile = new MuseCache();
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'from before', reply: 'seeded answer' }, tile.startRead()), true);
  assert.match(screen(m).join('\n'), /You: from before/);
  assert.match(screen(m).join('\n'), /Muse: seeded answer/);
  assert.deepEqual(tile.get(), { question: 'from before', reply: 'seeded answer' });
  const ask = m.beginMuseAsk('My own question', NOW + 1);
  m.setMuseAnswer('q', 'my own answer', ask);
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'someone else', reply: 'their answer' }, tile.startRead()), false);
  assert.doesNotMatch(screen(m).join('\n'), /someone else|their answer/);
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), null, tile.startRead()), false, 'a failed read does not touch a chat either');
  // an empty session with a failed read: the plain note; a question still waiting for its reply is a thinking turn
  const e = open(); const t2 = new MuseCache();
  applyMuseLatest(e, t2, t2.fetchStart(), null, t2.startRead());
  assert.match(screen(e).join('\n'), /Couldn't reach Muse\./);
  const p = open(); const t3 = new MuseCache();
  applyMuseLatest(p, t3, t3.fetchStart(), { question: 'asked elsewhere', reply: '' }, t3.startRead());
  assert.match(screen(p).join('\n'), /You: asked elsewhere/);
  assert.match(screen(p).join('\n'), /asked on another device/);
});

test('Remote on the Muse chat: a quick Back after a Down while there is more below keeps scrolling; at the end it goes back', async () => {
  const m = open();
  const ask = m.beginMuseAsk('Long one', NOW);
  m.setMuseAnswer('q', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), ask);
  m.input('up', NOW); m.input('up', NOW); m.input('up', NOW); m.input('up', NOW); // to the top
  let now = NOW; let backToTiles = 0;
  const host = {
    model: m, tiles: {}, tileCtx: () => ({}), showingTiles: () => false, inOpenedScreen: () => true, leaveTiles: () => {}, backToTiles: () => { backToTiles++; },
    paint: () => {}, isBlank: () => false, wake: () => {}, runTileEffect: () => {}, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => now, runModelAction: () => {},
  } as unknown as FlowHost;
  const handle = makeHandle(host);
  const before = screen(m).join('\n');
  await handle('down', 'remote');
  now += 220; // the 17:42:06 case: a Back 220 ms after a Down
  await handle('back', 'remote');
  assert.equal(backToTiles, 0, 'not kicked to Tiles mid-scroll');
  assert.notEqual(screen(m).join('\n'), before, 'it scrolled on');
  // scroll to the end, then a quick Back goes back
  for (let i = 0; i < 12; i++) { now += 1500; await handle('down', 'remote'); }
  now += 220;
  await handle('back', 'remote');
  assert.equal(backToTiles, 1, 'at the end the same Back leaves');
  // a Back with no Down just before is always a Back
  now += 5000; backToTiles = 0;
  m.input('up', now);
  await handle('back', 'remote');
  assert.equal(backToTiles, 1);
});

test('two overlapping requests each carry the hub that answered THEM (no shared "last hub")', async () => {
  const gate: Record<string, () => void> = {};
  const attempt = (hub: string) => new Promise<{ value: string }>(res => { gate[hub] = () => res({ value: `body of ${hub}` }); });
  const p1 = firstAnswer<string>(['hub-a'], attempt);
  const p2 = firstAnswer<string>(['hub-b'], attempt);
  gate['hub-b'](); // the second request finishes first
  gate['hub-a']();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, { hub: 'hub-a', value: 'body of hub-a' });
  assert.deepEqual(r2, { hub: 'hub-b', value: 'body of hub-b' });
  // a failing first hub: the answer names the second
  const r3 = await firstAnswer<string>(['down', 'up'], async hub => (hub === 'down' ? { skip: new Error('down') } : { value: 'ok' }));
  assert.equal(r3.hub, 'up');
  await assert.rejects(firstAnswer<string>(['x'], async () => ({ skip: new Error('nope') })), /no hub reachable/);
});

test('review (1): a question seeded as "thinking" by /latest is completed by a later /latest with the same question + a reply, and only that', () => {
  const m = open(); const tile = new MuseCache();
  applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: '' }, tile.startRead());
  assert.match(screen(m).join('\n'), /asked on another device/);
  // a different question or an empty reply does not complete it
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'something else', reply: 'WRONG' }, tile.startRead()), false);
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: '' }, tile.startRead()), false);
  assert.doesNotMatch(screen(m).join('\n'), /WRONG/);
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: 'The real answer.' }, tile.startRead()), true);
  assert.match(screen(m).join('\n'), /Muse: The real answer\./);
  assert.doesNotMatch(screen(m).join('\n'), /thinking|another device/);
  assert.deepEqual(tile.get(), { question: 'asked elsewhere', reply: 'The real answer.' });
  // once completed (or after our own ask) later reads change nothing
  assert.equal(applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: 'A different later text' }, tile.startRead()), false);
  // our own thinking turn is never completed by /latest
  const own = open(); const t2 = new MuseCache();
  own.beginMuseAsk('my question', NOW);
  assert.equal(applyMuseLatest(own, t2, t2.fetchStart(), { question: 'my question', reply: 'relay text' }, t2.startRead()), false);
});

test('review (2): opening Muse scrolls to the newest reply; a late answer to an older ask never moves the scroll', () => {
  const m = new HomeModel(); m.update(data);
  const a1 = m.beginMuseAsk('First', NOW);
  m.setMuseAnswer('q', Array.from({ length: 10 }, (_, i) => `first line ${i}`).join('\n'), a1);
  const a2 = m.beginMuseAsk('Second', NOW + 1);
  m.goTo('home'); // Muse is off screen when the second reply arrives
  m.setMuseAnswer('q', Array.from({ length: 12 }, (_, i) => `second line ${i}`).join('\n'), a2);
  m.goTo('muse');
  assert.ok(screen(m).some(l => l.startsWith('Muse: second line 0')), `the newest reply is in view on opening:\n${screen(m).join('\n')}`);
  // scrolled to read, then a LATE answer to the older ask arrives: the view stays
  m.input('down', NOW); m.input('down', NOW);
  const before = screen(m).join('\n');
  m.setMuseAnswer('q', 'late text for the first', a1);
  assert.equal(screen(m).join('\n'), before, 'an older ask never moves the scroll');
});

test('review (3): the Back-after-Down rule is for the phone remote only, and a converted Back does not renew the window', async () => {
  const m = open();
  const ask = m.beginMuseAsk('Long one', NOW);
  m.setMuseAnswer('q', Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'), ask);
  for (let i = 0; i < 6; i++) m.input('up', NOW);
  let now = NOW; let backs = 0;
  const host = {
    model: m, tiles: {}, tileCtx: () => ({}), showingTiles: () => false, inOpenedScreen: () => true, leaveTiles: () => {}, backToTiles: () => { backs++; },
    paint: () => {}, isBlank: () => false, wake: () => {}, runTileEffect: () => {}, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => now, runModelAction: () => {},
  } as unknown as FlowHost;
  const handle = makeHandle(host);
  await handle('down', 'touch'); now += 200;
  await handle('back', 'touch'); // a touch double-tap right after a swipe: always a Back
  assert.equal(backs, 1, 'touch is never converted');
  // remote: one Down, then Backs keep coming (double-taps): only the first, inside the window, is converted
  now += 5000; backs = 0;
  m.goTo('muse'); for (let i = 0; i < 6; i++) m.input('up', NOW);
  await handle('down', 'remote'); now += 200;
  await handle('back', 'remote'); // converted: scrolls
  assert.equal(backs, 0);
  now += 200;
  await handle('back', 'remote'); // 400 ms after the Down: still inside 0.6 s, converted
  now += 300;
  await handle('back', 'remote'); // 700 ms after the real Down: the window has NOT been renewed by the converted Backs, so this leaves
  assert.equal(backs, 1, 'a long reply can be left by double-tapping');
});

test('a question seeded without a reply says it was asked on another device (no timer, no pretend thinking); reopening completes it', () => {
  const m = open(); const tile = new MuseCache();
  applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: '' }, tile.startRead());
  const text = screen(m).join(' ');
  assert.match(text, /Muse: \(asked on another device; reopen to see the answer\)/);
  assert.doesNotMatch(text, /thinking/);
  const view = m.museTileView()!;
  assert.equal(view.elsewhere, true);
  const w = widgetFor('muse');
  const ctx = () => ({ data, now: NOW, terminal: () => null, chat: () => null, muse: () => m.museTileView(), museWaiting: () => false, museElsewhere: () => m.museTileView()?.elsewhere ?? false, reminders: () => [], url: () => null }) as never;
  assert.deepEqual(w.body(ctx(), 40), ['You: asked elsewhere', 'Muse: (asked on another device; reopen', 'to see the answer)']);
  // our own ask is still 'thinking'
  const own = open(); own.beginMuseAsk('mine', NOW);
  assert.match(screen(own).join(' '), /Muse is thinking…/);
  assert.equal(own.museTileView()!.elsewhere, false);
  // reopening reads /latest as today and completes it
  m.goTo('muse');
  applyMuseLatest(m, tile, tile.fetchStart(), { question: 'asked elsewhere', reply: 'Now the answer.' }, tile.startRead());
  assert.match(screen(m).join(' '), /Muse: Now the answer\./);
  assert.equal(m.museTileView()!.elsewhere, false);
});
