// Pinned agents on Home: rows from the same sessions the Agents page uses, the full-screen terminal view, and Quiet mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSession } from '../src/tiles.ts';
import { HomeModel, WIDTH, type HomeData, type Pin, type Session } from '../src/model.ts';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const PINS: Pin[] = [
  { label: 'Claude · Mini 1', machine: 'Mini 1', agent: 'claude', session: 'g2-claude' },
  { label: 'Codex · Mini 1', machine: 'Mini 1', agent: 'codex', session: 'g2-codex' },
  { label: 'Claude · Mini 2', machine: 'Mini 2', agent: 'claude', session: 'g2-claude' },
  { label: 'Codex · Mini 2', machine: 'Mini 2', agent: 'codex', session: 'g2-codex' },
  { label: 'Claude · Neo', machine: 'Neo', agent: 'claude', session: 'g2-claude' },
  { label: 'Codex · Neo', machine: 'Neo', agent: 'codex', session: 'g2-codex' },
  { label: 'Claude · Dell', machine: 'Dell', agent: 'claude', session: 'tile' },
];
const sess = (machine: string, agent: string, state: string, over: Partial<Session> = {}): Session =>
  ({ agent, name: agent === 'claude' ? 'Claude' : 'Codex', session: `tmux%${machine}${agent}`, state, page: 'proj', at: NOW / 1000 - 60, workspace: '', machine, pane: `%${machine}${agent}`, tmux: `g2-${agent}`, ...over });
const data = (over: Partial<HomeData> = {}): HomeData => ({
  now: NOW, paused: false,
  machines: ['Mini 1', 'Mini 2', 'Neo', 'Dell'].map(name => ({ name, online: true })),
  sessions: [sess('Mini 1', 'claude', 'working'), sess('Mini 1', 'codex', 'idle'), sess('Mini 2', 'claude', 'attention'), sess('Neo', 'codex', 'done')],
  pending: [], messages: null, muse: false, pinned: PINS, ...over,
});
/** Move the Home cursor down until a row matching `re` is on screen. */
function reveal(m: HomeModel, re: RegExp): string {
  for (let i = 0; i < 25; i++) { const t = m.render(NOW); if (re.test(t)) return t; m.input('down', NOW); }
  return m.render(NOW);
}
const lines = (m: HomeModel) => m.render(NOW).split('\n');

test('Home: one row per pin with the bar symbol and the bar words, then the normal rows, All agents last', () => {
  const m = new HomeModel();
  m.update(data());
  const text = m.render(NOW);
  const rows = text.split('\n');
  assert.match(text, /> • Claude · Mini 1 · busy/);
  assert.match(text, / · Codex · Mini 1 · ready/);
  assert.match(text, /! Claude · Mini 2 · needs you/);
  assert.doesNotMatch(text, /Agents · \d+ on/, 'the old Agents row is gone');
  assert.ok(rows.length <= 10, `${rows.length} lines`);
  for (const l of rows) assert.ok(l.length <= WIDTH, l);
  // walk the whole list: pins in the configured order, All agents last
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) { for (const l of lines(m)) if (l.startsWith('>')) { if (seen.at(-1) !== l) seen.push(l); } m.input('down', NOW); }
  const labels = seen.map(l => l.slice(2));
  assert.deepEqual(labels.slice(0, 7).map(l => l.replace(/^\S+ /, '').split(' · ').slice(0, 2).join(' · ')), PINS.map(p => p.label));
  assert.match(labels.at(-1)!, /^All agents · 4 on 4 computers/);
  assert.ok(labels.findIndex(l => /^Settings/.test(l)) > 6, 'the normal rows come after the pins');
});

test('a pin on an offline computer shows offline, with no session on an online one not running; neither opens anything', () => {
  const m = new HomeModel();
  m.update(data({ machines: [{ name: 'Mini 1', online: true }, { name: 'Mini 2', online: false }, { name: 'Neo', online: true }, { name: 'Dell', online: true }] }));
  const text = m.render(NOW);
  assert.match(text, /· Claude · Mini 2 · offline/, 'its computer is offline (not "not running")');
  for (let i = 0; i < 6; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /> · Claude · Dell · not running/, 'Dell is up but has no such session');
  assert.equal(m.input('select', NOW), null);
  assert.equal(m.screenKind, 'home');
});

test('two Claude sessions on Mini 1 (claude and g2-claude): the pin opens g2-claude, never the other', () => {
  const m = new HomeModel();
  m.update(data({ sessions: [sess('Mini 1', 'claude', 'attention', { tmux: 'claude', pane: '%9', session: 'tmux%9' }), sess('Mini 1', 'claude', 'idle', { tmux: 'g2-claude', pane: '%2', session: 'tmux%2' })] }));
  assert.equal(m.pinSession(PINS[0])?.session, 'tmux%2');
  assert.match(m.render(NOW), /> · Claude · Mini 1 · ready/, 'the row shows the pinned session\'s state, not the busier one\'s');
  m.input('select', NOW);
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /^CLAUDE · Mini 1/);
  assert.equal(m.terminalTarget()?.pane, '%2');
});

test('only a differently named Claude session on that computer: the pin says not running and opens nothing', () => {
  const m = new HomeModel();
  m.update(data({ sessions: [sess('Mini 1', 'claude', 'working', { tmux: 'claude', pane: '%9', session: 'tmux%9' }), sess('Mini 1', 'claude', 'idle', { tmux: undefined, pane: '%8', session: 'tmux%8' })] }));
  assert.equal(m.pinSession(PINS[0]), undefined);
  assert.match(m.render(NOW), /> · Claude · Mini 1 · not running/);
  assert.equal(m.input('select', NOW), null);
  assert.equal(m.screenKind, 'home');
  assert.match(m.render(NOW), /· Claude · Mini 2 · not running/, 'a computer that is up with no sessions at all');
});

test('without a pin list (an older hub) Home keeps the Agents row', () => {
  const m = new HomeModel();
  m.update(data({ pinned: undefined }));
  assert.match(m.render(NOW), /> Agents · 4 on 4 computers/);
  assert.doesNotMatch(m.render(NOW), /All agents/);
});

test('the big view is the header line plus 9 lines of terminal: 10 lines, no hint, no auto-scroll', () => {
  const m = new HomeModel();
  m.update(data());
  m.input('select', NOW); // Claude · Mini 1
  const key = 'Mini 1/%Mini 1claude';
  m.setTerminal(key, Array.from({ length: 40 }, (_, i) => `out ${i + 1}`));
  const v = lines(m);
  assert.equal(v.length, 10);
  assert.match(v[0], /^CLAUDE · Mini 1/);
  assert.deepEqual(v.slice(1), Array.from({ length: 9 }, (_, i) => `out ${32 + i}`));
  assert.doesNotMatch(v.join('\n'), /swipe|tap:/);
  m.input('up', NOW); // scrolls back by 3, still 10 lines
  const s = lines(m);
  assert.equal(s.length, 10);
  assert.equal(s[1], 'out 30');
  assert.ok(s.every(l => l.length <= WIDTH + 20));
  m.input('down', NOW);
  assert.equal(lines(m)[9], 'out 40', 'back at the bottom');
});

const approval = (machine: string, agent: string) => ({ id: `${machine}${agent}`, agent, page: 'proj', tool: 'Bash', summary: 'ls', at: NOW, machine });

test('Quiet mode (default on): a pinned agent\'s approval pops, another agent\'s does not but stays in Needs you', () => {
  const m = new HomeModel();
  assert.equal(m.quiet, true);
  m.update(data());
  m.update(data({ pending: [approval('Mini 1', 'hermes')] }));
  assert.equal(m.screenKind, 'home', 'not pinned: no pop-up');
  assert.match(reveal(m, /Needs you/), /! Needs you · 1/, 'but it is still waiting in the list');
  m.update(data({ pending: [approval('Mini 1', 'hermes'), approval('Mini 2', 'claude')] }));
  assert.equal(m.screenKind, 'approval', 'pinned: pops');
});

test('Quiet mode: a pinned agent finishing or needing you pops; an unpinned one does not; texts never pop', () => {
  const unpinned = (state: string) => sess('Mini 1', 'hermes', state, { pane: '%h', session: 'tmux%h', tmux: 'x' });
  const m = new HomeModel();
  m.update(data({ sessions: [unpinned('working')], messages: [{ id: 1, name: 'Ann', unread: false, when: NOW - 1000, snippet: 'hi', fromMe: false }] }));
  m.update(data({ sessions: [unpinned('done')], messages: [{ id: 1, name: 'Ann', unread: true, when: NOW, snippet: 'new', fromMe: false }] }));
  assert.equal(m.screenKind, 'home', 'neither the other agent finishing nor a text pops');
  assert.match(reveal(m, /Messages/), /Messages · 1 new/, 'texts stay in their list');
  const p = new HomeModel();
  p.update(data({ sessions: [sess('Mini 1', 'claude', 'working')] }));
  p.update(data({ sessions: [sess('Mini 1', 'claude', 'done')] }));
  assert.equal(p.screenKind, 'alert');
  assert.match(p.render(NOW), /DONE · Claude · Mini 1/);
  const n = new HomeModel();
  n.update(data({ sessions: [sess('Neo', 'codex', 'working')] }));
  n.update(data({ sessions: [sess('Neo', 'codex', 'attention')] }));
  assert.equal(n.screenKind, 'alert');
  assert.match(n.render(NOW), /NEEDS YOU/);
});

test('Quiet mode off: everything pops as today', () => {
  const m = new HomeModel();
  m.quiet = false;
  m.update(data());
  m.update(data({ pending: [approval('Mini 1', 'hermes')] }));
  assert.equal(m.screenKind, 'approval');
  const t = new HomeModel();
  t.quiet = false;
  t.update(data({ messages: [{ id: 1, name: 'Ann', unread: false, when: NOW - 1000, snippet: 'hi', fromMe: false }] }));
  t.update(data({ messages: [{ id: 1, name: 'Ann', unread: true, when: NOW, snippet: 'new', fromMe: false }] }));
  assert.equal(t.screenKind, 'alert');
});

test('a pin whose computer is not in the machine list at all shows offline; the row glyphs are the ones the glasses font has', () => {
  const m = new HomeModel();
  m.update(data({ machines: [{ name: 'Mini 1', online: true }] }));
  const t = reveal(m, /Claude · Dell/);
  assert.match(t, /· Claude · Dell · offline/);
  assert.match(t, /· Claude · Neo · offline/);
  for (const ch of '●○✓') assert.ok(!m.render(NOW).includes(ch), `${ch} is not drawn by the glasses font`);
  m.update(data());
  assert.ok(!reveal(m, /Dell/).includes('○'));
});

test("a 'tile' pin (Dell's Claude) resolves like the Tiles agent:Dell/claude tile: the window, not a look-alike elsewhere", () => {
  const win = sess('Dell', 'claude', 'working', { tmux: undefined, pane: undefined, window: '0xabc', session: 'win0xabc', workspace: '2' });
  const other = sess('Mini 1', 'claude', 'working', { tmux: 'claude' });
  const m = new HomeModel();
  m.update(data({ sessions: [other, win] }));
  assert.equal(m.pinSession(PINS[6])?.window, '0xabc');
  assert.match(reveal(m, /Claude · Dell/), /• Claude · Dell · busy/);
  const none = new HomeModel();
  none.update(data({ sessions: [other] }));
  assert.equal(none.pinSession(PINS[6]), undefined);
  assert.match(reveal(none, /Claude · Dell/), /· Claude · Dell · not running/);
});

test('the default pins are the home-agents sessions (claude / codex on the Minis and Neo) and Dell\'s tile', () => {
  const m = new HomeModel();
  const pins: Pin[] = ['Mini 1', 'Mini 2', 'Neo'].flatMap(machine => ['claude', 'codex'].map(agent => ({ label: `${agent} · ${machine}`, machine, agent, session: agent })));
  m.update(data({ pinned: pins, sessions: [sess('Neo', 'claude', 'done', { tmux: 'claude' }), sess('Neo', 'claude', 'working', { tmux: 'claude-other' })] }));
  assert.equal(m.pinSession(pins[4])?.tmux, 'claude', 'Neo\'s screen session named claude');
  assert.equal(m.pinSession(pins[0]), undefined);
});

test('orchestrator pin: first on Home, then the six Mac pins and Dell window, then the normal rows, All agents last; it pages cleanly', () => {
  const orchPin: Pin = { label: 'Claude · Orchestrator', machine: 'Laptop', agent: 'claude', session: 'orchestrator' };
  const pins = [orchPin, ...PINS.slice(0, 6), { ...PINS[6], label: 'Claude · Dell window' }];
  const orch = sess('Laptop', 'claude', 'working', { name: 'Orchestrator', session: 'orchestrator', page: 'Orchestrator', pane: 'orchestrator', tmux: 'orchestrator' });
  const m = new HomeModel();
  m.update(data({ pinned: pins, machines: [...data().machines, { name: 'Laptop', online: true }], sessions: [...data().sessions, orch] }));
  const seen: string[] = [];
  for (let i = 0; i < 24; i++) {
    const rows = lines(m);
    assert.ok(rows.length <= 10, `${rows.length} lines at step ${i}`);
    for (const l of rows) assert.ok(l.length <= WIDTH, l);
    const cur = rows.find(l => l.startsWith('>'));
    if (cur && seen.at(-1) !== cur) seen.push(cur.slice(2));
    m.input('down', NOW);
  }
  const names = seen.map(l => l.replace(/^\S+ /, '').split(' · ').slice(0, 2).join(' · '));
  assert.deepEqual(names.slice(0, 8), pins.map(p => p.label));
  assert.match(seen[0], /^• Claude · Orchestrator · busy/);
  assert.match(seen.at(-1)!, /^All agents/);
});

test('orchestrator: remote select starts the mic, the heard text goes to the hub as a prompt, the header says sent to Claude; no Stop (Esc)', () => {
  const orch = sess('Laptop', 'claude', 'idle', { name: 'Orchestrator', session: 'orchestrator', page: 'Orchestrator', pane: 'orchestrator', tmux: 'orchestrator' });
  const m = new HomeModel();
  m.update(data({ voice: true, pinned: [{ label: 'Claude · Orchestrator', machine: 'Laptop', agent: 'claude', session: 'orchestrator' }], machines: [{ name: 'Laptop', online: true }], sessions: [orch] }));
  m.input('select', NOW, 'remote');
  assert.equal(m.screenKind, 'agent');
  assert.deepEqual(m.terminalTarget(), { machine: 'Laptop', pane: 'orchestrator', key: 'Laptop/orchestrator' });
  m.setTerminal('Laptop/orchestrator', ['Done: the build passes.']);
  assert.deepEqual(m.input('select', NOW, 'remote'), { kind: 'startMic' });
  m.input('select', NOW, 'remote');
  m.setTranscript('start the release', NOW, m.agentTranscriptToken());
  assert.deepEqual(m.input('select', NOW, 'remote'), { kind: 'prompt', machine: 'Laptop', pane: 'orchestrator', text: 'start the release' });
  m.promptDone(true, false, NOW);
  assert.match(m.render(NOW), /^sent to Claude\n/);
  m.input('down', NOW);
  assert.match(m.render(NOW), /> Speak\n  Back\n  Continue/);
  assert.doesNotMatch(m.render(NOW), /Stop \(Esc\)/);
});

test('orchestrator pin: laptop down says laptop offline; laptop up without the session says not running', () => {
  const pins: Pin[] = [{ label: 'Claude · Orchestrator', machine: 'Dell', agent: 'claude', session: 'orchestrator' }];
  const off = new HomeModel();
  off.update(data({ pinned: pins, machines: [{ name: 'Dell', online: false }] }));
  assert.match(off.render(NOW), /· Claude · Orchestrator · laptop offline/);
  const none = new HomeModel();
  none.update(data({ pinned: pins, machines: [{ name: 'Dell', online: true }] }));
  assert.match(none.render(NOW), /· Claude · Orchestrator · not running/);
  assert.equal(off.input('select', NOW), null);
  assert.equal(off.screenKind, 'home');
});

test('the Dell window pin and the Tiles Claude (Dell) tile pick the window, never the orchestrator that shares machine Dell + claude', () => {
  const win = sess('Dell', 'claude', 'idle', { session: 'dellwin', page: 'window', pane: undefined, window: '0xabc', tmux: undefined, at: NOW / 1000 - 600 });
  const tm = sess('Dell', 'claude', 'idle', { session: 'delltmux', page: 'tmux', pane: '%9', tmux: 'other', at: NOW / 1000 - 300 });
  const orch = sess('Dell', 'claude', 'working', { name: 'Orchestrator', session: 'orchestrator', page: 'Orchestrator', pane: 'orchestrator', tmux: 'orchestrator', at: NOW / 1000 });
  const d = data({ pinned: [PINS[6]], sessions: [win, tm, orch], machines: [{ name: 'Dell', online: true }] });
  const m = new HomeModel();
  m.update(d);
  assert.equal(m.pinSession(PINS[6])?.session, 'delltmux', 'the tile pin = what the tile follows: a pane before a window, never the orchestrator');
  const found = findSession(d, 'Dell/claude', NOW);
  assert.notEqual(found.session?.pane, 'orchestrator');
  assert.equal(found.session?.session, 'delltmux');
  const onlyWin = findSession({ ...d, sessions: [win, orch] }, 'Dell/claude', NOW);
  assert.equal(onlyWin.session?.session, 'dellwin', 'window + orchestrator: the window');
  assert.equal(findSession({ ...d, sessions: [orch] }, 'Dell/claude', NOW).session, undefined, 'only the orchestrator: no Claude window');
  // the exact ref still finds it, and so does its own pin
  assert.equal(findSession(d, 'Dell/orchestrator', NOW).session?.pane, 'orchestrator');
  const op = new HomeModel();
  op.update({ ...d, pinned: [{ label: 'o', machine: 'Dell', agent: 'claude', session: 'orchestrator' }] });
  assert.equal(op.pinSession({ label: 'o', machine: 'Dell', agent: 'claude', session: 'orchestrator' })?.pane, 'orchestrator');
  // a fallback for a gone pinned ref does not land on it either
  assert.notEqual(findSession({ ...d, sessions: [orch, tm] }, 'Dell/gone-pane', NOW).session?.pane, 'orchestrator');
});

test('the highlight stays on a pin row when it goes offline -> live while a row above is added', () => {
  const pinsTwo: Pin[] = [PINS[0], PINS[1], PINS[2]];
  const off = data({ pinned: pinsTwo, machines: [{ name: 'Mini 1', online: false }, { name: 'Mini 2', online: true }, { name: 'Neo', online: true }, { name: 'Dell', online: true }], sessions: [sess('Mini 1', 'codex', 'idle'), sess('Mini 2', 'claude', 'working')] });
  const m = new HomeModel();
  m.update(off);
  m.input('down', NOW);
  m.input('down', NOW);
  const cur = () => m.render(NOW).split('\n').find(l => l.startsWith('>'));
  assert.match(cur()!, /Claude · Mini 2/);
  // Mini 1 comes back (its rows change text and become openable) and a pin row is added above
  const added: Pin = { label: 'Codex · Neo', machine: 'Neo', agent: 'codex', session: 'g2-codex' };
  m.update({ ...off, pinned: [added, ...pinsTwo], machines: off.machines.map(x => ({ ...x, online: true })), sessions: [sess('Mini 1', 'claude', 'working'), sess('Mini 1', 'codex', 'idle'), sess('Mini 2', 'claude', 'idle')] });
  assert.match(cur()!, /Claude · Mini 2 · ready/, 'still on the Mini 2 pin although its state, the rows above it and Mini 1 changed');
  // offline -> live on the highlighted row itself
  const m2 = new HomeModel();
  m2.update({ ...off, machines: off.machines.map(x => (x.name === 'Mini 2' ? { ...x, online: false } : x)) });
  m2.input('down', NOW);
  m2.input('down', NOW);
  assert.match(m2.render(NOW).split('\n').find(l => l.startsWith('>'))!, /Claude · Mini 2 · offline/);
  m2.update({ ...off, pinned: [added, ...pinsTwo] });
  assert.match(m2.render(NOW).split('\n').find(l => l.startsWith('>'))!, /Claude · Mini 2 · busy/);
});

test('remote up then Settings: a poll that inserts a row above between the two does not move the item Back returns to', () => {
  const m = new HomeModel();
  m.update(data());
  for (let i = 0; i < 3; i++) m.input('down', NOW);
  const cur = () => m.render(NOW).split('\n').find(l => l.startsWith('>'));
  const item = cur();
  assert.ok(item);
  const undo = m.capturePosition(); // the remote's up is about to move the highlight
  m.input('up', NOW);
  m.update(data({ pinned: [{ label: 'Codex · Neo', machine: 'Neo', agent: 'codex', session: 'g2-codex' }, ...PINS] })); // a poll adds a row above
  undo();
  assert.equal(cur(), item, 'the same item is highlighted after the undo');
  m.openSettings();
  m.input('back', NOW);
  assert.equal(m.screenKind, 'home');
  assert.equal(cur(), item, 'Back from Settings lands on it');
});
