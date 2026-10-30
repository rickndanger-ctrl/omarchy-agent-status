import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeModel, wrap, clip, WIDTH, type HomeData } from '../src/model.ts';

const NOW = Date.UTC(2026, 9, 26, 18, 42);
const base = (over: Partial<HomeData> = {}): HomeData => ({
  now: NOW, paused: false, machines: [{ name: 'lap', online: true }, { name: 'm1', online: true }],
  sessions: [
    { agent: 'claude', name: 'Claude', session: 'a', state: 'working', page: 'agent-status', at: NOW / 1000 - 120, workspace: '1', machine: 'lap' },
    { agent: 'codex', name: 'Codex', session: 'b', state: 'done', page: 'black-team', at: NOW / 1000 - 600, workspace: '', machine: 'm1' },
  ],
  pending: [], messages: null, muse: false, ...over,
});
const pending = { id: 'p1', agent: 'claude', page: 'proj', tool: 'Bash', summary: 'git push origin main', at: NOW, machine: 'm1' };

test('home shows time and an Agents page summary; the page lists each session', () => {
  const m = new HomeModel();
  m.update(base());
  const text = m.render(NOW, 'America/Los_Angeles');
  assert.match(text.split('\n')[0], /^Mon Oct 26 · 11:42 AM/);
  assert.match(text, /^AGENTS │ 1 busy · 1 done$/m);
  assert.doesNotMatch(text, /^MENU$/m); // the title line makes room for the Listen row
  assert.match(text, /> Agents · 2 on 2 computers/);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'agents');
  const page = m.render(NOW);
  assert.match(page, /^HOME › AGENTS/);
  assert.match(page, /THREADS\n── lap ──\n> • Claude · agent-status · busy 2m\n── m1 ──\n  - Codex · black-team · done 10m/);
  for (const line of page.split('\n')) assert.ok(line.length <= WIDTH, line);
});

test('a new approval pops up with the safe choice first', () => {
  const m = new HomeModel();
  m.update(base());
  m.update(base({ pending: [pending] }));
  assert.equal(m.screenKind, 'approval');
  const text = m.render(NOW);
  assert.match(text, /APPROVE\? Claude on m1 · proj/);
  assert.match(text, /Bash: git push origin main/);
  assert.match(text, /> Leave for desk/);
  // a single stray tap must not approve
  assert.deepEqual(m.input('select', NOW), { kind: 'decide', machine: 'm1', id: 'p1', behavior: 'desk' });
  assert.equal(m.screenKind, 'home');
});

test('swipe down twice then tap allows', () => {
  const m = new HomeModel();
  m.update(base({ pending: [pending] }));
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'decide', machine: 'm1', id: 'p1', behavior: 'allow' });
});

test('an approval answered at the desk closes its card and does not pop again', () => {
  const m = new HomeModel();
  m.update(base({ pending: [pending] }));
  m.input('back', NOW);
  m.update(base({ pending: [pending] }));
  assert.equal(m.screenKind, 'home');
  m.update(base({ pending: [{ ...pending, id: 'p2' }] }));
  assert.equal(m.screenKind, 'approval');
  m.update(base());
  assert.equal(m.screenKind, 'home');
});

test('messages and muse rows open and request their data', () => {
  const m = new HomeModel();
  m.update(base({ sessions: [], muse: true, messages: [{ id: 7, name: 'Mom', unread: true, when: NOW / 1000 - 180, snippet: 'Running late', fromMe: false }] }));
  const text = m.render(NOW);
  assert.match(text, /AGENTS │ none running/);
  assert.match(text, /  Messages · 1 new · Mom: Running late/);
  m.input('down', NOW);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'messages');
  assert.deepEqual(m.input('select', NOW), { kind: 'loadChat', id: 7 });
  m.setChat([{ from: 'Mom', fromMe: false, when: NOW / 1000 - 180, text: 'Running late' }], NOW);
  assert.match(m.render(NOW), /Mom \(3m\): Running late/);
  m.input('back', NOW);
  assert.equal(m.screenKind, 'messages');
  m.input('back', NOW);
  // Back on Home: the highlight is still on Messages, where you left it.
  assert.match(m.render(NOW), /> Messages/);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'loadMuse' });
  m.setMuse({ question: 'Weather?', reply: 'Sunny, 72.' });
  assert.match(m.render(NOW), /Muse: Sunny, 72\./);
  assert.match(m.render(NOW), /swipe: scroll$/);
});

test('offline machines and paused approvals are visible', () => {
  const m = new HomeModel();
  m.update(base({ paused: true, machines: [{ name: 'lap', online: true }, { name: 'neo', online: false }] }));
  const text = m.render(NOW);
  assert.match(text, /approvals paused/);
  assert.match(text, /Offline: neo/);
});

test('wrap and clip respect the width', () => {
  assert.ok(wrap('x'.repeat(100)).every(l => l.length <= WIDTH));
  assert.equal(clip('a  b\n c'), 'a b c');
  assert.equal(clip('y'.repeat(60)).length, WIDTH);
});

const tmuxed = (over: Partial<HomeData> = {}) => base({
  voice: true,
  sessions: [{ agent: 'claude', name: 'Claude', session: 'a', state: 'working', page: 'agent-status', at: NOW / 1000 - 60, workspace: '', machine: 'Mini 1', pane: '%3' }],
  ...over,
});
const openAgent = (m: HomeModel) => { m.input('select', NOW); m.input('select', NOW); };

test('a finished agent pops up; Open goes to it, and double-tap returns to where you were', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  m.input('select', NOW); // on the Agents page
  m.update(tmuxed({ now: NOW + 5000, sessions: [{ ...tmuxed().sessions[0], state: 'done' }] }));
  assert.equal(m.screenKind, 'alert');
  let text = m.render(NOW + 5000);
  assert.match(text, /^DONE · Claude · Mini 1/);
  assert.match(text, /  Open\n> Later/, 'Later is selected, so a stray touch does not open a chat');
  m.input('up', NOW + 5000);
  assert.match(m.render(NOW + 5000), /> Open\n  Later/);
  m.input('select', NOW + 5000);
  assert.equal(m.screenKind, 'agent');
  m.input('back', NOW + 5000);
  assert.equal(m.screenKind, 'agents', 'back to where you were, not home');
  text = m.render(NOW + 9000);
  assert.doesNotMatch(text, /DONE/);
});

test('Later dismisses a pop-up; an agent finishing while you look at it does not pop up', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], state: 'attention' }] }));
  assert.match(m.render(NOW), /^NEEDS YOU · Claude · Mini 1/);
  m.input('back', NOW);
  assert.equal(m.screenKind, 'home');
  openAgent(m);
  m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], state: 'done' }] }));
  assert.equal(m.screenKind, 'agent');
});

test('a new text pops up; sending a reply from it closes it and returns you', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.input('select', NOW); // Agents page
  m.update(withChat().messages ? { ...withChat(), messages: [{ id: 7, name: 'Mom', unread: true, when: NOW / 1000 + 5, snippet: 'Call me', fromMe: false }] } : withChat());
  assert.equal(m.screenKind, 'alert');
  assert.match(m.render(NOW), /^TEXT · Mom\n\nCall me\n/);
  m.input('up', NOW); // to Open
  assert.deepEqual(m.input('select', NOW), { kind: 'loadChat', id: 7 });
  m.setChat([{ from: 'Mom', fromMe: false, when: NOW / 1000, text: 'Call me' }], NOW);
  m.input('down', NOW); // quick texts
  m.input('down', NOW); // past "Back"
  assert.deepEqual(m.input('select', NOW), { kind: 'sendText', chat: 7, name: 'Mom', text: 'On my way' });
  assert.equal(m.screenKind, 'agents');
});

test('pop-ups wait while you are talking', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.input('select', NOW); // listening
  m.update(tmuxed({ pending: [pending] }));
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /^Listening/);
});

test('the Agents page puts chats you can talk to first, then threads to read, then computers', () => {
  const m = new HomeModel();
  m.update(base({
    desktops: [{ machine: 'lap', active: 1, workspaces: [{ id: 1, windows: ['Alacritty: claude'] }, { id: 3, windows: ['Alacritty: codex', 'Chromium: docs'] }] }],
    sessions: [...base().sessions, { agent: 'claude', name: 'Claude', session: 't', state: 'idle', page: 'Projects', at: 0, workspace: '', machine: 'm1', pane: '%0' }],
  }));
  assert.doesNotMatch(m.render(NOW), /Workspaces/, 'no separate Workspaces row on the main menu');
  m.input('select', NOW);
  const page = m.render(NOW);
  assert.match(page, /^TALK\n── m1 ──\n> · Claude · Projects · ready\nTHREADS\n── lap ──\n  • Claude · agent-status · busy 2m\n── m1 ──$/m);
  for (let i = 0; i < 3; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /── m1 ──\n  - Codex · black-team · done 10m\nCOMPUTERS\n> lap workspaces \[1\] 3 →/);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'workspaces');
  assert.match(m.render(NOW), /^AGENTS › LAP WORKSPACES/);
  assert.match(m.render(NOW), /lap 3 · Alacritty: codex \+1/);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'focus', machine: 'lap', workspace: '3' });
});

test('agent page is a terminal view: its conversation, newest at the bottom, swipe up for older', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  assert.deepEqual(m.terminalTarget(), { machine: 'Mini 1', pane: '%3', key: 'Mini 1/%3' });
  assert.match(m.render(NOW), /Loading…/);
  m.setTerminal('Mini 1/%3', Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
  let text = m.render(NOW);
  assert.match(text, /^CLAUDE · Mini 1 · agent-status · busy/);
  assert.match(text, /line 12\nline 13\n[\s\S]*line 20$/);
  assert.equal(text.split('\n').length, 10, 'header + 9 lines of terminal, no hint line');
  assert.doesNotMatch(text, /line 11\n/);
  m.input('up', NOW);
  text = m.render(NOW);
  assert.match(text, /line 17\n▼ 3 newer$/);
  m.input('down', NOW);
  assert.match(m.render(NOW), /line 20$/);
  assert.equal(m.screenKind, 'agent', 'swipe down from scrolled-back returns to newest, not replies');
});

test('messages get a bar with who and the time (seconds); scrolled back, the footer says how far', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  const t0 = new Date(2026, 9, 26, 18, 41, 58).getTime();
  const lines = ['::msg you ' + t0, 'how is it going', '::msg claude ' + (t0 + 17_000), ...Array.from({ length: 12 }, (_, i) => `reply ${i + 1}`)];
  m.setTerminal('Mini 1/%3', lines);
  let text = m.render(NOW);
  assert.match(text, /reply 12$/);
  for (let i = 0; i < 3; i++) m.input('up', NOW);
  text = m.render(NOW);
  assert.match(text, /^--- YOU · 6:41:58 PM -+$/m);
  assert.match(text, /^=== CLAUDE · 6:42:15 PM =+$/m);
  assert.match(text, /\n▼ 8 newer$/);
  for (const line of text.split('\n')) assert.ok(line.length <= 56, line);
});

test('a conversation shows no commands, and one reply per turn: progress notes give way to the answer', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  const t0 = new Date(2026, 9, 26, 18, 0, 0).getTime();
  m.setTerminal('Mini 1/%3', [
    '::msg you ' + t0, 'fix it',
    '::msg claude ' + (t0 + 5_000), 'Looking at the code:', '[Bash] grep -n foo src/*.ts',
    '::msg claude ' + (t0 + 9_000), 'Running the tests:', '[Bash] npm test',
    '::msg claude ' + (t0 + 12_000), 'Fixed.', '', 'All tests pass.',
  ]);
  const text = m.render(NOW);
  assert.match(text, /--- YOU · 6:00:00 PM -+\nfix it\n\n=== CLAUDE · 6:00:12 PM =+\nFixed\.\n\nAll tests pass\./);
  assert.doesNotMatch(text, /Bash|grep|Looking at|Running the tests/);
});

test('every screen fits the glasses, so a swipe is never eaten by native scrolling', () => {
  const m = new HomeModel();
  m.update(tmuxed({ messages: [{ id: 1, name: 'Mom', unread: true, when: NOW / 1000, snippet: 'hi', fromMe: false }], muse: true, pending: [pending], machines: [{ name: 'lap', online: true }, { name: 'x', online: false }] }));
  for (const step of ['back', 'select', 'select', 'down', 'back', 'back', 'down', 'select']) {
    assert.ok(m.render(NOW).split('\n').length <= 10, m.render(NOW));
    m.input(step as never, NOW);
  }
  m.setTerminal('Mini 1/%3', Array.from({ length: 50 }, () => 'x '.repeat(80)));
  assert.ok(m.render(NOW).split('\n').length <= 10);
});

test('talk: tap starts the mic on the terminal page, tap stops, the heard text shows there, tap sends', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.setTerminal('Mini 1/%3', ['You: hi', 'hello there']);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /^Listening… tap to send\n/);
  assert.match(m.render(NOW), /hello there/, 'the terminal stays under the header');
  assert.deepEqual(m.input('select', NOW), { kind: 'stopMic' });
  assert.match(m.render(NOW), /^Turning speech into text/);
  assert.equal(m.input('select', NOW), null, 'a second tap while transcribing does nothing');
  m.setTranscript('run the tests and tell me what fails', NOW);
  const text = m.render(NOW);
  assert.match(text, /^Tap to send/);
  assert.match(text, /"run the tests and tell me what fails"/);
  assert.ok(text.split('\n').length <= 10, text);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', text: 'run the tests and tell me what fails' });
  assert.match(m.render(NOW), /^Sending…/);
  m.promptDone(true, false, NOW);
  assert.match(m.render(NOW), /^Sent\n/);
  assert.equal(m.screenKind, 'agent');
  assert.doesNotMatch(m.render(NOW + 5000), /run the tests/, 'the heard text is gone once sent');
});

test('talk: double-tap cancels at every step and sends nothing; an empty transcript goes back to the terminal', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.input('select', NOW);
  assert.deepEqual(m.input('back', NOW), { kind: 'cancelMic' });
  assert.equal(m.screenKind, 'agent');
  assert.doesNotMatch(m.render(NOW), /^Listening/);
  m.input('select', NOW);
  m.input('select', NOW);
  assert.deepEqual(m.input('back', NOW), { kind: 'cancelMic' }, 'while transcribing too');
  m.input('select', NOW);
  m.input('select', NOW);
  m.setTranscript('do not send this', NOW);
  assert.equal(m.input('back', NOW), null, 'heard text: cancel sends nothing');
  assert.equal(m.screenKind, 'agent');
  assert.doesNotMatch(m.render(NOW), /do not send/);
  m.input('select', NOW);
  m.input('select', NOW);
  m.setTranscript('', NOW);
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /Didn't catch that/);
});

test('select on a tmux, screen or window pin always starts the mic; voice off flashes why and opens no reply list', () => {
  for (const over of [{ pane: '%3', tmux: 'claude' }, { pane: 'screen:1234.claude', tmux: 'claude' }, { pane: '', window: '0xabc' }]) {
    const m = new HomeModel();
    m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], ...over }] }));
    openAgent(m);
    assert.deepEqual(m.input('select', NOW), { kind: 'startMic' }, JSON.stringify(over));
    const off = new HomeModel();
    off.update(tmuxed({ voice: false, sessions: [{ ...tmuxed().sessions[0], ...over }] }));
    openAgent(off);
    assert.equal(off.input('select', NOW), null);
    assert.equal(off.screenKind, 'agent', 'no reply list');
    assert.match(off.render(NOW), /^Voice not set up on this hub/);
  }
});

test('leaving the terminal page while listening: the mic is no longer wanted (the app closes it)', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  assert.equal(m.micWanted(), false);
  m.input('select', NOW);
  assert.equal(m.micWanted(), true);
  m.goTo('home');
  assert.equal(m.screenKind, 'home');
  assert.equal(m.micWanted(), false, 'Home from the menu');
  openAgent(m);
  m.input('select', NOW);
  m.abandonTalk();
  assert.equal(m.micWanted(), false, 'left the front');
  assert.match(m.render(NOW), /^[A-Z]/);
  openAgent(m);
  m.input('select', NOW);
  m.input('select', NOW);
  m.setTranscript('hello', NOW);
  assert.equal(m.micWanted(), false, 'heard text is waiting: the mic is already closed');
});

test('the voice-off message names the hub', () => {
  const m = new HomeModel();
  m.update(tmuxed({ voice: false, hub: 'Mini 1' }));
  openAgent(m);
  m.input('select', NOW);
  assert.match(m.render(NOW), /^Voice not set up on this hub \(Mini 1\)/);
});

test('the reply list starts with Speak: it starts the mic (or says voice is off); Back is second and does nothing', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.input('down', NOW);
  assert.match(m.render(NOW), /> Speak\n  Back\n  Continue/);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  assert.match(m.render(NOW), /^Listening/);
  m.input('back', NOW);
  m.input('down', NOW);
  m.input('down', NOW);
  assert.equal(m.input('select', NOW), null, 'Back sends nothing');
  const off = new HomeModel();
  off.update(tmuxed({ voice: false }));
  openAgent(off);
  off.input('down', NOW);
  assert.equal(off.input('select', NOW), null);
  assert.match(off.render(NOW), /^Voice not set up on this hub/);
});

test('swipe down opens replies: quick replies send text, Stop sends Escape, Show on screen focuses', () => {
  const m = new HomeModel();
  m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], workspace: '2' }] }));
  openAgent(m);
  m.input('down', NOW);
  assert.equal(m.screenKind, 'reply');
  assert.match(m.render(NOW), /> Speak\n  Back\n  Continue/);
  m.input('down', NOW);
  assert.equal(m.input('select', NOW), null, 'a stray tap on Back sends nothing');
  assert.equal(m.screenKind, 'agent');
  m.input('down', NOW);
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', text: 'Continue' });
  m.input('down', NOW);
  for (let i = 0; i < 6; i++) m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', key: 'Escape' });
  m.input('down', NOW);
  for (let i = 0; i < 7; i++) m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'focus', machine: 'Mini 1', workspace: '2' });
});

test('a plain terminal window on the Dell is prompted through its window', () => {
  const m = new HomeModel();
  m.update(base({ sessions: [{ ...base().sessions[0], window: '0xabc' }] }));
  openAgent(m);
  m.input('down', NOW);
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'lap', pane: '', window: '0xabc', text: 'Continue' });
});

test('an app chat explains it is status-only, and can still be shown on screen', () => {
  const m = new HomeModel();
  m.update(base());
  openAgent(m);
  const text = m.render(NOW);
  assert.match(text, /in the Claude app, so it can't/);
  assert.equal(m.terminalTarget(), null);
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'focus', machine: 'lap', workspace: '1' });
});

test('a [talk] page stays on its terminal even when a different status session matches it', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.setTerminal('Mini 1/%3', ['You: hi', 'hello']);
  m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], session: 'other', state: 'done' }] }));
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /hello/);
  assert.doesNotMatch(m.render(NOW), /app, so it can't/);
});

test('one double-tap goes home from an agent page; Home is also in the long-press menu', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.input('back', NOW);
  assert.equal(m.screenKind, 'home');
  openAgent(m);
  m.goHome();
  assert.equal(m.screenKind, 'home');
});

const withChat = (over: Partial<HomeData> = {}) => tmuxed({ messages: [{ id: 7, name: 'Mom', unread: true, when: NOW / 1000 - 60, snippet: 'Running late', fromMe: false }], muse: true, ...over });
const openChat = (m: HomeModel) => {
  m.update(withChat());
  m.input('down', NOW); // Messages row (after Agents)
  m.input('select', NOW);
  m.input('select', NOW); // the chat with Mom
  m.setChat([{ from: 'Mom', fromMe: false, when: NOW / 1000 - 60, text: 'Running late' }], NOW);
};

test('texts: tap replies by voice, confirm shows the recipient, Send sends', () => {
  const m = new HomeModel();
  openChat(m);
  assert.equal(m.screenKind, 'chat');
  assert.match(m.render(NOW), /^MESSAGES › Mom/);
  assert.match(m.render(NOW), /tap: reply by voice · swipe up: scroll · down: quick texts$/);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  assert.match(m.render(NOW), /^TEXT → Mom/);
  m.input('select', NOW);
  m.setTranscript('see you at seven', NOW);
  assert.match(m.render(NOW), /^TEXT TO MOM\?/);
  assert.deepEqual(m.input('select', NOW), { kind: 'sendText', chat: 7, name: 'Mom', text: 'see you at seven' });
  assert.equal(m.screenKind, 'chat');
});

test('texts: swipe down at the newest message opens quick texts', () => {
  const m = new HomeModel();
  openChat(m);
  m.input('down', NOW);
  assert.equal(m.screenKind, 'textReply');
  assert.equal(m.input('select', NOW), null, 'Back is first');
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'sendText', chat: 7, name: 'Mom', text: 'On my way' });
});

test('Muse: tap asks by voice, Send asks Muse and shows that it is thinking', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.input('down', NOW);
  m.input('down', NOW);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'muse');
  m.setMuse({ question: 'old', reply: 'old answer' });
  assert.match(m.render(NOW), /tap: ask Muse by voice/);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  m.input('select', NOW);
  m.setTranscript('what is on my calendar', NOW);
  assert.match(m.render(NOW), /^ASK MUSE\?/);
  assert.deepEqual(m.input('select', NOW), { kind: 'askMuse', text: 'what is on my calendar' });
  assert.match(m.render(NOW), /Muse is thinking…/);
  m.setMuseAnswer('what is on my calendar', 'Dentist at 3.');
  assert.match(m.render(NOW), /Muse: Dentist at 3\./);
});

test('home keeps the menu first; waiting items are one row that opens the Needs you page', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.update(withChat({ now: NOW + 1, pending: [pending, { ...pending, id: 'p2' }], sessions: [{ ...tmuxed().sessions[0], state: 'done' }] }));
  while (m.screenKind !== 'home') m.input('back', NOW); // dismiss the pop-ups
  const text = m.render(NOW);
  assert.match(text, /^─+\n> Agents/m);
  assert.match(text, /Muse · latest reply\n  Listen · Conversation\n  Settings · display, brightness/ );
  for (let i = 0; i < 5; i++) m.input('down', NOW);
  assert.match(m.render(NOW), /> ! Needs you · 3 \(2 approvals\)/); // scrolled into the window
  m.input('select', NOW);
  assert.equal(m.screenKind, 'needs');
  const page = m.render(NOW);
  assert.match(page, /^HOME › NEEDS YOU/);
  assert.match(page, /> ! Claude · m1 · Bash: git push origin main/);
  assert.match(page, /\* Claude · Mini 1 finished/);
});

test('start an agent by voice: computer → agent → folder → speak → confirm full access → it opens', () => {
  const m = new HomeModel();
  const data = tmuxed({ machines: [{ name: 'Mini 1', online: true, canStart: ['claude', 'codex'] }] });
  m.update(data);
  m.input('select', NOW); // Agents
  let text = m.render(NOW);
  assert.match(text, /COMPUTERS\n  \+ New agent on Mini 1/);
  m.input('down', NOW);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'newAgent');
  assert.match(m.render(NOW), /^NEW AGENT · Mini 1\n\nPick an agent\n> Claude\n  Codex/);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'loadFolders', machine: 'Mini 1' });
  assert.match(m.render(NOW), /Loading folders/);
  m.setFolders('Mini 1', ['Projects', 'pie-bird']);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  assert.match(m.render(NOW), /^NEW Codex on Mini 1 · pie-bird/);
  m.input('select', NOW);
  m.setTranscript('fix the login bug', NOW);
  text = m.render(NOW);
  assert.match(text, /^START CODEX ON MINI 1 · PIE-BIRD\?/);
  assert.match(text, /Full access: no approvals/);
  assert.deepEqual(m.input('select', NOW), { kind: 'startAgent', machine: 'Mini 1', agent: 'codex', folder: 'pie-bird', text: 'fix the login bug' });
  assert.equal(m.screenKind, 'agents');
  m.expectAgent('Mini 1', '%7', NOW);
  m.update({ ...data, sessions: [...data.sessions, { agent: 'codex', name: 'Codex', session: 'tmux%7', state: 'idle', page: 'pie-bird', at: 0, workspace: '', machine: 'Mini 1', pane: '%7' }] });
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW + 5000), /^CODEX · Mini 1 · pie-bird/);
});

test('computers that cannot start agents have no New agent row', () => {
  const m = new HomeModel();
  m.update(base());
  m.input('select', NOW);
  assert.doesNotMatch(m.render(NOW), /New agent/);
});

test('a Codex app thread is talkable: its conversation shows and replies go into the thread', () => {
  const m = new HomeModel();
  m.update(tmuxed({ sessions: [{ agent: 'codex', name: 'Codex app', session: 'app:t1', state: 'idle', page: 'Beeper on Even Glasses', at: 0, workspace: '', machine: 'Mini 1', appThread: 't1' }] }));
  m.input('select', NOW);
  assert.match(m.render(NOW), /THREADS\n── Mini 1 ──\n> · Codex app · Beeper on Even Glasses/);
  m.input('select', NOW);
  assert.deepEqual(m.terminalTarget(), { machine: 'Mini 1', pane: '', appThread: 't1', key: 'Mini 1/codex/app:t1' });
  m.input('down', NOW);
  assert.doesNotMatch(m.render(NOW), /Stop \(Esc\)/, 'no Escape key for app threads');
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '', appThread: 't1', text: 'Continue' });
});

test('a Claude app session offers Continue on glasses', () => {
  const m = new HomeModel();
  m.update(tmuxed({ sessions: [{ agent: 'claude', name: 'Claude app', session: 'desk:s1', state: 'idle', page: 'Story writing', at: 0, workspace: '', machine: 'Mini 1', desktopSession: 's1' }] }));
  m.input('select', NOW);
  assert.match(m.render(NOW), /── Mini 1 ──\n> · Claude app · Story writing \[continue\]/);
  m.input('select', NOW);
  assert.match(m.render(NOW), /tap: continue on glasses/);
  assert.equal(m.terminalTarget(), null);
  assert.deepEqual(m.input('select', NOW), { kind: 'continueSession', machine: 'Mini 1', session: 's1' });
});
test('studio row opens a scrolling page of computers and the conversation', () => {
  const m = new HomeModel();
  const studio = {
    at: NOW / 1000,
    machines: [
      { name: 'Laptop', line: 'Reverser · step 5 · How PAIR talks to engines', busy: true },
      { name: 'Mini 1', line: 'standing by', busy: false },
    ],
    feed: Array.from({ length: 6 }, (_, i) => ({ t: NOW / 1000 - 60 * (i + 1), text: `Claude → Reader: note number ${i} with enough words to wrap past one glasses line easily`, kind: 'say' })),
  };
  m.update(base({ sessions: [], studio }));
  assert.match(m.render(NOW), /  Studio · 1 working · Laptop: Reverser · step 5/);
  m.input('down', NOW);
  m.input('down', NOW); // (Listen · Conversation and Settings sit before Studio)
  m.input('down', NOW);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'studio');
  const page = m.render(NOW);
  assert.match(page, /^HOME › STUDIO/);
  assert.match(page, /> Laptop: Reverser · step 5 · How PAIR talks to engines/);
  assert.match(page, /- Mini 1: standing by/);
  assert.match(page, /1m Claude → Reader: note number 0/);
  for (const line of page.split('\n')) assert.ok(line.length <= WIDTH, line);
  assert.ok(page.split('\n').length <= 10);
  m.input('down', NOW);
  assert.notEqual(m.render(NOW), page, 'swipe down scrolls');
});
test('without Studio Routing there is no studio row', () => {
  const m = new HomeModel();
  m.update(base({ sessions: [], studio: null }));
  assert.doesNotMatch(m.render(NOW), /Studio/);
});

test('promptDone for a tile: the orchestrator pane says sent to Claude for 3 s, other panes Sent', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  m.promptDone(true, false, NOW, 'orchestrator');
  assert.equal(m.sentTo('orchestrator', NOW + 1000), 'sent to Claude');
  assert.equal(m.sentTo('orchestrator', NOW + 3500), null);
  assert.equal(m.sentTo('%3', NOW + 1000), null);
  m.promptDone(true, false, NOW, '%3');
  assert.equal(m.sentTo('%3', NOW + 1000), 'Sent');
  m.promptDone(false, false, NOW, 'orchestrator');
  assert.equal(m.sentTo('orchestrator', NOW + 1000), 'Could not send to that agent');

// ---- selection and back (review 2026-10-29) ----

test('a pop-up and Later return you to the same highlighted row', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.input('down', NOW); // Messages
  m.input('down', NOW); // Muse
  assert.match(m.render(NOW), /> Muse/);
  m.update(withChat({ now: NOW + 5000, sessions: [{ ...tmuxed().sessions[0], state: 'done' }] }));
  assert.equal(m.screenKind, 'alert');
  m.input('back', NOW); // leave the pop-up
  assert.equal(m.screenKind, 'home');
  assert.match(m.render(NOW), /> Muse/);
});

test('the highlight stays on the same item when a row is added above it', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.input('down', NOW);
  m.input('down', NOW);
  m.input('down', NOW);
  m.input('down', NOW); // Settings
  assert.match(m.render(NOW), /> Settings/);
  m.update(withChat({ now: NOW + 2000, studio: { at: NOW / 1000, machines: [], feed: [] } }));
  assert.match(m.render(NOW), /> Settings/);
  m.update(withChat({ now: NOW + 4000, sessions: [], machines: [{ name: 'Mini 1', online: true }] }));
  assert.match(m.render(NOW), /> Settings/);
});

test('back from a chat lands on that chat in Messages, and quick texts back to the newest lines', () => {
  const m = new HomeModel();
  const two = withChat({ messages: [
    { id: 7, name: 'Mom', unread: false, when: NOW / 1000 - 60, snippet: 'Running late', fromMe: false },
    { id: 8, name: 'Bob', unread: false, when: NOW / 1000 - 120, snippet: 'ok', fromMe: false },
  ] });
  m.update(two);
  m.input('down', NOW);
  m.input('select', NOW); // Messages
  m.input('down', NOW); // Bob
  m.input('select', NOW);
  const long = Array.from({ length: 20 }, (_, i) => ({ from: 'Bob', fromMe: false, when: NOW / 1000 - 600 + i, text: `line ${i}` })).reverse();
  m.setChat(long, NOW);
  assert.match(m.render(NOW), /line 19/);
  m.input('down', NOW); // at the newest: opens quick texts
  assert.equal(m.screenKind, 'textReply');
  m.input('back', NOW);
  assert.equal(m.screenKind, 'chat');
  assert.match(m.render(NOW), /line 19/); // still at the newest, not the oldest
  m.input('back', NOW);
  assert.equal(m.screenKind, 'messages');
  assert.match(m.render(NOW), /> {2}Bob|> {1,2}Bob/);
});

test('back on an approval returns to where you were, and does not leave a stale way back', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.input('select', NOW); // Agents
  m.update(withChat({ pending: [pending] }));
  assert.equal(m.screenKind, 'approval');
  m.input('back', NOW);
  assert.equal(m.screenKind, 'agents');
  m.input('back', NOW); // home
  m.input('down', NOW);
  m.input('select', NOW); // Messages
  m.input('select', NOW); // Mom
  m.input('back', NOW);
  assert.equal(m.screenKind, 'messages'); // not some old screen
});

test('an approval opened from Needs you comes back to Needs you', () => {
  const m = new HomeModel();
  m.update(base());
  m.update(base({ pending: [pending] }));
  m.input('back', NOW); // leave the pop-up for later
  assert.equal(m.screenKind, 'home');
  const needs = m.render(NOW).split('\n').filter(l => /^[ >] /.test(l)).findIndex(l => /Needs you/.test(l));
  for (let i = 0; i < needs; i++) m.input('down', NOW);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'needs');
  m.input('select', NOW);
  assert.equal(m.screenKind, 'approval');
  m.input('select', NOW); // Leave for desk
  assert.equal(m.screenKind, 'needs');
});

test('a started agent does not pull you off another screen', () => {
  const m = new HomeModel();
  const data = tmuxed();
  m.update(data);
  m.expectAgent('Mini 1', '%7', NOW);
  m.openSettings();
  m.update({ ...data, sessions: [...data.sessions, { agent: 'codex', name: 'Codex', session: 'tmux%7', state: 'idle', page: 'x', at: 0, workspace: '', machine: 'Mini 1', pane: '%7' }] });
  assert.equal(m.screenKind, 'settings');
});

test('a terminal that gets shorter while scrolled back still fills the screen', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  const key = 'Mini 1/%3';
  m.setTerminal(key, Array.from({ length: 30 }, (_, i) => `out ${i}`));
  for (let i = 0; i < 8; i++) m.input('up', NOW);
  m.setTerminal(key, Array.from({ length: 14 }, (_, i) => `out ${i}`));
  const text = m.render(NOW);
  assert.doesNotMatch(text, /22 newer/);
  assert.match(text, /out 0/);
});

test('Quick settings: Back (double-tap or the Back row) returns to the Home row you were on, and to the page you opened it from', () => {
  const m = new HomeModel();
  m.update(withChat());
  const cur = () => m.render(NOW).split('\n').find(l => l.startsWith('>'));
  for (let i = 0; i < 3; i++) m.input('down', NOW);
  const row3 = cur();
  assert.ok(row3);
  m.openSettings();
  assert.equal(m.screenKind, 'settings');
  m.input('back', NOW);
  assert.equal(m.screenKind, 'home');
  assert.equal(cur(), row3, 'double-tap Back');
  m.openSettings();
  for (let i = 0; i < 3; i++) m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'settingsBack' }, 'the Back row');
  assert.equal(cur(), row3);
  // from the Agents page: back lands there, on the same row
  m.goTo('agents');
  m.input('down', NOW);
  const onAgents = cur();
  m.openSettings();
  m.input('back', NOW);
  assert.equal(m.screenKind, 'agents');
  assert.equal(cur(), onAgents);
  // Muse is left alone: Settings opened from Muse goes Home as before
  m.goTo('muse');
  m.openSettings();
  m.input('back', NOW);
  assert.equal(m.screenKind, 'home');
});

test('keep-place review: Muse is never restored by Back (a pop-up Later reopens it from the top, as in 0.4.20)', () => {
  const m = new HomeModel();
  m.update(withChat());
  m.goTo('muse');
  m.setMuse({ question: 'q', reply: Array.from({ length: 40 }, (_, i) => `answer line ${i}`).join('\n') });
  m.input('down', NOW);
  m.input('down', NOW);
  const scrolled = m.render(NOW);
  assert.doesNotMatch(scrolled, /answer line 0\b/, 'scrolled down');
  m.update(withChat({ pending: [pending] }));
  assert.equal(m.screenKind, 'approval');
  m.input('back', NOW); // leave the pop-up
  assert.equal(m.screenKind, 'muse');
  assert.match(m.render(NOW), /answer line 0\b|You: q/, 'Muse is back at the top');
});

test('keep-place review: Settings Back to an agent or chat that is gone lands on its list, else Home', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.openSettings();
  m.update(tmuxed({ sessions: [] }));
  m.input('back', NOW);
  assert.equal(m.screenKind, 'agents', 'the agent ended');
  const c = new HomeModel();
  openChat(c);
  c.openSettings();
  c.update(withChat({ messages: [] }));
  c.input('back', NOW);
  assert.equal(c.screenKind, 'messages', 'the chat dropped off the list');
  const ok = new HomeModel();
  ok.update(tmuxed());
  openAgent(ok);
  ok.openSettings();
  ok.input('back', NOW);
  assert.equal(ok.screenKind, 'agent', 'still there: back on it');
});

test('keep-place review: the highlight follows a chat by its id (a new snippet or a renamed contact) and a workspace by computer + number', () => {
  const chats = (name: string, snippet: string) => [
    { id: 7, name: 'Mom', unread: false, when: NOW / 1000 - 60, snippet: 'Running late', fromMe: false },
    { id: 8, name, unread: false, when: NOW / 1000 - 120, snippet, fromMe: false },
  ];
  const m = new HomeModel();
  m.update(withChat({ messages: chats('Dad', 'old words') }));
  m.goTo('messages');
  m.input('down', NOW);
  assert.match(m.render(NOW), /> .*Dad/);
  m.update(withChat({ messages: chats('Daddy', 'brand new words') }));
  assert.match(m.render(NOW), /> .*Daddy/, 'same chat id, still highlighted');
  // workspaces: the "(here)" marker and the window title change, the row stays
  const desk = (active: number, title: string) => ({ desktops: [{ machine: 'Mini 1', active, workspaces: [{ id: 1, windows: ['a'] }, { id: 2, windows: [title] }] }] });
  const w = new HomeModel();
  w.update(withChat(desk(1, 'term one')));
  (w as unknown as { go(s: unknown): void }).go({ kind: 'workspaces', machine: 'Mini 1' });
  w.input('down', NOW);
  assert.match(w.render(NOW), /> Mini 1 2 /);
  w.update(withChat(desk(2, 'a different title')));
  assert.match(w.render(NOW), /> Mini 1 2 \(here\) · a different title/, 'workspace 2 stays highlighted');
});
