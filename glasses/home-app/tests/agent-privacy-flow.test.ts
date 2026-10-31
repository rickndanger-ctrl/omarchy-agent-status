import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type Action, type HomeData } from '../src/model';
import { Tiles, type TileContext, type TileEffect } from '../src/tiles';
import * as flow from '../src/inputflow';

const data: HomeData = { now: 1000, paused: false, voice: true, muse: true, pending: [], messages: null,
  machines: [{ name: 'Dell', online: true }], sessions: [{ machine: 'Dell', pane: 'orchestrator', session: 's1', agent: 'claude', name: 'Orchestrator', state: 'idle', page: 'Project', at: 1, workspace: '' }] };
function fixture() {
  const model = new HomeModel(), tiles = new Tiles(), actions: Action[] = [], sources: unknown[] = [];
  let time = 1000, blank = false, desk = false, tiled = false, opened = false, wakes = 0, backs = 0, paints = 0;
  model.update(data); model.openTarget({ kind: 'agent', key: 'Dell/orchestrator' });
  const ctx = (): TileContext => ({ data, now: time, terminal: () => null, chat: () => null, muse: () => null, reminders: () => [], url: () => null });
  const host: flow.FlowHost = {
    model, tiles, tileCtx: ctx, showingTiles: () => tiled, inOpenedScreen: () => opened,
    leaveTiles: () => { tiled = false }, backToTiles: () => { backs++; tiled = true }, paint: () => { paints++ },
    isBlank: () => blank, wake: () => { wakes++; blank = false }, showingDesk: () => desk, deskInput: () => {},
    runTileEffect: (effect: TileEffect, source?: 'touch' | 'remote') => {
      sources.push(source); if (effect.kind === 'open') model.openTarget(effect.target, source);
    },
    runModelAction: action => { actions.push(action) }, saveLayout: () => {}, refreshTiles: () => {}, refreshTerminal: () => {}, now: () => time,
  };
  return { model, tiles, actions, sources, host, apply: flow.makeHandle(host),
    tick: (now: number) => { time = now }, setBlank: () => { blank = true }, setDesk: () => { desk = true }, setTiles: () => { tiled = true }, setOpened: () => { opened = true },
    wakes: () => wakes, backs: () => backs, paints: () => paints,
  };
}

test('flow defaults fail-closed touch; separate SDK hold stops and sends once', () => {
  const f = fixture(), hold = flow.makeHoldHandle(f.host);
  f.apply('select'); f.apply('select'); f.apply('select');
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic']);
  hold(f.model.agentHoldToken());
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic', 'stopMic']);
  f.model.setTranscript('intentional words', 1001, f.model.agentTranscriptToken());
  const send = f.model.agentHoldToken();
  hold(send); hold(send);
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic', 'stopMic', 'prompt']);
});

test('flow forwards deliberate remote source and preserves the inline select sequence', () => {
  const f = fixture();
  f.apply('select', 'remote'); f.apply('select', 'remote');
  f.model.setTranscript('remote words', 1001, f.model.agentTranscriptToken());
  assert.equal(f.model.screenKind, 'agent');
  f.apply('select', 'remote');
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic', 'stopMic', 'prompt']);
});

test('tile effect receives original source so remote Speak stays remote', () => {
  const f = fixture(); f.setTiles();
  f.tiles.input = () => ({ kind: 'open', target: { kind: 'agent', key: 'Dell/orchestrator', then: 'listen' } });
  f.apply('select', 'remote');
  assert.deepEqual(f.sources, ['remote']);
  assert.deepEqual(f.model.input('select', 1001, 'remote'), { kind: 'stopMic' });
  f.model.setTranscript('remote tile words', 1002, f.model.agentTranscriptToken());
  assert.equal(f.model.screenKind, 'agent');
});

test('hold never becomes a global Tiles or Desk input and a blank display only wakes', () => {
  for (const surface of ['blank', 'tiles', 'desk']) {
    const f = fixture(); f.apply('select');
    const token = f.model.agentHoldToken(), hold = flow.makeHoldHandle(f.host);
    if (surface === 'blank') f.setBlank();
    if (surface === 'tiles') f.setTiles();
    if (surface === 'desk') f.setDesk();
    hold(token);
    assert.deepEqual(f.actions.map(a => a.kind), ['startMic']);
    assert.equal(f.model.micWanted(), true);
    assert.equal(f.wakes(), surface === 'blank' ? 1 : 0);
  }
});

test('a queued old STOP token is inert after transcription opens SEND confirm', () => {
  const f = fixture(), hold = flow.makeHoldHandle(f.host);
  f.apply('select');
  const stop = f.model.agentHoldToken(); hold(stop);
  f.model.setTranscript('keep private', 1001, f.model.agentTranscriptToken());
  const deadline = f.model.agentConfirmDeadline();
  f.tick(2000); hold(stop);
  assert.equal(f.model.screenKind, 'confirm');
  assert.equal(f.model.agentConfirmDeadline(), deadline);
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic', 'stopMic']);
});

test('queued SEND hold past the privacy deadline cancels before any dispatch', () => {
  const f = fixture(), hold = flow.makeHoldHandle(f.host);
  f.apply('select'); hold(f.model.agentHoldToken());
  f.model.setTranscript('keep private', 1001, f.model.agentTranscriptToken());
  const send = f.model.agentHoldToken(); f.tick(21001); hold(send);
  assert.equal(f.model.screenKind, 'agent');
  assert.deepEqual(f.actions.map(a => a.kind), ['startMic', 'stopMic']);
  assert.ok(f.paints() > 0);
});

test('the hold STOP job is awaited by the input queue but prompt delivery remains background', async () => {
  const f = fixture(); let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve });
  f.host.runModelAction = action => { f.actions.push(action); return action.kind === 'stopMic' ? pending : undefined };
  const hold = flow.makeHoldHandle(f.host); f.apply('select');
  assert.equal(hold(f.model.agentHoldToken()), pending);
  finish(); await pending;
  f.model.setTranscript('intended words', 1001, f.model.agentTranscriptToken());
  assert.equal(hold(f.model.agentHoldToken()), undefined);
});

test('Back from an agent opened in Tiles clears the voice attempt before returning', () => {
  const f = fixture(); f.setOpened(); f.apply('select');
  assert.equal(f.model.micWanted(), true);
  f.apply('back');
  assert.equal(f.backs(), 1);
  assert.equal(f.model.micWanted(), false);
  assert.equal(f.model.agentHoldToken(), null);
});
