// Mini 1 16:36: listening started from the Tiles Muse tile, then the screen left 'listen' by itself (no press). Reproduction with the real pieces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, type HomeData } from '../src/model';
import { Tiles } from '../src/tiles';
import type { TileContext } from '../src/tiles';
import { MuseCache } from '../src/musecache';
import { applyMuseLatest } from '../src/musesync';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = { now: NOW, paused: false, machines: [{ name: 'lap', online: true }], sessions: [], pending: [], messages: [], muse: true, voice: true };

test('Tiles Muse tile: ask by voice -> listen; a background Muse tile refresh and a /latest arriving do not change the screen', () => {
  const model = new HomeModel(); model.update(data);
  const tiles = new Tiles();
  const tileMuse = new MuseCache();
  const ctx = (): TileContext => ({ data, now: NOW, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => tileMuse.get(), reminders: () => [], url: () => null });
  // page 1 left is the Muse tile: select -> choose -> tile -> action list -> Ask Muse
  tiles.input('select', ctx());
  tiles.input('select', ctx());
  const effects: unknown[] = [];
  let r = tiles.input('select', ctx());
  if (r) effects.push(r);
  const f = tiles.render(ctx());
  assert.match(f.left, /Muse/);
  // find and run the 'ask' action
  for (let i = 0; i < 4 && !effects.length; i++) { r = tiles.input('select', ctx()); if (r) effects.push(r); else tiles.input('down', ctx()); }
  const open = effects.find((e): e is { kind: 'open'; target: never } => (e as { kind: string }).kind === 'open');
  assert.ok(open, JSON.stringify(effects));
  const action = model.openTarget((open as { target: never }).target);
  assert.deepEqual(action, { kind: 'startMic' });
  assert.equal(model.screenKind, 'listen');
  // the tile refresh (every 1.2 s) and a /latest arriving ~0.4 s into the listening
  const stamp = tileMuse.fetchStart();
  applyMuseLatest(model, tileMuse, stamp, { question: 'old q', reply: 'old answer' }, tileMuse.startRead());
  applyMuseLatest(model, tileMuse, tileMuse.fetchStart(), null, tileMuse.startRead());
  model.update(data); // a poll
  assert.equal(model.screenKind, 'listen', 'nothing in the background may move the screen off listen');
});

const openListenFromTile = () => {
  const model = new HomeModel(); model.update(data);
  const action = model.openTarget({ kind: 'muse', then: 'listen' } as never);
  assert.deepEqual(action, { kind: 'startMic' });
  return model;
};

test('listen -> stop -> confirm -> Send sends askMuse exactly once, background reads in between change nothing', () => {
  const model = openListenFromTile();
  const tile = new MuseCache();
  applyMuseLatest(model, tile, tile.fetchStart(), { question: 'q', reply: 'a' }, tile.startRead());
  model.update(data);
  assert.equal(model.screenKind, 'listen');
  assert.deepEqual(model.input('select', NOW), { kind: 'stopMic' });
  applyMuseLatest(model, tile, tile.fetchStart(), null, tile.startRead());
  assert.equal(model.screenKind, 'listen');
  model.setTranscript('what is on my calendar', NOW);
  assert.equal(model.screenKind, 'confirm');
  const send = model.input('select', NOW);
  assert.equal((send as { kind: string }).kind, 'askMuse');
  assert.equal((send as { text: string }).text, 'what is on my calendar');
  assert.notEqual((model.input('select', NOW + 10) as { kind: string } | null)?.kind, 'askMuse', 'a second tap never sends the same question again (it starts a new listening on the Muse screen)');
});

test('leaving listen any way stops the microphone: Back, Tiles/Desk taking over, a long-press menu choice that goes elsewhere', () => {
  const back = openListenFromTile();
  assert.equal(back.micWanted(), true);
  assert.deepEqual(back.input('back', NOW + 5000), { kind: 'cancelMic' });
  assert.equal(back.micWanted(), false);
  const tiles = openListenFromTile();
  assert.equal(tiles.abandonListen(), true, 'Tiles or the Desk taking the front');
  assert.equal(tiles.micWanted(), false);
  assert.equal(tiles.screenKind, 'muse');
  assert.equal(tiles.abandonListen(), false);
  // the menu cannot drop you out of listening (goTo is ignored there), so the mic stays wanted and open
  const menu = openListenFromTile();
  menu.goTo('home');
  assert.equal(menu.screenKind, 'listen');
  assert.equal(menu.micWanted(), true);
});

test('a Back within 0.5 s of starting to listen is ignored (the double-click of the same tap): the listening goes on; a later Back cancels', () => {
  const model = new HomeModel(); model.update(data);
  model.openTarget({ kind: 'muse' } as never);
  assert.deepEqual(model.input('select', NOW), { kind: 'startMic' });
  assert.equal(model.screenKind, 'listen');
  assert.equal(model.input('back', NOW + 340), null, 'the stray Back');
  assert.equal(model.screenKind, 'listen');
  assert.equal(model.micWanted(), true);
  assert.deepEqual(model.input('back', NOW + 3000), { kind: 'cancelMic' }, 'a real Back later still cancels');
  assert.equal(model.screenKind, 'muse');
  assert.equal(model.micWanted(), false);
  // the same Back right after the stop press (thinking) is ignored too; a tap that stops listening still works at any time
  const m2 = new HomeModel(); m2.update(data); m2.openTarget({ kind: 'muse' } as never);
  m2.input('select', NOW);
  assert.deepEqual(m2.input('select', NOW + 100), { kind: 'stopMic' });
});
