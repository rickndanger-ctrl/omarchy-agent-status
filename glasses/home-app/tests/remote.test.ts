import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MS, RemoteInput } from '../src/remote';
import type { RemoteInputName } from '../src/remote';

/** A fake hub: each wait is answered by the next scripted reply, or hangs until aborted when the script runs out. */
type Reply = { status?: number; body?: unknown } | 'fail';
function harness(script: Record<string, Reply[]>) {
  const calls: { hub: string; after: string; auth: string | null; aborted: boolean }[] = [];
  const applied: [RemoteInputName, number][] = [];
  const delays: number[] = [];
  const state = { hub: 'http://hub-a.test:7777/', token: 'tok', foreground: true };
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call = { hub: u.origin + '/', after: u.searchParams.get('after') ?? '', auth: new Headers(init?.headers).get('Authorization'), aborted: false };
    calls.push(call);
    assert.equal(u.pathname, '/api/input/wait');
    const reply = script[call.hub]?.shift();
    if (!reply) {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => { call.aborted = true; reject(new DOMException('aborted', 'AbortError')); }));
    }
    if (reply === 'fail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply!.body ?? {}), { status: reply!.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const remote = new RemoteInput({
    hub: () => state.hub, token: () => state.token, active: () => state.foreground,
    apply: (input, seq) => applied.push([input, seq]),
    fetch: fetchImpl,
    sleep: async ms => { delays.push(ms); },
  });
  return { remote, calls, applied, delays, state };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const input = (seq: number, name: string) => ({ seq, input: name, at: 1 });

test('one wait to the current hub, "from now" first, then after the last number; each input applied in order', async () => {
  const h = harness({ 'http://hub-a.test:7777/': [
    { body: { seq: 2, inputs: [input(1, 'down'), input(2, 'select')] } },
    { body: { seq: 2, inputs: [] } },
    { body: { seq: 3, inputs: [input(3, 'back')] } },
  ] });
  h.remote.sync();
  await tick();
  assert.deepEqual(h.applied, [['down', 1], ['select', 2], ['back', 3]]);
  assert.deepEqual(h.calls.map(c => c.after), ['0', '2', '2', '3']); // reopened at once each time, then hangs open
  assert.ok(h.calls.every(c => c.auth === 'Bearer tok'));
  assert.equal(h.calls.length, 4);
  assert.equal(h.remote.waiting, true);
  assert.deepEqual(h.delays, []);
  h.remote.stop();
});

test('syncing again while a wait is open does not open a second one', async () => {
  const h = harness({});
  h.remote.sync(); h.remote.sync(); h.remote.sync();
  await tick();
  assert.equal(h.calls.length, 1);
  h.remote.stop();
});

test('going to the background drops the wait; coming back opens a fresh one from now', async () => {
  const h = harness({ 'http://hub-a.test:7777/': [{ body: { seq: 5, inputs: [input(5, 'up')] } }] });
  h.remote.sync();
  await tick();
  assert.equal(h.calls.length, 2);
  h.state.foreground = false;
  h.remote.sync();
  await tick();
  assert.equal(h.calls[1].aborted, true);
  assert.equal(h.remote.waiting, false);
  const before = h.calls.length;
  await tick();
  assert.equal(h.calls.length, before, 'no wait while in the background');
  h.state.foreground = true;
  h.remote.sync();
  await tick();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1)!.after, '0', 'a new wait starts "from now"');
  h.remote.stop();
});

test('switching hub drops the old wait and waits on the new hub only; the old hub is never asked again', async () => {
  const h = harness({
    'http://hub-a.test:7777/': [{ body: { seq: 9, inputs: [input(9, 'up')] } }],
    'http://hub-b.test:7777/': [{ body: { seq: 1, inputs: [input(1, 'select')] } }],
  });
  h.remote.sync();
  await tick();
  const askedA = h.calls.filter(c => c.hub.includes('hub-a')).length;
  h.state.hub = 'http://hub-b.test:7777/';
  h.remote.sync();
  await tick();
  assert.equal(h.calls.filter(c => c.hub.includes('hub-a')).length, askedA);
  assert.equal(h.calls.find(c => c.hub.includes('hub-b'))!.after, '0');
  assert.deepEqual(h.applied, [['up', 9], ['select', 1]], 'hub B restarted its numbering: seq 1 is accepted');
  assert.equal(h.calls.filter(c => c.hub.includes('hub-a'))[askedA - 1].aborted, true);
  h.remote.stop();
});

test('errors back off 1, 2, 5, 5 s and then recover; no wait without a token', async () => {
  const h = harness({ 'http://hub-a.test:7777/': ['fail', { status: 502 }, 'fail', 'fail', { body: { seq: 1, inputs: [input(1, 'down')] } }] });
  h.remote.sync();
  await tick();
  assert.deepEqual(h.delays, [...BACKOFF_MS, BACKOFF_MS[2]]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000]);
  assert.deepEqual(h.applied, [['down', 1]]);
  h.remote.stop();
  const none = harness({});
  none.state.token = '';
  none.remote.sync();
  await tick();
  assert.equal(none.calls.length, 0);
});

test('a success resets the back-off', async () => {
  const h = harness({ 'http://hub-a.test:7777/': ['fail', { body: { seq: 1, inputs: [] } }, 'fail'] });
  h.remote.sync();
  await tick();
  assert.deepEqual(h.delays, [1000, 1000]);
  h.remote.stop();
});

test('stale or unknown inputs are ignored; the same number is never applied twice', async () => {
  const h = harness({ 'http://hub-a.test:7777/': [
    { body: { seq: 3, inputs: [input(3, 'select'), input(3, 'select'), input(2, 'up'), input(4, 'power off')] } },
    { body: { seq: 3, inputs: [input(3, 'select')] } },
  ] });
  h.remote.sync();
  await tick();
  assert.deepEqual(h.applied, [['select', 3]]);
  h.remote.stop();
});

test('an answer that lands after the wait was dropped is not applied', async () => {
  const h = harness({});
  let release: (r: Response) => void = () => {};
  const slow = new RemoteInput({
    hub: () => h.state.hub, token: () => 'tok', active: () => h.state.foreground,
    apply: (i, s) => h.applied.push([i, s]),
    fetch: (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch,
    sleep: async () => {},
  });
  slow.sync();
  await tick();
  h.state.foreground = false;
  slow.sync();
  release(new Response(JSON.stringify({ seq: 1, inputs: [input(1, 'select')] })));
  await tick();
  assert.deepEqual(h.applied, []);
});
