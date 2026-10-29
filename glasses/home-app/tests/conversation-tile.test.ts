import test from 'node:test';
import assert from 'node:assert/strict';
import { Tiles, widgetFor, normalizeLayout, availableWidgets } from '../src/tiles';
import type { TileContext } from '../src/tiles';
import type { ConvView } from '../src/conversation';

const NOW = Date.UTC(2026, 9, 29, 14, 32);
const base: ConvView = { phase: 'idle', elapsedMs: 0, hints: [], summary: [], actions: [], fallback: '', error: '', notice: '', skipped: 0, warning: '', id: '', stoppedAt: 0, sent: false };
const ctx = (v: Partial<ConvView> | null): TileContext => ({
  data: null, now: NOW, timeZone: 'UTC', terminal: () => null, chat: () => null, muse: () => null, reminders: () => null, url: () => null,
  conversation: () => (v === null ? null : { ...base, ...v }),
});
const w = widgetFor('conversation');
const layoutWith = () => normalizeLayout({ pages: [{ left: 'conversation', right: 'empty' }] });

test('the conversation id is known to layouts and the widget list', () => {
  assert.equal(layoutWith().pages[0].left, 'conversation');
  assert.ok(availableWidgets(null).some(o => o.id === 'conversation'));
});

test('header: Conversation, ● Listening mm:ss, Summarizing…, Summary · hh:mm', () => {
  assert.equal(w.title(ctx({})), 'Conversation');
  assert.equal(w.title(ctx({ phase: 'listening', elapsedMs: 724_000 })), '● Listening 12:04');
  assert.equal(w.title(ctx({ phase: 'summarizing' })), 'Summarizing…');
  assert.equal(w.title(ctx({ phase: 'stopping' })), 'Summarizing…');
  assert.match(w.title(ctx({ phase: 'done', stoppedAt: NOW })), /^Summary · \d\d:\d\d$/);
});

test('body: hints while listening, summary + action items when done, the fallback line, errors', () => {
  const listening = w.body(ctx({ phase: 'listening', hints: ['Ask about the budget'], fallback: "(local model: Claude didn't answer)" }), 27);
  assert.ok(listening.some(l => l.includes('Ask about the budget')));
  assert.ok(listening.join(' ').includes("(local model: Claude"));
  const done = w.body(ctx({ phase: 'done', summary: ['We agreed the plan.'], actions: ['Send the notes'], fallback: "(local model: Claude didn't answer)" }), 27);
  assert.ok(done.includes('Action items:'));
  assert.ok(done.some(l => l.includes('Send the notes')));
  assert.ok(done.join(' ').includes('local model'));
  assert.ok(w.body(ctx({ phase: 'error', error: 'The local model is not running' }), 27).join(' ').includes('not running'));
  for (const line of [...listening, ...done]) assert.ok(line.length <= 27, line);
  assert.match(w.body(ctx(null), 27).join(' '), /not available/);
});

test('tap: Start when idle or after an error, Stop while listening, the menu when done', () => {
  assert.deepEqual(w.tap!(ctx({})), { kind: 'conversation', op: 'start' });
  assert.deepEqual(w.tap!(ctx({ phase: 'error', error: 'x' })), { kind: 'conversation', op: 'start' });
  assert.deepEqual(w.tap!(ctx({ phase: 'listening' })), { kind: 'conversation', op: 'stop' });
  assert.equal(w.tap!(ctx({ phase: 'done' })), null);
  assert.equal(w.tap!(ctx({ phase: 'summarizing' })), null);
});

test('actions: Start new + Send summary to Muse when done; Sent to Muse greyed after; nothing to send while listening', () => {
  assert.deepEqual(w.actions(ctx({ phase: 'done', summary: ['x'] })).map(a => a.label), ['Start new', 'Send summary to Muse']);
  assert.deepEqual(w.actions(ctx({ phase: 'done', summary: ['x'], sent: true })).map(a => a.label), ['Start new', 'Sent to Muse']);
  assert.equal(w.act('sent', ctx({ phase: 'done', sent: true })), null);
  assert.equal(w.act('muse', ctx({ phase: 'done', sent: true })), null);
  assert.deepEqual(w.act('muse', ctx({ phase: 'done' })), { kind: 'conversation', op: 'sendMuse' });
  assert.equal(w.act('muse', ctx({ phase: 'listening' })), null);
  assert.equal(w.act('muse', ctx({ phase: 'idle' })), null);
  assert.deepEqual(w.actions(ctx({ phase: 'listening' })).map(a => a.label), ['Stop listening']);
});

test('in the Tiles model: a tap on an idle conversation tile starts; on a done one it opens the menu', () => {
  const t = new Tiles();
  t.setLayout(layoutWith());
  let c = ctx({});
  t.input('select', c); // page -> choose
  t.input('select', c); // choose -> tile
  assert.deepEqual(t.input('select', c), { kind: 'conversation', op: 'start' });
  c = ctx({ phase: 'listening' });
  assert.deepEqual(t.input('select', c), { kind: 'conversation', op: 'stop' });
  c = ctx({ phase: 'done', summary: ['x'] });
  assert.equal(t.input('select', c), null); // menu opened
  assert.match(t.render(c).left, /> Start new/);
  t.input('down', c);
  assert.deepEqual(t.input('select', c), { kind: 'conversation', op: 'sendMuse' });
});

test('the tile says how many pieces were missed, and keeps the microphone warning', () => {
  assert.ok(w.body(ctx({ phase: 'listening', skipped: 2 }), 27).includes('2 pieces missed'));
  assert.ok(w.body(ctx({ phase: 'done', summary: ['x'], skipped: 1 }), 27).includes('1 piece missed'));
  assert.ok(!w.body(ctx({ phase: 'listening' }), 27).join(' ').includes('missed'));
  const lines = w.body(ctx({ phase: 'done', summary: ['x'], warning: 'Microphone may still be on: close the app' }), 27);
  assert.ok(lines.join(' ').includes('Microphone may still be on'));
  for (const l of lines) assert.ok(l.length <= 27, l);
});
