import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSession, ConvHttpError, CHUNK_BYTES, MAX_LISTEN_MS, MUSE_MAX_CHARS, museSummaryText, asBackend } from '../src/conversation';
import type { Conversation, ConvBackend, ConvHub } from '../src/conversation';
import type { Action } from '../src/model';

class FakeHub implements ConvHub {
  started: ConvBackend[] = [];
  chunks: { id: string; seq: number; bytes: number }[] = [];
  stopped: string[] = [];
  inflight = 0; maxInflight = 0;
  state: Conversation = { state: 'idle' };
  chunkError: ((seq: number, attempt: number) => Error | null) | null = null;
  startError: Error | null = null;
  attempts = new Map<number, number>();
  async start(backend: ConvBackend) {
    if (this.startError) throw this.startError;
    this.started.push(backend);
    this.state = { id: 'c1', state: 'listening', startedAt: 1000, hints: [] };
    return { id: 'c1', startedAt: 1000 };
  }
  async chunk(id: string, seq: number, pcm: Uint8Array) {
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await new Promise(r => setImmediate(r));
    this.inflight--;
    const attempt = (this.attempts.get(seq) ?? 0) + 1;
    this.attempts.set(seq, attempt);
    const err = this.chunkError?.(seq, attempt);
    if (err) throw err;
    this.chunks.push({ id, seq, bytes: pcm.length });
  }
  async stop(id: string) { this.stopped.push(id); this.state = { ...this.state, state: 'summarizing' }; }
  async get() { return this.state; }
}

function setup(over: { voiceBusy?: boolean; micOk?: boolean } = {}) {
  const hub = new FakeHub();
  let now = 1_000_000;
  const mic = { on: 0, off: 0, ok: over.micOk ?? true };
  const sentIds = new Set<string>();
  const diags: string[] = [];
  let changes = 0;
  const conv = new ConversationSession({
    hub: () => hub,
    mic: { on: async () => { mic.on++; return mic.ok; }, off: async () => { mic.off++; } },
    voiceMicBusy: () => over.voiceBusy ?? false,
    sent: { has: id => sentIds.has(id), add: id => sentIds.add(id) },
    diag: (name, detail = '') => { diags.push(`${name} ${detail}`); },
    changed: () => { changes++; },
    sleep: async () => {},
  }, () => now);
  return { hub, conv, mic, sentIds, diags, advance: (ms: number) => { now += ms; }, changes: () => changes };
}
const pcm = (n: number) => new Uint8Array(n);
const settle = () => new Promise(r => setTimeout(r, 20));

test('nothing listens until Start; Start opens the mic and the hub session with the chosen backend', async () => {
  const t = setup();
  assert.equal(t.conv.view().phase, 'idle');
  assert.equal(t.mic.on, 0);
  t.conv.onAudio(pcm(CHUNK_BYTES)); // audio with no session goes nowhere
  await settle();
  assert.equal(t.hub.chunks.length, 0);
  await t.conv.start('claude');
  assert.equal(t.conv.view().phase, 'listening');
  assert.deepEqual(t.hub.started, ['claude']);
  assert.equal(t.mic.on, 1);
  assert.equal(asBackend('nonsense'), 'claude');
});

test('audio goes up in 9 s chunks, in order, one at a time; the remainder waits', async () => {
  const t = setup();
  await t.conv.start('local');
  for (let i = 0; i < 25; i++) t.conv.onAudio(pcm(20_000)); // 500 000 bytes: one chunk + 212 000 left... then more
  for (let i = 0; i < 20; i++) t.conv.onAudio(pcm(20_000)); // 900 000 in all = 3 chunks + 36 000
  await settle();
  assert.deepEqual(t.hub.chunks.map(c => c.seq), [0, 1, 2]);
  assert.ok(t.hub.chunks.every(c => c.bytes === CHUNK_BYTES));
  assert.equal(t.hub.maxInflight, 1);
});

test('hints and the elapsed time come from the 2 s poll', async () => {
  const t = setup();
  await t.conv.start('claude');
  t.hub.state = { id: 'c1', state: 'listening', hints: ['Ask about the budget', 'Deadline is Friday'] };
  t.advance(1500);
  await t.conv.tick();
  assert.deepEqual(t.conv.view().hints, []); // too soon: not polled yet
  t.advance(1000);
  await t.conv.tick();
  assert.deepEqual(t.conv.view().hints, ['Ask about the budget', 'Deadline is Friday']);
  assert.equal(t.conv.view().elapsedMs, 2500);
});

test('Stop sends the last piece, tells the hub, then the poll brings the summary', async () => {
  const t = setup();
  await t.conv.start('claude');
  t.conv.onAudio(pcm(50_000)); // about 1.5 s: worth sending
  await t.conv.stop('tap');
  assert.equal(t.mic.off, 1);
  assert.deepEqual(t.hub.chunks.map(c => c.bytes), [50_000]);
  assert.deepEqual(t.hub.stopped, ['c1']);
  assert.equal(t.conv.view().phase, 'summarizing');
  t.hub.state = { id: 'c1', state: 'done', summary: ['We agreed the plan.'], actions: ['Send the notes'], stoppedAt: 5000 };
  t.advance(2500);
  await t.conv.tick();
  const v = t.conv.view();
  assert.equal(v.phase, 'done');
  assert.deepEqual(v.summary, ['We agreed the plan.']);
  assert.deepEqual(v.actions, ['Send the notes']);
});

test('a scrap shorter than a second is dropped at Stop', async () => {
  const t = setup();
  await t.conv.start('claude');
  t.conv.onAudio(pcm(8000));
  await t.conv.stop('tap');
  assert.equal(t.hub.chunks.length, 0);
});

test('stops by itself after 30 minutes', async () => {
  const t = setup();
  await t.conv.start('claude');
  t.advance(MAX_LISTEN_MS - 1000);
  await t.conv.tick();
  assert.equal(t.conv.view().phase, 'listening');
  t.advance(1000);
  await t.conv.tick();
  await settle();
  assert.equal(t.conv.view().phase, 'summarizing');
  assert.deepEqual(t.hub.stopped, ['c1']);
  assert.ok(t.diags.some(d => d.startsWith('conv.stop 30 min')));
});

test('going to the background stops once, even if it is asked twice', async () => {
  const t = setup();
  await t.conv.start('claude');
  await Promise.all([t.conv.stop('background'), t.conv.stop('background')]);
  assert.equal(t.mic.off, 1);
  assert.deepEqual(t.hub.stopped, ['c1']);
  await t.conv.stop('background'); // not listening any more: nothing
  assert.deepEqual(t.hub.stopped, ['c1']);
});

test('the microphone is shared: voice reply running blocks Start, and listening reports itself', async () => {
  const busy = setup({ voiceBusy: true });
  await busy.conv.start('claude');
  assert.equal(busy.conv.view().phase, 'idle');
  assert.match(busy.conv.view().notice, /voice reply/);
  assert.equal(busy.mic.on, 0);
  assert.equal(busy.hub.started.length, 0);
  const t = setup();
  assert.equal(t.conv.isListening(), false);
  await t.conv.start('claude');
  assert.equal(t.conv.isListening(), true); // main.ts answers the voice microphone with "Stop listening first"
  await t.conv.stop('tap');
  assert.equal(t.conv.isListening(), false);
});

test('start problems: another session (409) and a microphone that will not start', async () => {
  const t = setup();
  t.hub.startError = new ConvHttpError('already listening', 409);
  await t.conv.start('claude');
  assert.equal(t.conv.view().phase, 'idle');
  assert.match(t.conv.view().notice, /Already listening/);
  const m = setup({ micOk: false });
  await m.conv.start('claude');
  assert.equal(m.conv.view().phase, 'error');
  assert.match(m.conv.view().error, /microphone/);
  assert.deepEqual(m.hub.stopped, ['c1']); // the empty session is closed
});

test('a failed chunk is tried again; a gone session (410) ends the listening', async () => {
  const t = setup();
  t.hub.chunkError = (seq, attempt) => (seq === 0 && attempt < 3 ? new Error('network') : null);
  await t.conv.start('claude');
  t.conv.onAudio(pcm(CHUNK_BYTES * 2));
  await settle();
  assert.deepEqual(t.hub.chunks.map(c => c.seq), [0, 1]); // 0 after two retries, still before 1
  const g = setup();
  g.hub.chunkError = () => new ConvHttpError('gone', 410);
  await g.conv.start('claude');
  g.conv.onAudio(pcm(CHUNK_BYTES));
  await settle();
  assert.equal(g.conv.view().phase, 'error');
  assert.equal(g.mic.off, 1);
});

// ---- Send summary to Muse ----

async function finished(t: ReturnType<typeof setup>, summary = ['One.', 'Two.'], actions = ['Call Sam']) {
  await t.conv.start('claude');
  await t.conv.stop('tap');
  t.hub.state = { id: 'c1', state: 'done', summary, actions, stoppedAt: Date.UTC(2026, 9, 29, 14, 32) };
  t.advance(2500);
  await t.conv.tick();
}

test('Send to Muse: dispatches the existing askMuse action, once per summary id', async () => {
  const t = setup();
  await finished(t);
  const sent: Action[] = [];
  assert.equal(t.conv.sendToMuse(a => sent.push(a)), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'askMuse');
  const text = (sent[0] as { text: string }).text;
  assert.match(text, /^Summary of a conversation \(\d{4}-\d\d-\d\d \d\d:\d\d\):\nOne\.\nTwo\.\nAction items:\n- Call Sam$/);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['kind', 'text']);
  assert.equal(t.conv.view().sent, true);
  assert.equal(t.conv.sendToMuse(a => sent.push(a)), false); // second tap: nothing
  assert.equal(sent.length, 1);
  assert.ok(t.sentIds.has('c1'));
});

test('Send to Muse: never while listening, summarizing or before any summary; never automatic', async () => {
  const t = setup();
  const sent: Action[] = [];
  assert.equal(t.conv.sendToMuse(a => sent.push(a)), false); // idle
  await t.conv.start('claude');
  assert.equal(t.conv.sendToMuse(a => sent.push(a)), false); // listening
  await t.conv.stop('tap');
  assert.equal(t.conv.sendToMuse(a => sent.push(a)), false); // summarizing
  t.hub.state = { id: 'c1', state: 'done', summary: ['Done.'], actions: [] };
  t.advance(2500);
  await t.conv.tick();
  assert.equal(sent.length, 0); // reaching "done" sent nothing by itself
});

test('Send to Muse: the text is capped at 1500 characters', () => {
  const long = Array.from({ length: 5 }, () => 'x'.repeat(400));
  const text = museSummaryText(long, ['y'.repeat(400)], Date.UTC(2026, 9, 29, 14, 32));
  assert.equal(text.length, MUSE_MAX_CHARS);
  assert.ok(text.endsWith('…'));
  assert.ok(museSummaryText(['Short.'], [], 0).length < 100);
});

test('Send to Muse: a summary already sent stays sent after the app restarts (same id in the store)', async () => {
  const t = setup();
  t.sentIds.add('c1');
  await finished(t);
  assert.equal(t.conv.view().sent, true);
  assert.equal(t.conv.sendToMuse(() => assert.fail('must not send')), false);
});
