import test from 'node:test';
import assert from 'node:assert/strict';
import { Tiles, TILE_LINES, TILE_WIDTH, PAGE_COUNT, DEFAULT_LAYOUT, availableWidgets, normalizeLayout, widgetFor } from '../src/tiles';
import type { TileContext } from '../src/tiles';
import type { HomeData } from '../src/model';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const data: HomeData = {
  now: NOW, paused: false, muse: true,
  machines: [{ name: 'Dell', online: true }],
  sessions: [{ agent: 'claude', name: 'Claude', session: 's1', state: 'working', page: 'p', at: 100, workspace: 'w', machine: 'Dell', pane: 'p1' }],
  pending: [{ id: 'p1', agent: 'Claude', page: 'p', tool: 'Bash', summary: 'git push origin main', at: 1, machine: 'Dell' }],
  messages: [{ id: 7, name: 'Mum', unread: true, when: 5, snippet: 'Call me', fromMe: false }],
};
const term = Array.from({ length: 30 }, (_, i) => `line ${i}`);
const ctx = (over: Partial<TileContext> = {}): TileContext => ({
  data, now: NOW, timeZone: 'UTC', terminal: () => term, chat: () => ['hi'], muse: () => ({ question: 'why', reply: 'because' }),
  reminders: () => [], url: () => null, ...over,
});

test('frame: titles on line 1, page indicator left, focus marker, size limits', () => {
  const t = new Tiles();
  let f = t.render(ctx());
  assert.equal(f.focus, 'page');
  assert.match(f.left.split('\n')[0], /^1\/5 Muse/);
  assert.match(f.right.split('\n')[0], /^Claude · busy/);
  t.input('select', ctx());
  f = t.render(ctx());
  assert.equal(f.focus, 'left');
  assert.match(f.left.split('\n')[0], /^> 1\/5 Muse/);
  for (const side of [f.left, f.right]) {
    const lines = side.split('\n');
    assert.ok(lines.length <= TILE_LINES);
    for (const l of lines) assert.ok(l.length <= TILE_WIDTH, l);
  }
});

test('page level: up/down change page and wrap, tap focuses, back exits', () => {
  const t = new Tiles();
  t.input('up', ctx());
  assert.equal(t.render(ctx()).page, PAGE_COUNT - 1);
  t.input('down', ctx());
  assert.equal(t.render(ctx()).page, 0);
  assert.deepEqual(t.input('back', ctx()), { kind: 'exit' });
});

test('tile level: open the action list, run an action, back to page', () => {
  const u = new Tiles();
  u.input('select', ctx()); u.input('select', ctx()); // menu on Muse
  const f = u.render(ctx());
  assert.match(f.left, /> Ask Muse/);
  assert.match(f.left, /Full screen/);
  assert.match(f.left, /Switch to other tile/);
  assert.deepEqual(u.input('select', ctx()), { kind: 'open', target: { kind: 'muse', then: 'listen' } });
  u.input('back', ctx());
  assert.equal(u.render(ctx()).focus, 'page');
});

test('agent tile follows the newest bottom lines and scrolls up', () => {
  const t = new Tiles();
  t.input('select', ctx());
  t.input('select', ctx()); t.input('down', ctx()); t.input('down', ctx()); t.input('select', ctx()); // Muse: switch tile
  assert.equal(t.render(ctx()).focus, 'right');
  assert.match(t.render(ctx()).right, /line 29/);
  t.input('up', ctx());
  assert.doesNotMatch(t.render(ctx()).right, /line 29/);
  assert.match(t.render(ctx()).right.split('\n')[0], /▲/);
});

test('approvals: the safe choice first, decide carries the pending id', () => {
  const w = widgetFor('approvals');
  assert.equal(w.actions(ctx())[0].id, 'desk');
  assert.deepEqual(w.act('allow', ctx()), { kind: 'action', action: { kind: 'decide', machine: 'Dell', id: 'p1', behavior: 'allow' } });
});

test('needs: visible page tiles ask for what they show', () => {
  const t = new Tiles();
  const needs = t.needs(ctx());
  assert.deepEqual(needs.map(n => n.kind), ['muse', 'terminal']);
});

test('chat:recent picks the newest thread; normalizeLayout repairs a bad layout', () => {
  assert.equal(widgetFor('chat:recent').title(ctx()), 'Mum');
  const l = normalizeLayout({ pages: [{ left: 'bogus', right: 'clock' }] });
  assert.equal(l.pages.length, PAGE_COUNT);
  assert.equal(l.pages[0].left, 'empty');
  assert.equal(l.pages[0].right, 'clock');
  assert.equal(normalizeLayout(null).pages.length, PAGE_COUNT);
  assert.equal(normalizeLayout(DEFAULT_LAYOUT).pages[0].right, 'agent:Dell/claude');
});

test('availableWidgets lists live agents and chats', () => {
  const ids = availableWidgets(data).map(w => w.id);
  assert.ok(ids.includes('agent:Dell/claude') && ids.includes('chat:7') && ids.includes('studio'));
});

test('every default widget renders within the tile size', () => {
  const t = new Tiles();
  for (let p = 0; p < PAGE_COUNT; p++) {
    const f = t.render(ctx({ data: null }));
    for (const s of [f.left, f.right]) { assert.ok(s.split('\n').length <= TILE_LINES); for (const l of s.split('\n')) assert.ok(l.length <= TILE_WIDTH, l); }
    t.input('down', ctx());
  }
});

test('a tile opens a full screen through the model', async () => {
  const { HomeModel } = await import('../src/model');
  const m = new HomeModel();
  m.update(data);
  assert.deepEqual(m.openTarget({ kind: 'chat', id: 7, name: 'Mum' }), { kind: 'loadChat', id: 7 });
  assert.equal(m.screenKind, 'chat');
  assert.equal(m.openTarget({ kind: 'agent', key: 'Dell/p1' }), null);
  assert.equal(m.screenKind, 'agent');
  assert.deepEqual(m.openTarget({ kind: 'muse' }), { kind: 'loadMuse' });
});

test('Edit page: pick left then right, the layout changes for that page only', () => {
  const t = new Tiles();
  t.startEdit(ctx());
  let f = t.render(ctx());
  assert.equal(f.focus, 'left');
  assert.match(f.left.split('\n')[0], /^> Pick left/);
  const ids = availableWidgets(data).map(o => o.id);
  t.input('down', ctx()); // muse -> messages
  t.input('select', ctx());
  assert.match(t.render(ctx()).right.split('\n')[0], /Pick right/);
  t.input('select', ctx()); // keep the right tile as it was
  assert.equal(t.render(ctx()).focus, 'page');
  const layout = t.takeEdited()!;
  assert.equal(layout.pages[0].left, ids[1]);
  assert.equal(layout.pages[0].right, 'agent:Dell/claude');
  assert.equal(layout.pages[1].left, 'chat:recent');
  assert.equal(t.takeEdited(), null);
});

test('Edit page can be cancelled with a double-tap', () => {
  const t = new Tiles();
  t.startEdit(ctx());
  t.input('back', ctx());
  assert.equal(t.takeEdited(), null);
  assert.equal(t.render(ctx()).focus, 'page');
});

test('Reminders: add by voice runs through listen and confirm, then asks the hub to add it', async () => {
  const { HomeModel } = await import('../src/model');
  const w = widgetFor('reminders');
  assert.deepEqual(w.act('add', ctx()), { kind: 'open', target: { kind: 'reminderAdd' } });
  const m = new HomeModel();
  m.update({ ...data, pending: [], voice: true });
  assert.deepEqual(m.openTarget({ kind: 'reminderAdd' }), { kind: 'startMic' });
  m.setTranscript('buy milk', NOW);
  assert.equal(m.screenKind, 'confirm');
  assert.match(m.render(NOW), /ADD REMINDER\?/);
  assert.deepEqual(m.input('select', NOW), { kind: 'addReminder', title: 'buy milk' });
  assert.equal(m.screenKind, 'home');
});
