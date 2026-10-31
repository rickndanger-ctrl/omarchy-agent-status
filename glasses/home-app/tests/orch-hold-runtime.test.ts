import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentVoice } from '../src/agent-voice';
import { Latest } from '../src/latest';

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => setImmediate(r)); };
function rig() {
  const latest = new Latest(), stopToken = {}, thinkingToken = {};
  const state = { stop: stopToken as unknown | null, thinking: null as unknown | null, recording: null as Uint8Array[] | null, abandoned: 0 };
  const transcripts: unknown[][] = [], mics: boolean[] = [], texts: Uint8Array[] = [];
  const micWait = deferred<boolean>(), startWait = deferred<boolean>(), textWait = deferred<string>();
  let delayOn = false, delayOff = false, delayText = false, failStart = false;
  const voice = new AgentVoice({
    model: { agentHoldToken: () => state.stop, agentTranscriptToken: () => state.thinking,
      abandonTalk: () => { state.abandoned++; state.stop = null; state.thinking = null; },
      setTranscript: (...args: unknown[]) => { transcripts.push(args); } },
    latest, recording: () => state.recording, setRecording: value => { state.recording = value; },
    microphone: async on => { mics.push(on); return on ? delayOn ? startWait.promise : !failStart : delayOff ? micWait.promise : true; },
    transcribe: async audio => { texts.push(audio); return delayText ? textWait.promise : 'fixture private speech'; },
    now: () => 1000, diag: () => {}, changed: () => {}, failed: () => {},
  });
  const start = async () => { const job = voice.run({ kind: 'startMic' }); assert.ok(job, 'the owned agent start must be handled'); await job; assert.ok(state.recording, 'agent audio buffer must exist'); state.recording.push(Uint8Array.of(1, 2)); state.stop = null; state.thinking = thinkingToken; };
  return { voice, latest, state, stopToken, thinkingToken, transcripts, mics, texts, micWait, startWait, textWait, start,
    delayOn: () => { delayOn = true; },
    delayOff: () => { delayOff = true; }, delayText: () => { delayText = true; }, failStart: () => { failStart = true; } };
}

test('agent runtime snapshots its audio before a slow stop and cannot consume a newer Muse buffer', async () => {
  const r = rig(); await r.start(); r.delayOff();
  const oldStop = r.voice.run({ kind: 'stopMic' });
  assert.ok(oldStop); assert.equal(r.state.recording, null);
  r.state.stop = null; r.state.thinking = null;
  assert.equal(r.voice.run({ kind: 'startMic' }), null, 'Muse must use the original runtime branch');
  r.latest.next(); const muse = [Uint8Array.of(7, 8)]; r.state.recording = muse;
  r.micWait.resolve(true); await oldStop;
  assert.equal(r.state.recording, muse);
  assert.deepEqual(r.texts, []); assert.deepEqual(r.transcripts, []);
  assert.deepEqual(r.mics, [true, false]);
  assert.equal(r.voice.run({ kind: 'stopMic' }), null, 'the newer Muse stop must not be intercepted');
  assert.equal(r.voice.run({ kind: 'cancelMic' }), null, 'the newer Muse cancel must not be intercepted');
});

test('agent transcript callbacks need both Latest ownership and the captured thinking token', async () => {
  for (const changed of ['cancel', 'new-attempt', 'target'] as const) {
    const r = rig(); await r.start(); r.delayText();
    const job = r.voice.run({ kind: 'stopMic' }); await flush();
    if (changed === 'cancel') await r.voice.run({ kind: 'cancelMic' });
    else if (changed === 'new-attempt') r.latest.next();
    else r.state.thinking = {};
    r.textWait.resolve('fixture old private speech'); await job;
    assert.deepEqual(r.transcripts, [], changed);
  }
});

test('successful agent transcript passes its immutable token and a failed start abandons only that attempt', async () => {
  const r = rig(); await r.start(); await r.voice.run({ kind: 'stopMic' });
  assert.deepEqual(r.transcripts, [['fixture private speech', 1000, r.thinkingToken]]);
  const bad = rig(); bad.failStart(); await bad.voice.run({ kind: 'startMic' });
  assert.equal(bad.state.abandoned, 1); assert.equal(bad.state.recording, null);
  assert.deepEqual(bad.transcripts, []);
});

test('Muse actions without an owned agent attempt are never intercepted', () => {
  const r = rig(); r.state.stop = null;
  for (const kind of ['startMic', 'stopMic', 'cancelMic'] as const) assert.equal(r.voice.run({ kind }), null);
  assert.deepEqual(r.mics, []); assert.deepEqual(r.texts, []);
});

test('a failed microphone start invalidates its same recording even after STOP cloned the stage', async () => {
  const r = rig(); r.delayOn(); r.delayOff();
  const start = r.voice.run({ kind: 'startMic' });
  r.state.stop = null; r.state.thinking = r.thinkingToken;
  const stop = r.voice.run({ kind: 'stopMic' });
  r.startWait.resolve(false); await start;
  r.micWait.resolve(true); await stop;
  assert.deepEqual(r.texts, [], 'a failed start must never upload its recording');
  assert.deepEqual(r.transcripts, []);
  assert.equal(r.state.abandoned, 1);
});
