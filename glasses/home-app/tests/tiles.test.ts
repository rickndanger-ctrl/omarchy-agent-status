import test from 'node:test';
import assert from 'node:assert/strict';
import { resetAgentMemory, sortReminders, Tiles, TILE_LINES, TILE_WIDTH, PAGE_COUNT, DEFAULT_LAYOUT, availableWidgets, normalizeLayout, widgetFor } from '../src/tiles';
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
  t.input('select', ctx()); // page -> choose
  f = t.render(ctx());
  assert.equal(f.focus, 'choose-left');
  assert.match(f.left.split('\n')[0], /^> 1\/5 Muse/);
  t.input('select', ctx()); // choose -> tile
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
  u.input('select', ctx()); u.input('select', ctx()); u.input('select', ctx()); // choose, tile, menu on Muse
  const f = u.render(ctx());
  assert.match(f.left, /> Ask Muse/);
  assert.match(f.left, /Full screen/);
  assert.doesNotMatch(f.left, /Switch to other tile/);
  assert.deepEqual(u.input('select', ctx()), { kind: 'open', target: { kind: 'muse', then: 'listen' } });
  u.input('back', ctx()); // tile -> choose (same side)
  assert.equal(u.render(ctx()).focus, 'choose-left');
  u.input('back', ctx()); // choose -> page
  assert.equal(u.render(ctx()).focus, 'page');
});

test('agent tile follows the newest bottom lines and scrolls up', () => {
  const t = new Tiles();
  t.input('select', ctx()); t.input('down', ctx()); t.input('select', ctx()); // choose the right tile, enter it
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

test('agent tile prefers a live pane over a newer finished rollout', () => {
  const rollout = { agent: 'claude', name: 'Claude', session: 'old', state: 'done', page: 'p', at: 900, workspace: 'w', machine: 'Dell' };
  const pane = { agent: 'claude', name: 'Claude', session: 'live', state: 'working', page: 'p', at: 100, workspace: 'w', machine: 'Dell', pane: 'p9' };
  const c = ctx({ data: { ...data, sessions: [rollout, pane] } });
  assert.deepEqual(widgetFor('agent:Dell/claude').needs(c).map(n => n.kind === 'terminal' && n.pane), ['p9']);
  const newerPane = { ...pane, session: 'live2', pane: 'p10', at: 200 };
  const c2 = ctx({ data: { ...data, sessions: [rollout, pane, newerPane] } });
  assert.deepEqual(widgetFor('agent:Dell/claude').needs(c2).map(n => n.kind === 'terminal' && n.pane), ['p10']);
});

test('reminders: due soon first, then newest added, then the rest; Reminders list wins ties', () => {
  const H = 3600_000;
  const r = (id: string, over: object = {}) => ({ id, title: id, due: null, list: 'Reminders', ...over });
  const list = [
    r('plain'), r('old', { added: 1 }), r('new', { added: 9 }), r('later', { dueAt: NOW + 30 * H }),
    r('overdue', { dueAt: NOW - H }), r('soon', { dueAt: NOW + 2 * H }), r('otherlist', { list: 'Errands' }),
  ];
  assert.deepEqual(sortReminders(list, NOW).map(x => x.id), ['overdue', 'soon', 'new', 'old', 'plain', 'later', 'otherlist']);
});

test('reminders tile shows the list name only when it is not Reminders, and Added: for a fresh add', () => {
  const list = [{ id: 'a', title: 'Milk', due: null, list: 'Reminders' }, { id: 'b', title: 'Bin', due: null, list: 'Errands' }];
  const w = widgetFor('reminders');
  const body = w.body(ctx({ reminders: () => list }), 27);
  assert.deepEqual(body, ['• Milk', '• Bin · Errands']);
  const withNote = [{ id: 'just-added', title: 'Eggs', due: null, list: '', added: NOW - 1000 }, ...list];
  assert.deepEqual(w.body(ctx({ reminders: () => withNote }), 27).slice(0, 2), ['Added: Eggs', '']);
  const stale = [{ id: 'just-added', title: 'Eggs', due: null, list: '', added: NOW - 6000 }, ...list];
  assert.deepEqual(w.body(ctx({ reminders: () => stale }), 27), ['• Milk', '• Bin · Errands']);
});

// ---- pinned agent tiles (0.4.2) ----
const sess = (over: object) => ({ agent: 'claude', name: 'Claude', session: 's', state: 'idle', page: 'proj', at: 100, workspace: 'w', machine: 'Dell', ...over });
const pinned = (sessions: object[], now = NOW) => ({ c: ctx({ data: { ...data, sessions: sessions as HomeData['sessions'] }, now }) });
const target = (c: ReturnType<typeof ctx>, id: string) => widgetFor(id).needs(c).map(n => (n.kind === 'terminal' ? n.window || n.pane || n.appThread : null));

test('pinned agent: the exact window wins, and wins again when it comes back', () => {
  resetAgentMemory();
  const id = 'agent:Dell/0xAA';
  const win = sess({ window: '0xAA', state: 'idle', at: 1 });
  const other = sess({ window: '0xBB', state: 'working', at: 999 });
  assert.deepEqual(target(pinned([win, other]).c, id), ['0xAA']);
  assert.deepEqual(target(pinned([other]).c, id), ['0xBB']);
  assert.deepEqual(target(pinned([win, other]).c, id), ['0xAA']);
});

test('pinned agent: after the window closes a working Claude beats a newer idle one', () => {
  resetAgentMemory();
  const id = 'agent:Dell/0xAA';
  target(pinned([sess({ window: '0xAA' })]).c, id); // seen once
  const idleNewer = sess({ window: '0xCC', state: 'idle', at: 500 });
  const working = sess({ window: '0xDD', state: 'working', at: 50 });
  assert.deepEqual(target(pinned([idleNewer, working]).c, id), ['0xDD']);
});

test('pinned agent: a window or pane beats an app thread', () => {
  resetAgentMemory();
  const thread = sess({ appThread: 'thr1', state: 'working', at: 900 });
  const window = sess({ window: '0xEE', state: 'working', at: 10 });
  assert.deepEqual(target(pinned([thread, window]).c, 'agent:Dell/0xAA'), ['0xEE']);
});

test('pinned agent: the kind is remembered, so a pinned codex falls back to codex', () => {
  resetAgentMemory();
  const id = 'agent:Dell/0xCX';
  target(pinned([sess({ agent: 'codex', name: 'Codex', window: '0xCX' })]).c, id);
  const claude = sess({ window: '0xAA', state: 'working', at: 999 });
  const codex = sess({ agent: 'codex', name: 'Codex', window: '0xCY', state: 'idle', at: 1 });
  assert.deepEqual(target(pinned([claude, codex]).c, id), ['0xCY']);
});

test('pinned agent: "(moved to <page>)" shows for 60 s from the move, then the plain title', () => {
  resetAgentMemory();
  const id = 'agent:Dell/0xAA';
  const w = widgetFor(id);
  w.title(pinned([sess({ window: '0xAA' })]).c);
  const other = sess({ window: '0xBB', state: 'working', page: 'other-proj' });
  assert.match(w.title(pinned([other], NOW).c), /^Claude · busy \(moved to other-proj\)$/);
  assert.match(w.title(pinned([other], NOW + 59_000).c), /moved to other-proj/);
  assert.equal(w.title(pinned([other], NOW + 61_000).c), 'Claude · busy');
});

test('a plain agent name keeps the 0.4.1 behaviour and never says moved', () => {
  resetAgentMemory();
  const old = sess({ window: '0xOLD', at: 1 });
  const pane = sess({ pane: 'p7', at: 0 });
  const c = pinned([old, pane]).c;
  assert.deepEqual(target(c, 'agent:Dell/claude'), ['p7']);
  assert.doesNotMatch(widgetFor('agent:Dell/claude').title(c), /moved/);
});

test('editor lists each live window and pane with its page and machine', () => {
  const labels = availableWidgets({ ...data, sessions: [sess({ window: '0xAA', page: 're-studio' }), sess({ pane: 'p2', page: 'api', machine: 'Mini 1', at: 5 }), sess({ session: 'roll', page: 'old' })] as HomeData['sessions'] });
  assert.ok(labels.some(l => l.id === 'agent:Dell/0xAA' && l.label === 'Claude · re-studio (Dell)'));
  assert.ok(labels.some(l => l.id === 'agent:Mini 1/p2' && l.label === 'Claude · api (Mini 1)'));
  assert.ok(!labels.some(l => l.label.includes('(Dell)') && l.label.includes('old')));
});

// ---- Muse tile (relay noise, long replies, stale fetches) ----
test('Muse: a reply tailed with relay chrome and blanks still shows the answer', async () => {
  const { museDisplay } = await import('../src/model');
  const noisy = "Yep, I'm getting them\n\n\nMuse\nConnected\n\nApprovals history…\n\n";
  assert.deepEqual(museDisplay('are you getting my texts?', noisy), { question: 'are you getting my texts?', reply: "Yep, I'm getting them" });
  assert.equal(museDisplay('q', 'one\n\n\n\ntwo').reply, 'one\n\ntwo');
  const body = widgetFor('muse').body(ctx({ muse: () => ({ question: 'are you getting my texts?', reply: noisy }) }), 27);
  assert.ok(body.join('\n').includes("Yep, I'm getting them"));
  assert.ok(!body.join('\n').includes('Connected'));
  // the full-screen Muse page uses the same trim
  const { HomeModel } = await import('../src/model');
  const m = new HomeModel();
  m.update({ ...data, pending: [] });
  m.setMuse({ question: 'q', reply: noisy });
  m.goTo('muse');
  m.setMuse({ question: 'q', reply: noisy });
  assert.match(m.render(NOW), /Yep, I'm getting them/);
  assert.doesNotMatch(m.render(NOW), /Connected/);
});

test('Muse tile: a long reply shows its start right under the question, and swipe scrolls', () => {
  const reply = Array.from({ length: 30 }, (_, i) => `answer line ${i}`).join('\n');
  const c = ctx({ muse: () => ({ question: 'a very long question that wraps around the tile and then some more words', reply }) });
  const body = widgetFor('muse').body(c, 27);
  assert.equal(body.length > 8, true);
  assert.ok(body[0].startsWith('You:'));
  assert.equal(body[2], '');
  assert.equal(body[3], 'answer line 0');
  assert.match(body[1], /…$/);
  const t = new Tiles();
  t.input('select', c); t.input('select', c);
  const frame = t.render(c).left.split('\n');
  assert.equal(frame[4], 'answer line 0'); // title, then question, blank, answer: not scrolled to the end
  t.input('down', c); t.input('down', c); // scroll later text
  assert.notEqual(t.render(c).left.split('\n')[1], frame[1]);
});

test('Muse tile: shows "Muse is thinking…" while an ask is in flight', async () => {
  const { MuseCache } = await import('../src/musecache');
  const cache = new MuseCache();
  cache.askStart('what now?');
  assert.deepEqual(widgetFor('muse').body(ctx({ muse: () => cache.get() }), 27), ['You: what now?', '', 'Muse is thinking…']);
});

test('Muse: a fetch that started before an ask never overwrites the newer reply', async () => {
  const { MuseCache } = await import('../src/musecache');
  const cache = new MuseCache();
  const stamp = cache.fetchStart()!;               // timed page fetch begins
  cache.askStart('new question');                  // the owner asks meanwhile
  cache.askReply('new question', 'new answer');
  cache.askEnd();
  cache.fetchDone(stamp, { question: 'old', reply: 'old answer' }); // the stale fetch lands
  assert.deepEqual(cache.get(), { question: 'new question', reply: 'new answer' });
  // while asking, no page fetch starts at all
  cache.askStart('again');
  assert.equal(cache.fetchStart(), null);
  // after the ask, a fresh fetch is accepted again
  cache.askReply('again', 'ok'); cache.askEnd();
  const s2 = cache.fetchStart()!;
  cache.fetchDone(s2, { question: 'q2', reply: 'a2' });
  assert.equal(cache.get()!.reply, 'a2');
});

test('Muse: one /api/muse read per page view, none after an ask', async () => {
  const { MuseCache } = await import('../src/musecache');
  const cache = new MuseCache();
  assert.equal(cache.pageFetchStart(0), 0);        // first view of the page: read once
  assert.equal(cache.pageFetchStart(0), null);     // the next timed refresh: no read
  assert.notEqual(cache.pageFetchStart(1), null);  // swiped to another page: read again
  cache.askStart('q');
  assert.equal(cache.pageFetchStart(2), null);     // asking: no read, but the page counts as read
  cache.askReply('q', 'a'); cache.askEnd();
  assert.equal(cache.pageFetchStart(2), null);     // so nothing is read after the ask either
  cache.resetPage();                               // entering Tiles again
  assert.notEqual(cache.pageFetchStart(2), null);
});

test('3 levels: every transition', () => {
  const t = new Tiles();
  const focus = () => t.render(ctx()).focus;
  assert.equal(focus(), 'page');
  t.input('select', ctx()); assert.equal(focus(), 'choose-left');   // PAGE tap -> CHOOSE
  t.input('down', ctx()); assert.equal(focus(), 'choose-right');    // either swipe toggles
  t.input('down', ctx()); assert.equal(focus(), 'choose-left');
  t.input('up', ctx()); assert.equal(focus(), 'choose-right');
  t.input('up', ctx()); assert.equal(focus(), 'choose-left');
  t.input('down', ctx());
  t.input('select', ctx()); assert.equal(focus(), 'right');         // CHOOSE tap -> TILE
  t.input('back', ctx()); assert.equal(focus(), 'choose-right');    // TILE dbl-tap -> CHOOSE, same side
  t.input('back', ctx()); assert.equal(focus(), 'page');            // CHOOSE dbl-tap -> PAGE
  assert.deepEqual(t.input('back', ctx()), { kind: 'exit' });       // PAGE dbl-tap -> exit
});

test('3 levels: the choose header shows the page and the highlighted side', () => {
  const t = new Tiles();
  t.input('select', ctx());
  let f = t.render(ctx());
  assert.match(f.left.split('\n')[0], /^> 1\/5 /);
  assert.doesNotMatch(f.right.split('\n')[0], /^>/);
  t.input('up', ctx());
  f = t.render(ctx());
  assert.doesNotMatch(f.left.split('\n')[0], /^>/);
  assert.match(f.left.split('\n')[0], /^1\/5 /);
  assert.match(f.right.split('\n')[0], /^> /);
});

test('3 levels: the highlighted side is remembered per page', () => {
  const t = new Tiles();
  t.input('select', ctx()); t.input('down', ctx()); // page 1: right
  t.input('back', ctx());
  t.input('down', ctx());                           // page 2
  t.input('select', ctx());
  assert.equal(t.render(ctx()).focus, 'choose-left'); // never highlighted there: left
  t.input('back', ctx());
  t.input('up', ctx());                             // back to page 1
  t.input('select', ctx());
  assert.equal(t.render(ctx()).focus, 'choose-right');
  t.input('select', ctx()); t.input('back', ctx());  // via a tile
  t.input('back', ctx()); t.input('down', ctx()); t.input('up', ctx());
  t.input('select', ctx());
  assert.equal(t.render(ctx()).focus, 'choose-right');
});

test('3 levels: no swipe is swallowed on a page or in choose; tiles scroll when there is more', () => {
  const t = new Tiles();
  for (const dir of ['up', 'down'] as const) {
    const before = JSON.stringify(t.render(ctx()));
    t.input(dir, ctx());
    assert.notEqual(JSON.stringify(t.render(ctx())), before, `page ${dir}`);
  }
  t.input('select', ctx());
  for (const dir of ['up', 'down'] as const) {
    const before = JSON.stringify(t.render(ctx()));
    t.input(dir, ctx());
    assert.notEqual(JSON.stringify(t.render(ctx())), before, `choose ${dir}`);
  }
  t.input('down', ctx()); // highlight the right tile
  t.input('select', ctx()); // the agent tile has 30 lines
  const before = JSON.stringify(t.render(ctx()));
  t.input('up', ctx());
  assert.notEqual(JSON.stringify(t.render(ctx())), before, 'tile up');
  t.input('down', ctx());
  assert.equal(JSON.stringify(t.render(ctx())), before, 'tile down returns');
});

test('3 levels: the tile action list has no Switch to other tile, and back closes it first', () => {
  const t = new Tiles();
  t.input('select', ctx()); t.input('select', ctx()); t.input('select', ctx());
  assert.doesNotMatch(t.render(ctx()).left, /Switch/);
  t.input('back', ctx()); // closes the list, stays on the tile
  assert.equal(t.render(ctx()).focus, 'left');
});

test('orchestrator tile: the read view of the laptop session, replies go to it, no Escape; laptop down says laptop offline', () => {
  const orch = { agent: 'claude', name: 'Orchestrator', session: 'orchestrator', state: 'working', page: 'Orchestrator', at: 100, workspace: '', machine: 'Dell', pane: 'orchestrator', tmux: 'orchestrator' };
  const up: HomeData = { ...data, sessions: [...data.sessions, orch] };
  const w = widgetFor('orchestrator');
  const c = ctx({ data: up, terminal: key => (key === 'Dell/orchestrator' ? ['Release is ready.'] : null) });
  assert.match(w.title(c), /^Orchestrator · busy/);
  assert.deepEqual(w.body(c, 27), ['Release is ready.']);
  assert.deepEqual(w.actions(c).map(a => a.id), ['listen', 'reply', 'continue'], 'no Stop (Esc)');
  assert.deepEqual(w.act('listen', c), { kind: 'open', target: { kind: 'agent', key: 'Dell/orchestrator', then: 'listen' } });
  assert.deepEqual(w.act('continue', c), { kind: 'action', action: { kind: 'prompt', machine: 'Dell', pane: 'orchestrator', text: 'Continue' } });
  assert.equal(w.act('esc', c), null);
  assert.deepEqual(w.needs(c), [{ kind: 'terminal', machine: 'Dell', pane: 'orchestrator', key: 'Dell/orchestrator' }]);
  assert.equal(normalizeLayout({ pages: Array.from({ length: PAGE_COUNT }, () => ({ left: 'orchestrator', right: 'empty' })) }).pages[0].left, 'orchestrator');
  assert.ok(availableWidgets(up).some(x => x.id === 'orchestrator'));
  // the laptop is down: no session, and the tile says why
  const down = ctx({ data: { ...data, machines: [{ name: 'Dell', online: false }], sessions: [] } });
  assert.deepEqual(w.body(down, 27), ['laptop offline']);
  const up2 = ctx({ data: { ...data, sessions: [] } });
  assert.deepEqual(w.body(up2, 27), ['Orchestrator is not running.']);
});

test('orchestrator tile: after a reply the title says sent to Claude for a few seconds (Continue from the tile too)', () => {
  const orch = { agent: 'claude', name: 'Orchestrator', session: 'orchestrator', state: 'idle', page: 'Orchestrator', at: 100, workspace: '', machine: 'Dell', pane: 'orchestrator', tmux: 'orchestrator' };
  const up: HomeData = { ...data, sessions: [orch] };
  const w = widgetFor('orchestrator');
  assert.match(w.title(ctx({ data: up })), /^Orchestrator/);
  let note: string | null = 'sent to Claude';
  assert.equal(w.title(ctx({ data: up, sent: pane => (pane === 'orchestrator' ? note : null) })), 'sent to Claude');
  note = null;
  assert.match(w.title(ctx({ data: up, sent: () => note })), /^Orchestrator/);
});
