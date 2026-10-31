import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeListen } from '../src/listen/home';
import { safeText } from '../src/listen/render';
import type { ListenHubPort } from '../src/listen/hub';
import type { Session } from '../src/listen/model';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function rig(timeoutMs = 100) {
  const log: string[] = [];
  let busy = false, time = 10_000, starts = 0, exits = 0;
  const hub: ListenHubPort = {
    start: async () => { log.push('start'); return { id: `fixture-${++starts}`, startedAt: 1000 }; },
    stop: async id => { log.push(`stop:${id}`); },
    chunk: async (_id, seq) => { log.push(`chunk:${seq}`); return { ok: true, lines: [] }; },
    poll: async id => ({ id, startedAt: 1000, state: 'listening', now_t: 9000,
      lines: [{ t: 1000, text: 'First sentence' }, { t: 4000, text: 'Second sentence' }],
      notes: [{ t: 6000, at_t: 1000, text: 'First note' }, { t: 8000, at_t: 4000, text: 'Second note' }], muse: { state: 'idle' } }),
    waitInput: async () => { throw new Error('Home owns remote input'); },
  };
  const mic = { on: async () => { log.push('on'); return true; }, off: async () => { log.push('off'); return true; } };
  let chosen = hub;
  const home = new HomeListen({ hub: () => chosen, mic, busy: () => busy, changed: () => {},
    leave: () => { exits++; }, now: () => time, inputNow: () => time, timeoutMs });
  return { home, hub, mic, log, busy: (value: boolean) => { busy = value; },
    advance: (ms: number) => { time += ms; }, choose: (value: ListenHubPort) => { chosen = value; }, exits: () => exits };
}

test('entry and idle touch taps never start; hold and remote select deliberately toggle', async () => {
  const h = rig(); h.home.enter();
  for (let i = 0; i < 3; i++) await h.home.input('select', 'touch');
  assert.deepEqual(h.log, []); assert.match(h.home.frame().left, /Hold to start/);
  await h.home.hold(); assert.equal(h.home.view().phase, 'listening');
  await h.home.input('select', 'touch'); assert.equal(h.home.ownsMic, false);
  await h.home.input('select', 'remote'); assert.equal(h.home.view().id, 'fixture-2');
  await h.home.input('select', 'remote'); assert.equal(h.home.ownsMic, false);
  await h.home.hold(); assert.equal(h.home.view().id, 'fixture-3');
  await h.home.close(); assert.equal(h.log.filter(x => x === 'on').length, 3);
});

test('busy voice or pending transcription refuses both start paths without touching its mic', async () => {
  const h = rig(); h.busy(true); h.home.enter();
  await h.home.hold(); await h.home.input('select', 'remote'); await h.home.leave();
  assert.deepEqual(h.log, []); assert.equal(h.home.ownsMic, false);
  assert.match(h.home.view().notice, /Another voice/);
});

test('leave while hub start pending owns and drops audio until exact late session cleanup', async () => {
  const h = rig(); const pending = deferred<Session>(); h.hub.start = () => pending.promise;
  h.home.enter(); const start = h.home.hold();
  assert.equal(h.home.ownsMic, true); await turn();
  const leave = h.home.leave(); await turn();
  assert.equal(h.home.onAudio(new Uint8Array(4)), true);
  assert.equal(h.home.ownsMic, true); assert.ok(!h.log.includes('on'));
  pending.resolve({ id: 'late', startedAt: 1000 }); await Promise.all([start, leave]);
  assert.ok(h.log.includes('stop:late')); assert.ok(!h.log.includes('on'));
  assert.ok(!h.log.includes('off')); assert.equal(h.home.ownsMic, false);
  assert.equal(h.home.onAudio(new Uint8Array(4)), false);
});

test('leave in start reservation microtask cancels before any hub or microphone call', async () => {
  const h = rig(); h.home.enter(); const start = h.home.hold(); const leave = h.home.leave();
  await Promise.all([start, leave]); assert.deepEqual(h.log, []); assert.equal(h.home.ownsMic, false);
  h.home.enter(); await h.home.hold(); assert.equal(h.home.view().phase, 'listening'); await h.home.close();
});

test('busy appearing during hub start cannot start or stop another microphone', async () => {
  const h = rig(); const pending = deferred<Session>(); h.hub.start = () => pending.promise;
  h.home.enter(); const start = h.home.hold(); await turn(); h.busy(true);
  pending.resolve({ id: 'busy-late', startedAt: 1000 }); await start;
  assert.deepEqual(h.log, ['stop:busy-late']); assert.equal(h.home.ownsMic, false);
  assert.equal(h.home.view().micOn, false); await h.home.leave();
});

test('unconfirmed off retains ownership away, repeated hidden leave is inert, explicit stop recovers', async () => {
  const h = rig(); h.home.enter(); await h.home.hold();
  h.mic.off = async () => { h.log.push('off-failed'); return false; };
  await h.home.leave(); assert.equal(h.home.ownsMic, true); assert.equal(h.home.view().micOn, true);
  assert.match(h.home.frame().left, /Listening\?/); assert.equal(h.home.onAudio(new Uint8Array(4)), true);
  const calls = h.log.length; await h.home.leave(); await h.home.leave(); assert.equal(h.log.length, calls);
  h.home.enter(); h.mic.off = async () => { h.log.push('off'); return true; };
  await h.home.hold(); assert.equal(h.home.ownsMic, false);
  assert.equal(h.log.filter(x => x === 'on').length, 1); await h.home.close();
});

test('timed-out raw mic on retains claim until late on and compensating off complete', async () => {
  const h = rig(5); const pending = deferred<boolean>(); let physical = false;
  h.mic.on = async () => { h.log.push('on'); physical = await pending.promise; return physical; };
  // Like Home SDK adapter, off shares the unresolved raw-on fence.
  h.mic.off = async () => { await pending.promise; physical = false; h.log.push('off'); return true; };
  h.home.enter(); await h.home.hold(); assert.equal(h.home.ownsMic, true);
  await h.home.leave(); assert.equal(h.home.ownsMic, true);
  h.home.enter(); await h.home.input('select', 'remote');
  assert.equal(h.log.filter(x => x === 'on').length, 1);
  pending.resolve(true); await turn(); await turn();
  assert.equal(physical, false); assert.equal(h.home.ownsMic, false); await h.home.close();
});

test('rejected mic on with unconfirmed off is guarded until explicit recovery', async () => {
  const h = rig(); h.mic.on = async () => { h.log.push('on'); throw new Error('private fixture'); };
  h.mic.off = async () => false; h.home.enter(); await h.home.hold();
  assert.equal(h.home.ownsMic, true); assert.equal(h.home.view().micOn, true);
  assert.ok(!h.home.frame().left.includes('private fixture'));
  h.mic.off = async () => true; await h.home.input('select', 'remote');
  assert.equal(h.home.ownsMic, false); await h.home.close();
});

test('ordinary down twice selects note two at its speech anchor; double down returns newest', async () => {
  const h = rig(); h.home.enter(); await h.home.hold(); await h.home.poll();
  await h.home.input('down', 'remote'); assert.equal(h.home.view().selectedNoteIndex, 0);
  h.advance(401); await h.home.input('down', 'touch');
  assert.equal(h.home.view().selectedNoteIndex, 1); assert.equal(h.home.view().transcriptAt, 4000);
  assert.equal(h.home.view().transcriptIndex, 1);
  await h.home.poll(); assert.equal(h.home.view().selectedNoteIndex, 1);
  h.advance(401); await h.home.input('down'); h.advance(100); await h.home.input('down');
  assert.equal(h.home.view().selectedNoteIndex, null); await h.home.close();
});

test('hub binding stays fixed until restart and Back cleans up before navigation', async () => {
  const h = rig(); h.home.enter(); await h.home.hold();
  let other = 0; h.choose({ ...h.hub, start: async () => { other++; return { id: 'other', startedAt: 1000 }; },
    poll: async () => { throw new Error('must not redirect'); }, stop: async () => { other++; } });
  await h.home.poll(); await h.home.input('back');
  assert.equal(other, 0); assert.equal(h.exits(), 1); assert.equal(h.home.ownsMic, false);
  assert.equal(h.home.view().active, false); h.home.enter(); await h.home.hold();
  assert.equal(h.home.view().id, 'other'); await h.home.close();
});

test('arrival timestamps retain 400ms gesture semantics despite delayed application', async () => {
  const h = rig(); h.home.enter(); await h.home.hold(); await h.home.poll();
  await h.home.input('down', 'remote', 1000); h.advance(450);
  await h.home.input('down', 'remote', 1100);
  assert.equal(h.home.view().selectedNoteIndex, null);
  h.advance(450); await h.home.input('down', 'touch', 2000);
  h.advance(450); await h.home.input('down', 'touch', 2401);
  assert.equal(h.home.view().selectedNoteIndex, 1);
  await h.home.close();
});

test('render exports fixed-font byte and UTF16 bound without surrogate fragments', () => {
  const text = safeText('● café—‘note’🧑‍🚀\ud800'.repeat(200));
  assert.ok(text.length <= 950); assert.ok(new TextEncoder().encode(text).length <= 950);
  assert.ok(!/[\ud800-\udfff]/u.test(text)); assert.match(text, /● café-'note'/);
});
