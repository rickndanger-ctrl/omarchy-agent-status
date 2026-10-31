import test from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../src/inputqueue';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(r => setImmediate(r)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

function rig() {
  const seen: string[] = [];
  const first = {}, second = {};
  const state = { token: first as unknown | null, foreground: true, generation: 0, wait: null as Promise<void> | null };
  const queue = new InputQueue({
    apply: (input, source) => { seen.push(`${input}:${source}`); },
    holdToken: () => state.token,
    hold: token => { assert.equal(token, state.token); seen.push('hold'); state.token = second; },
    menu: () => {}, foreground: () => state.foreground, generation: () => state.generation,
    screen: () => 'agent', settled: () => state.wait ? state.wait.then(() => 'rendered' as const) : Promise.resolve('rendered' as const),
    log: (name, detail) => { if (name === 'input.stale' || name === 'input.cancelled' || name === 'input.ignored') seen.push(`${name}:${detail}`); },
  });
  return { queue, state, seen, first, second };
}

test('the queue delivers the actual touch or remote source when its turn runs', async () => {
  const r = rig();
  r.queue.push('select', 'touch');
  r.queue.push('select', 'remote');
  await flush();
  assert.deepEqual(r.seen, ['select:touch', 'select:remote']);
});

test('a queued hold captures its stage and cannot turn a second stop gesture into send', async () => {
  const r = rig(), gate = deferred();
  r.state.wait = gate.promise;
  r.queue.push('up', 'touch');
  r.queue.pushHold(); r.queue.pushHold();
  gate.resolve(); await flush();
  assert.equal(r.seen.filter(x => x === 'hold').length, 1);
  assert.ok(r.seen.some(x => x.startsWith('input.stale:hold')));
});

test('holds are dropped after a target/stage change or an unsolicited generation change', async () => {
  for (const change of ['target', 'generation'] as const) {
    const r = rig(), gate = deferred();
    r.state.wait = gate.promise;
    r.queue.push('up', 'touch'); r.queue.pushHold();
    if (change === 'target') r.state.token = {};
    else r.state.generation++;
    gate.resolve(); await flush();
    assert.equal(r.seen.includes('hold'), false, change);
    assert.ok(r.seen.some(x => x.startsWith('input.stale:hold')), change);
  }
});

test('hold obeys foreground, queue clear, and missing-context boundaries', async () => {
  const r = rig();
  r.state.foreground = false; r.queue.pushHold();
  r.state.foreground = true; r.state.token = null; r.queue.pushHold();
  await flush();
  assert.equal(r.seen.includes('hold'), false);
  const gate = deferred(); r.state.token = r.first; r.state.wait = gate.promise;
  r.queue.push('up', 'touch'); r.queue.pushHold(); r.queue.clear('left the front');
  gate.resolve(); await flush();
  assert.equal(r.seen.includes('hold'), false);
  assert.ok(r.seen.some(x => x.startsWith('input.cancelled:hold')));
});

test('a hold rechecks foreground after waiting behind an earlier render', async () => {
  const r = rig(), gate = deferred(); r.state.wait = gate.promise;
  r.queue.push('up', 'touch'); r.queue.pushHold(); r.state.foreground = false;
  gate.resolve(); await flush();
  assert.equal(r.seen.includes('hold'), false);
});
