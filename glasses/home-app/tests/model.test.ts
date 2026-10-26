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
  assert.match(text, /^MENU$/m);
  assert.match(text, /> Agents · 2 on 2 computers/);
  m.input('select', NOW);
  assert.equal(m.screenKind, 'agents');
  const page = m.render(NOW);
  assert.match(page, /^HOME › AGENTS/);
  assert.match(page, /── lap ──\n> ws1 · • Claude · agent-status · busy 2m/);
  assert.match(page, /── m1 ──\n  - Codex · black-team · done 10m/);
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
  m.input('down', NOW);
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
  assert.match(text, /> Open\n  Later/);
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
  assert.equal(m.screenKind, 'listen');
});

test('the Agents page has a section per computer, with its workspaces inside and [talk] agents first', () => {
  const m = new HomeModel();
  m.update(base({
    desktops: [{ machine: 'lap', active: 1, workspaces: [{ id: 1, windows: ['Alacritty: claude'] }, { id: 3, windows: ['Alacritty: codex', 'Chromium: docs'] }] }],
    sessions: [...base().sessions, { agent: 'claude', name: 'Claude', session: 't', state: 'idle', page: 'Projects', at: 0, workspace: '', machine: 'm1', pane: '%0' }],
  }));
  assert.doesNotMatch(m.render(NOW), /Workspaces/, 'no separate Workspaces row on the main menu');
  m.input('select', NOW);
  const page = m.render(NOW);
  assert.match(page, /── lap ──\n> Workspaces \[1\] 3 →\n  ws1 · • Claude · agent-status · busy 2m/);
  assert.match(page, /── m1 ──\n  · Claude · Projects · ready \[talk\]\n  - Codex · black-team · done 10m/);
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
  assert.match(text, /line 20\ntap: talk · swipe up: scroll · down: quick replies$/);
  assert.doesNotMatch(text, /line 12\n/);
  m.input('up', NOW);
  text = m.render(NOW);
  assert.match(text, /line 17\nswipe up: scroll · down: newer$/);
  m.input('down', NOW);
  assert.match(m.render(NOW), /line 20\n/);
  assert.equal(m.screenKind, 'agent', 'swipe down from scrolled-back returns to newest, not replies');
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

test('talk: tap starts the mic, tap stops, the text is confirmed, Send types it into the pane', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  assert.deepEqual(m.input('select', NOW), { kind: 'startMic' });
  assert.match(m.render(NOW), /TALK → Claude · Mini 1/);
  assert.deepEqual(m.input('select', NOW), { kind: 'stopMic' });
  assert.equal(m.input('select', NOW), null, 'a second tap while transcribing does nothing');
  m.setTranscript('run the tests and tell me what fails', NOW);
  const text = m.render(NOW);
  assert.match(text, /SEND TO CLAUDE · MINI 1\?/);
  assert.match(text, /"run the tests and tell me what fails"/);
  assert.match(text, /> Send/);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', text: 'run the tests and tell me what fails' });
  assert.equal(m.screenKind, 'agent');
});

test('talk: double-tap cancels the mic; an empty transcript goes back to the agent', () => {
  const m = new HomeModel();
  m.update(tmuxed());
  openAgent(m);
  m.input('select', NOW);
  assert.deepEqual(m.input('back', NOW), { kind: 'cancelMic' });
  assert.equal(m.screenKind, 'agent');
  m.input('select', NOW);
  m.input('select', NOW);
  m.setTranscript('', NOW);
  assert.equal(m.screenKind, 'agent');
  assert.match(m.render(NOW), /Didn't catch that/);
});

test('swipe down opens replies: quick replies send text, Stop sends Escape, Show on screen focuses', () => {
  const m = new HomeModel();
  m.update(tmuxed({ sessions: [{ ...tmuxed().sessions[0], workspace: '2' }] }));
  openAgent(m);
  m.input('down', NOW);
  assert.equal(m.screenKind, 'reply');
  assert.match(m.render(NOW), /> Back\n  Continue/);
  assert.equal(m.input('select', NOW), null, 'a stray tap on the first item sends nothing');
  assert.equal(m.screenKind, 'agent');
  m.input('down', NOW);
  m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', text: 'Continue' });
  m.input('down', NOW);
  for (let i = 0; i < 5; i++) m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'prompt', machine: 'Mini 1', pane: '%3', key: 'Escape' });
  m.input('down', NOW);
  for (let i = 0; i < 6; i++) m.input('down', NOW);
  assert.deepEqual(m.input('select', NOW), { kind: 'focus', machine: 'Mini 1', workspace: '2' });
});

test('a plain terminal window on the Dell is prompted through its window', () => {
  const m = new HomeModel();
  m.update(base({ sessions: [{ ...base().sessions[0], window: '0xabc' }] }));
  openAgent(m);
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
  assert.match(text, /^MENU\n> Agents/m);
  assert.match(text, /Muse · latest reply\n  ! Needs you · 3 \(2 approvals\)/);
  for (let i = 0; i < 3; i++) m.input('down', NOW);
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
  assert.match(text, /── Mini 1 ──\n> \+ New agent here/);
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
