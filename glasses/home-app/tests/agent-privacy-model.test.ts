import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, sessionKey, type HomeData, type Session } from '../src/model';

const NOW = 1000;
const SECRET = 'private words must never leak';
const original: Session = { machine: 'Dell', agent: 'claude', name: 'Orchestrator', pane: 'orchestrator', appThread: 'thread-A', tmux: 'orchestrator', session: 's1', state: 'idle', page: 'Project', at: 1, workspace: '' };
const data = (s: Session[] = [original], now = NOW): HomeData => ({ now, paused: false, machines: [{ name: 'Dell', online: true }], sessions: s, pending: [], messages: null, muse: true, voice: true });
function fixture(over: Partial<Session> = {}) {
  const session = { ...original, ...over }, model = new HomeModel();
  model.update(data([session]));
  model.openTarget({ kind: 'agent', key: sessionKey(session) });
  model.setTerminal(sessionKey(session), ['An ordinary terminal line']);
  return { model, session };
}
function confirm(model: HomeModel, text = SECRET) {
  assert.deepEqual(model.input('select', NOW), { kind: 'startMic' });
  const stop = model.agentHoldToken();
  assert.deepEqual(model.hold(NOW + 1, stop), { kind: 'stopMic' });
  const transcript = model.agentTranscriptToken();
  assert.notEqual(transcript, null);
  model.setTranscript(text, NOW + 2, transcript);
  assert.equal(model.screenKind, 'confirm');
  return { stop, transcript, send: model.agentHoldToken() };
}
const prompt = (s: Session, text = SECRET) => ({ kind: 'prompt', machine: s.machine, pane: s.pane ?? '', ...(s.window ? { window: s.window } : {}), ...(s.appThread ? { appThread: s.appThread } : {}), text });

test('three accidental touch taps start only the microphone, never stop or send', () => {
  const { model } = fixture();
  assert.deepEqual(model.input('select', NOW), { kind: 'startMic' });
  assert.equal(model.input('select', NOW + 1), null);
  assert.equal(model.input('select', NOW + 2), null);
  assert.equal(model.micWanted(), true);
  assert.match(model.render(NOW + 2), /hold to stop/i);
  model.setTranscript(SECRET, NOW + 3);
  assert.equal(model.screenKind, 'agent');
  assert.doesNotMatch(model.render(NOW + 3), /private words/);
});

test('tap then STOP hold then SEND hold sends exactly once through an isolated confirm', () => {
  const { model, session } = fixture();
  const { stop, send } = confirm(model);
  assert.notEqual(stop, send);
  assert.equal(model.micWanted(), false);
  const screen = model.render(NOW + 2);
  assert.match(screen, /SEND TO/i);
  assert.match(screen, /private words/);
  assert.match(screen, /hold.*send/i);
  assert.match(screen, /tap.*cancel/i);
  assert.ok(screen.split('\n').length <= 10);
  assert.deepEqual(model.hold(NOW + 3, send), prompt(session));
  assert.equal(model.hold(NOW + 4, send), null);
  assert.equal(model.agentHoldWanted(), false);
  assert.equal(model.agentConfirmDeadline(), null);
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});

test('touch tap or double-tap on protected confirm cancels and erases text', () => {
  for (const input of ['select', 'back'] as const) {
    const { model } = fixture();
    const { send } = confirm(model);
    assert.equal(model.input(input, NOW + 3), null);
    assert.equal(model.screenKind, 'agent');
    assert.equal(model.agentConfirmDeadline(), null);
    assert.equal(model.hold(NOW + 4, send), null);
    assert.doesNotMatch(JSON.stringify(model), /private words/);
  }
});

test('only real user input renews the 20 second confirm deadline', () => {
  const { model } = fixture(); confirm(model);
  assert.equal(model.agentConfirmDeadline(), NOW + 2 + 20_000);
  model.render(NOW + 10_000);
  model.update(data([{ ...original, page: 'Updated project', at: 15 }], NOW + 15_000));
  assert.equal(model.agentConfirmDeadline(), NOW + 2 + 20_000);
  model.input('up', NOW + 19_000);
  assert.equal(model.agentConfirmDeadline(), NOW + 39_000);
  assert.equal(model.expireAgentConfirm(NOW + 38_999), false);
  assert.equal(model.expireAgentConfirm(NOW + 39_000), true);
  assert.equal(model.screenKind, 'agent');
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});

test('expiry is enforced at >=20s before hold or remote send even when the timer is delayed', () => {
  for (const action of ['hold', 'remote'] as const) {
    const { model } = fixture(); const { send } = confirm(model);
    const deadline = model.agentConfirmDeadline()!;
    assert.equal(action === 'hold' ? model.hold(deadline, send) : model.input('select', deadline, 'remote'), null);
    assert.equal(model.screenKind, 'agent');
    assert.equal(model.agentConfirmDeadline(), null);
    assert.doesNotMatch(JSON.stringify(model), /private words/);
  }
});

test('a hold just before the deadline is intentional; duplicate old STOP holds cannot become SEND', () => {
  const { model, session } = fixture(); const { stop, send } = confirm(model);
  assert.equal(model.hold(NOW + 3, stop), null);
  assert.equal(model.screenKind, 'confirm');
  assert.deepEqual(model.hold(model.agentConfirmDeadline()! - 1, send), prompt(session));
});

test('hold tokens identify target, recording, and stop/send stage; thinking is ineligible', () => {
  const { model } = fixture();
  model.input('select', NOW);
  const stop = model.agentHoldToken();
  assert.notEqual(stop, null);
  assert.equal(model.agentHoldToken(), stop);
  model.hold(NOW + 1, stop);
  assert.equal(model.agentHoldToken(), null);
  assert.equal(model.agentHoldWanted(), false);
  assert.equal(model.hold(NOW + 2, stop), null);
  model.setTranscript(SECRET, NOW + 3, model.agentTranscriptToken());
  assert.notEqual(model.agentHoldToken(), stop);
  assert.equal(model.hold(NOW + 4, stop), null);
});

test('late transcription after cancellation or a same-key restart never revives old speech', () => {
  const { model } = fixture();
  model.input('select', NOW); model.hold(NOW + 1);
  const old = model.agentTranscriptToken();
  model.input('back', NOW + 2);
  model.setTranscript(SECRET, NOW + 3, old);
  assert.equal(model.agentHoldWanted(), false);
  model.input('select', NOW + 4); model.hold(NOW + 5);
  const current = model.agentTranscriptToken();
  assert.notEqual(old, current);
  model.setTranscript(SECRET, NOW + 6, old);
  assert.equal(model.screenKind, 'agent');
  assert.equal(model.agentHoldToken(), null);
  model.setTranscript('fresh intended text', NOW + 7, current);
  assert.equal(model.screenKind, 'confirm');
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});

test('positive transcript requires matching thinking token; mic-start failure uses explicit abandon', () => {
  const { model } = fixture();
  model.input('select', NOW);
  model.setTranscript(SECRET, NOW + 1, null);
  model.setTranscript(SECRET, NOW + 2, {});
  assert.equal(model.micWanted(), true);
  assert.equal(model.agentTranscriptToken(), null);
  assert.doesNotMatch(JSON.stringify(model), /private words/);
  model.abandonTalk();
  assert.equal(model.micWanted(), false);
});

test('foreground abandonment clears protected confirm and blocks late transcription', () => {
  const { model } = fixture(); const { transcript, send } = confirm(model);
  model.abandonTalk();
  assert.equal(model.screenKind, 'agent');
  assert.equal(model.agentConfirmDeadline(), null);
  assert.equal(model.hold(NOW + 3, send), null);
  model.setTranscript(SECRET, NOW + 4, transcript);
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});

test('remote-only select flow remains inline and sends deliberately', () => {
  const { model, session } = fixture();
  assert.deepEqual(model.input('select', NOW, 'remote'), { kind: 'startMic' });
  assert.notEqual(model.agentHoldToken(), null);
  assert.deepEqual(model.input('select', NOW + 1, 'remote'), { kind: 'stopMic' });
  model.setTranscript(SECRET, NOW + 2, model.agentTranscriptToken());
  assert.equal(model.screenKind, 'agent');
  assert.equal(model.agentConfirmDeadline(), null);
  assert.deepEqual(model.input('select', NOW + 3, 'remote'), prompt(session));
});

test('touch never stops or sends by tap after a remote start or remote stop', () => {
  const first = fixture().model;
  first.input('select', NOW, 'remote');
  assert.equal(first.input('select', NOW + 1, 'touch'), null);
  assert.equal(first.micWanted(), true);
  first.hold(NOW + 2);
  first.setTranscript(SECRET, NOW + 3, first.agentTranscriptToken());
  assert.equal(first.screenKind, 'confirm');
  assert.equal(first.input('select', NOW + 4, 'touch'), null);
  assert.doesNotMatch(JSON.stringify(first), /private words/);
  const second = fixture().model;
  second.input('select', NOW, 'remote'); second.input('select', NOW + 1, 'remote');
  second.setTranscript(SECRET, NOW + 2, second.agentTranscriptToken());
  assert.equal(second.input('select', NOW + 3, 'touch'), null);
  assert.doesNotMatch(JSON.stringify(second), /private words/);
});

test('remote select may deliberately stop and send after touch start', () => {
  const { model, session } = fixture();
  model.input('select', NOW, 'touch');
  assert.deepEqual(model.input('select', NOW + 1, 'remote'), { kind: 'stopMic' });
  model.setTranscript(SECRET, NOW + 2, model.agentTranscriptToken());
  assert.equal(model.screenKind, 'confirm');
  assert.deepEqual(model.input('select', NOW + 3, 'remote'), prompt(session));
});

test('same-key session/thread replacement or disappearance cannot receive frozen speech', () => {
  for (const change of [{ session: 's2' }, { appThread: 'thread-B' }, { pane: '%new' }, null]) {
    const { model } = fixture(); const { send } = confirm(model);
    model.update(data(change === null ? [] : [{ ...original, ...change }], NOW + 3));
    assert.equal(model.hold(NOW + 4, send), null);
    assert.equal(model.agentHoldToken(), null);
    assert.doesNotMatch(JSON.stringify(model), /private words/);
  }
});

test('recording target is copied, not a mutable reference to hub data', () => {
  const { model, session } = fixture();
  model.input('select', NOW, 'remote'); model.input('select', NOW + 1, 'remote');
  model.setTranscript(SECRET, NOW + 2, model.agentTranscriptToken());
  session.session = 'recycled'; session.appThread = 'other-thread';
  assert.equal(model.input('select', NOW + 3, 'remote'), null);
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});

test('all terminal kinds and tile/quick-reply Speak entries inherit touch privacy', () => {
  for (const over of [{}, { pane: '%7', appThread: undefined }, { pane: undefined, window: '0x123', appThread: undefined }, { pane: undefined, appThread: 'codex-thread', agent: 'codex' }]) {
    const { model, session } = fixture(over);
    assert.deepEqual(model.openTarget({ kind: 'agent', key: sessionKey(session), then: 'listen' }), { kind: 'startMic' });
    assert.equal(model.input('select', NOW + 1), null);
    assert.deepEqual(model.hold(NOW + 2), { kind: 'stopMic' });
    model.setTranscript(SECRET, NOW + 3, model.agentTranscriptToken());
    assert.equal(model.screenKind, 'confirm');
    assert.equal(model.input('select', NOW + 4), null);
    model.input('down', NOW + 5); // quick reply list
    assert.deepEqual(model.input('select', NOW + 6), { kind: 'startMic' });
    assert.equal(model.input('select', NOW + 7), null);
  }
});

test('legacy unbound agent confirm cannot send old text from a touch tap or hold', () => {
  for (const action of ['tap', 'hold'] as const) {
    const { model } = fixture();
    (model as unknown as { screen: unknown }).screen = { kind: 'confirm', key: 'Dell/orchestrator', text: SECRET };
    assert.equal(action === 'tap' ? model.input('select', NOW) : model.hold(NOW), null);
  }
});

test('an old agent transcription token cannot populate a newly opened Muse voice screen', () => {
  const { model } = fixture();
  model.input('select', NOW); model.hold(NOW + 1);
  const old = model.agentTranscriptToken();
  model.abandonTalk();
  model.openTarget({ kind: 'muse', then: 'listen' });
  const before = model.render(NOW + 2);
  model.setTranscript(SECRET, NOW + 3, old);
  assert.equal(model.screenKind, 'listen');
  assert.equal(model.render(NOW + 3), before);
  assert.doesNotMatch(JSON.stringify(model), /private words/);
});
