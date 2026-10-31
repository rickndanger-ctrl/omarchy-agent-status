import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModel, applySnapshot, selectNote, backToNewest, navigate, layoutText, formatTime, clockT,
  BOX_LINES, MAX_UPDATE_CHARS, type ListenSnapshot, type ListenModel } from '../src/model.ts';

const session = { id: 'fixture-listen', startedAt: 1_000_000 };
const snapshot = (changes: Partial<ListenSnapshot> = {}): ListenSnapshot => ({
  ...session, state: 'listening', now_t: 30_000,
  lines: [{ t: 0, text: 'Beginning' }, { t: 5_000, text: 'First anchor' }, { t: 10_000, text: 'Middle' },
    { t: 15_000, text: 'Second anchor' }, { t: 20_000, text: 'More conversation' }, { t: 30_000, text: 'Latest' }],
  notes: [{ t: 10_000, at_t: 5_000, text: 'First Muse note' }, { t: 20_000, at_t: 15_000, text: 'Second Muse note' }],
  muse: { state: 'idle' }, ...changes,
});
const populated = (): ListenModel => applySnapshot(createModel(session), snapshot());

test('session clock is explicit, nonnegative, and rolls over into hours', () => {
  assert.equal(clockT(session, session.startedAt + 65_999), 65_999);
  assert.equal(clockT(session, session.startedAt - 1), 0);
  assert.equal(clockT(session, Number.NaN), 0);
  for (const [ms, label] of [[0, '00:00'], [59_999, '00:59'], [60_000, '01:00'], [3_599_999, '59:59'],
    [3_600_000, '1:00:00'], [3_661_999, '1:01:01'], [7_200_000, '2:00:00']] as const) assert.equal(formatTime(ms), label);
  assert.equal(formatTime(-1), '00:00');
  assert.equal(formatTime(Infinity), '00:00');
});

test('empty model is ready; supplied session starts a visible listening clock', () => {
  assert.match(layoutText(createModel()).left, /^○ Ready 00:00/);
  const model = createModel(session);
  assert.match(layoutText(model, session.startedAt + 3_661_000).left, /^● Listening 1:01:01/);
  assert.match(layoutText(model).right, /^MUSE\nNo notes yet/);
});

test('down twice selects note two and jumps by at_t while labels use arrival t', () => {
  const model = selectNote(selectNote(populated(), 'down'), 'down');
  const view = layoutText(model);
  assert.equal(view.selectedNoteIndex, 1);
  assert.equal(view.transcriptAt, 15_000);
  assert.equal(view.transcriptIndex, 3);
  assert.match(view.right, /^MUSE\n> \[00:20\] Second Muse note/);
  assert.match(view.left, /^● Listening 00:30\n\[00:15\] Second anchor/);
});

test('up from newest selects last; navigation clamps at either endpoint', () => {
  let model = selectNote(populated(), 'up');
  assert.equal(layoutText(model).selectedNoteIndex, 1);
  assert.equal(selectNote(model, 'down'), model);
  model = selectNote(model, 'up');
  assert.equal(layoutText(model).selectedNoteIndex, 0);
  assert.equal(selectNote(model, 'up'), model);
  assert.equal(selectNote(createModel(), 'down').selectedNoteKey, null);
});

test('newest clears selection and returns to the latest timestamped records', () => {
  const model = backToNewest(selectNote(populated(), 'down'));
  const view = layoutText(model);
  assert.equal(view.selectedNoteIndex, null);
  assert.equal(view.transcriptAt, null);
  assert.match(view.left, /\[00:30\] Latest$/);
  assert.doesNotMatch(view.right, /^>/m);
  assert.equal(backToNewest(model), model);
  assert.equal(layoutText(navigate(navigate(populated(), 'next'), 'next')).selectedNoteIndex, 1);
  assert.equal(layoutText(navigate(model, 'newest')).selectedNoteIndex, null);
});

test('incremental snapshots merge, sort and deduplicate while preserving selected identity', () => {
  const selected = selectNote(selectNote(populated(), 'down'), 'down');
  const next = applySnapshot(selected, snapshot({ now_t: 40_000,
    lines: [{ t: 30_000, text: 'Latest' }, { t: 40_000, text: 'New latest' }],
    notes: [{ t: 1_000, at_t: 0, text: 'Late old note' }, { t: 20_000, at_t: 15_000, text: 'Second Muse note' },
      { t: 40_000, at_t: 30_000, text: 'New note' }],
  }));
  assert.equal(next.lines.length, 7);
  assert.equal(next.notes.length, 4);
  assert.equal(next.selectedNoteKey, selected.selectedNoteKey);
  assert.equal(layoutText(next).selectedNoteIndex, 2);
  assert.equal(layoutText(next).transcriptAt, 15_000);
});

test('distinct records with the same timestamp are retained', () => {
  const model = applySnapshot(createModel(session), snapshot({ lines: [{ t: 0, text: 'A' }, { t: 0, text: 'B' }],
    notes: [{ t: 1, at_t: 0, text: 'A' }, { t: 1, at_t: 0, text: 'B' }] }));
  assert.deepEqual(model.lines.map(line => line.text), ['A', 'B']);
  assert.equal(model.notes.length, 2);
});

test('a stale session response cannot mix history or restart a stopped session', () => {
  const model = populated();
  assert.equal(applySnapshot(model, snapshot({ id: 'different' })), model);
  assert.equal(applySnapshot(model, snapshot({ startedAt: session.startedAt + 1 })), model);
  const stopped = applySnapshot(model, snapshot({ state: 'stopped', now_t: 40_000, lines: [], notes: [] }));
  assert.match(layoutText(stopped, session.startedAt + 90_000).left, /^○ Stopped 00:40/);
  assert.equal(applySnapshot(stopped, snapshot()), stopped);
});

test('invalid records and empty or dash notes do not become display history', () => {
  const model = applySnapshot(createModel(session), snapshot({ lines: [{ t: -1, text: 'invalid' }, { t: 0, text: '' },
    { t: 2_000, text: 'Clean\ntext\tline' }], notes: [{ t: 2, at_t: 0, text: '—' }, { t: 2, at_t: 0, text: ' ' },
      { t: Number.NaN, at_t: 0, text: 'bad' }] }));
  assert.deepEqual(model.lines, [{ t: 2_000, text: 'Clean text line' }]);
  assert.equal(model.notes.length, 0);
  assert.equal(applySnapshot(model, snapshot({ now_t: Number.NaN })), model);
});

test('anchor floors to the prior transcript line, with safe earliest/latest boundaries', () => {
  for (const [anchor, index] of [[-1, null], [0, 0], [7_000, 1], [99_000, 5]] as const) {
    const model = applySnapshot(createModel(session), snapshot({ notes: [{ t: 100_000, at_t: anchor, text: 'Anchor' }] }));
    assert.equal(layoutText(selectNote(model, 'down')).transcriptIndex, index);
  }
  const noLines = applySnapshot(createModel(session), snapshot({ lines: [] }));
  assert.equal(layoutText(selectNote(noLines, 'down')).transcriptIndex, null);
});

test('long newest transcript and note retain timestamps instead of anonymous tail fragments', () => {
  const model = applySnapshot(createModel(session), snapshot({ lines: [{ t: 30_000, text: 'conversation '.repeat(200) }],
    notes: [{ t: 45_000, at_t: 30_000, text: 'note '.repeat(400) }] }));
  const view = layoutText(model);
  assert.match(view.left, /^● Listening 00:45\n\[00:30\]/);
  assert.match(view.right, /^MUSE\n\[00:45\]/);
  assert.match(view.left, /…$/);
  assert.ok(view.left.split('\n').length <= BOX_LINES);
  assert.ok(view.right.split('\n').length <= BOX_LINES);
});

test('realistic sentences wrap at word boundaries with punctuation attached; long tokens still fit', () => {
  const sentence = "We should share the final plan before tomorrow's meeting.";
  const model = selectNote(applySnapshot(createModel(session), snapshot({
    lines: [{ t: 5_000, text: sentence }], notes: [{ t: 20_000, at_t: 5_000, text: sentence }],
  })), 'down');
  const view = layoutText(model);
  for (const [text, prefix] of [[view.left, '[00:05]'], [view.right, '> [00:20]']] as const) {
    const rows = text.split('\n').slice(1);
    assert.equal(rows.join(' '), `${prefix} ${sentence}`);
    assert.ok(rows.every(row => row.length <= 27));
    assert.ok(rows.every(row => !/^[.,!?;:]+$/.test(row)));
  }
  const token = 'x'.repeat(70) + '👨‍👩‍👧‍👦';
  const long = layoutText(applySnapshot(createModel(session), snapshot({ lines: [{ t: 5_000, text: token }], notes: [] })));
  const rows = long.left.split('\n').slice(1);
  assert.equal(rows[0], '[00:05]');
  assert.equal(rows.slice(1).join(''), token);
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(long.left)), long.left);
});

test('selected long Unicode note stays highlighted, grapheme safe, bounded and listening visible', () => {
  const unicode = '👨‍👩‍👧‍👦 café e\u0301 漢字 '.repeat(100);
  const model = selectNote(applySnapshot(createModel(session), snapshot({
    lines: [{ t: 3_600_000, text: unicode }], notes: [{ t: 3_661_000, at_t: 3_600_000, text: unicode }], now_t: 3_661_000,
  })), 'down');
  const view = layoutText(model);
  assert.match(view.left, /^● Listening 1:01:01\n\[1:00:00\]/);
  assert.match(view.right, /^MUSE\n> \[1:01:01\]/);
  for (const text of [view.left, view.right]) {
    assert.ok(text.length <= MAX_UPDATE_CHARS);
    assert.ok(text.split('\n').length <= BOX_LINES);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(text)), text);
    for (const row of text.split('\n')) assert.ok(!row.endsWith('\u200d'), row);
  }
});

test('reducers and layout never mutate supplied model, session or snapshot', () => {
  const initial = createModel(session);
  const data = snapshot();
  const before = structuredClone({ initial, data, session });
  const merged = applySnapshot(initial, data);
  layoutText(selectNote(merged, 'down'), session.startedAt + 45_000);
  assert.deepEqual({ initial, data, session }, before);
  assert.notEqual(merged.lines[0], data.lines[0]);
  assert.notEqual(merged.notes[0], data.notes[0]);
});

test('model uses no implicit wall clock and keeps unavailable status visible', () => {
  const original = Date.now;
  Date.now = () => { throw new Error('no implicit clock'); };
  try {
    const model = applySnapshot(createModel(session), snapshot({ notes: [], muse: { state: 'unavailable', reason: 'No relay available' } }));
    const view = layoutText(model);
    assert.match(view.left, /^● Listening/);
    assert.match(view.right, /^MUSE · unavailable\nNo relay available/);
  } finally { Date.now = original; }
});
