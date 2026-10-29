// Screens and navigation for Home, kept free of the SDK and the network so it
// can be tested on its own. The glasses show one full-screen text block; this
// file decides what that text is and what each tap or swipe does.

import type { OpenTarget } from './tiles';

export type Input = 'up' | 'down' | 'select' | 'back';

export interface Session { agent: string; name: string; session: string; state: string; page: string; at: number; workspace: string; machine: string; pane?: string; window?: string; appThread?: string; desktopSession?: string }
export interface Desktop { machine: string; active: number; workspaces: { id: number; windows: string[] }[] }
export interface Pending { id: string; agent: string; page: string; tool: string; summary: string; at: number; machine: string }
export interface Chat { id: number; name: string; unread: boolean; when: number; snippet: string; fromMe: boolean; /** Set by tileChats: older than 24 h but kept because a tile is pinned to it; lists and chat:recent skip it. */ old?: boolean }
export interface ChatMessage { from: string; fromMe: boolean; when: number; text: string }
export interface HomeData {
  now: number;
  paused: boolean;
  machines: { name: string; online: boolean; canStart?: string[] }[];
  sessions: Session[];
  pending: Pending[];
  messages: Chat[] | null;
  muse: boolean;
  desktops?: Desktop[];
  voice?: boolean;
  weather?: { temp: number; desc: string; hi: number; lo: number; rainAt: string | null; rainChance: number } | null;
  /** Studio Routing on the laptop: what each computer's workers are doing, and what they said to each other. */
  studio?: Studio | null;
}
export interface Studio { at: number; machines: { name: string; line: string; busy: boolean }[]; feed: { t: number; text: string; kind: string }[] }

export type Action =
  | { kind: 'decide'; machine: string; id: string; behavior: 'allow' | 'deny' | 'desk' }
  | { kind: 'focus'; machine: string; workspace: string }
  | { kind: 'loadChat'; id: number }
  | { kind: 'loadMuse' }
  | { kind: 'prompt'; machine: string; pane: string; window?: string; appThread?: string; text?: string; key?: 'Escape' }
  | { kind: 'continueSession'; machine: string; session: string }
  | { kind: 'startMic' }
  | { kind: 'stopMic' }
  | { kind: 'cancelMic' }
  | { kind: 'sendText'; chat: number; name: string; text: string }
  | { kind: 'askMuse'; text: string }
  | { kind: 'loadFolders'; machine: string }
  | { kind: 'startAgent'; machine: string; agent: string; folder: string; text: string }
  | { kind: 'openTiles' }
  | { kind: 'addReminder'; title: string };

type Screen =
  | { kind: 'home' }
  | { kind: 'approval'; machine: string; id: string }
  | { kind: 'agents' }
  | { kind: 'agent'; key: string }
  | { kind: 'messages' }
  | { kind: 'chat'; id: number; name: string }
  | { kind: 'muse' }
  | { kind: 'studio' }
  | { kind: 'tiles' }
  | { kind: 'workspaces'; machine?: string }
  | { kind: 'needs' }
  | { kind: 'reply'; key: string }
  | { kind: 'listen'; key: string; thinking: boolean; chat?: ChatRef; muse?: true; reminder?: true; start?: StartRef }
  | { kind: 'confirm'; key: string; text: string; chat?: ChatRef; muse?: true; reminder?: true; start?: StartRef }
  | { kind: 'newAgent'; machine: string; agent?: string; folders?: string[] | null }
  | { kind: 'textReply'; id: number; name: string }
  | { kind: 'alert'; alert: Alert };

/** A pop-up: something that needs you. Tap opens it; when you finish there, Home returns you to where you were. */
interface Alert { id: string; title: string; detail: string; open: Screen }

/** A new agent to start: which computer, which agent, which folder. */
type StartRef = { machine: string; agent: string; folder: string };

/** A text conversation as the target of a voice reply or quick text. */
type ChatRef = { id: number; name: string };

// A header is a title or divider line; the cursor skips it.
interface Row { text: string; open?: Screen; header?: boolean }
const RULE = '─'.repeat(26);
const title = (text: string): Row => ({ text, header: true });

// Rick's order for computers on the Agents page; any other computer follows in the hub's order.
const MACHINE_ORDER = ['Mini 1', 'Mini 2', 'Dell', 'Neo'];

export const WIDTH = 56; // characters per line; the G2 font fits ~60 narrow characters in 576 px
// The glasses fit 10 lines. More than that and the glasses scroll the text themselves,
// which swallows a swipe before Home sees it, so every screen stays within MAX_LINES.
const MAX_LINES = 10;
const LIST_ROWS = 7;
const BODY_LINES = 6;
const TERM_LINES = 8;
export const QUICK_TEXTS = ['On my way', "Can't talk right now", 'Call you soon', 'Sounds good', 'Yes', 'No'];
export const QUICK_REPLIES = ['Continue', 'Yes, go ahead', 'Run the tests', 'Commit it', 'Stop (Esc)'];
const CONFIRM_CHOICES = ['Send', 'Talk again', 'Cancel'];
const APPROVAL_CHOICES = [
  { label: 'Leave for desk', behavior: 'desk' },
  { label: 'Deny', behavior: 'deny' },
  { label: 'Allow', behavior: 'allow' },
] as const;

// A [talk] agent is identified by its terminal (pane or window), never by whichever status
// session happens to match it this poll; otherwise an open page can flip between two chats.
export const sessionKey = (s: Session) => s.pane ? `${s.machine}/${s.pane}` : s.window ? `${s.machine}/${s.window}` : `${s.machine}/${s.agent}/${s.session}`;
/** Something Home can type into: a terminal pane, a terminal window, or a Codex app thread. */
const talkable = (s: Session) => Boolean(s.pane || s.window || s.appThread);
const pendingKey = (p: { machine: string; id: string }) => `${p.machine}/${p.id}`;

/** "6:42:15 PM": the phone's local time, with seconds. */
export function timeWithSeconds(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

const SPEAKER: Record<string, string> = { you: 'YOU', claude: 'CLAUDE', codex: 'CODEX' };
const BAR = 40; // shorter than WIDTH: = and - are wider than the average character on the G2 font
/** A message's title bar: thick (=) for the agent, thin (-) for you, so each reply stands out while scrolling. */
export function messageBar(who: string, ms: number): string {
  const rule = who === 'you' ? '-' : '=';
  return `${rule.repeat(3)} ${SPEAKER[who] ?? who.toUpperCase()}${ms ? ` · ${timeWithSeconds(ms)}` : ''} `.padEnd(BAR, rule);
}
const BAR_TIME = /^[=-]{3} \w+ · (\d+:\d\d:\d\d [AP]M) [=-]+$/;

/** The relay's own screen furniture at the end of a reply: not part of the answer. */
const MUSE_CHROME = /^(muse|connected|approvals history.*)$/i;

/**
 * Muse text for the glasses (display only): the reply's trailing blank lines and relay chrome lines
 * (Muse / Connected / Approvals history…) are dropped, and runs of blank lines collapse to one.
 */
export function museDisplay(question: string, reply: string): { question: string; reply: string } {
  const squeeze = (lines: string[]) => lines.filter((l, i) => l.trim() !== '' || (i > 0 && lines[i - 1].trim() !== ''));
  const lines = reply.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && (lines.at(-1) === '' || MUSE_CHROME.test(lines.at(-1)!.trim()))) lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  return { question: squeeze(question.replace(/\r/g, '').split('\n')).join('\n').trim(), reply: squeeze(lines).join('\n') };
}

const OLD_TEXT_S = 24 * 3600;
/** Chats whose last message is older than 24 h are hidden when `on` (display only: model.data stays whole). */
export function recentChats(chats: Chat[], nowMs: number, on: boolean): Chat[] {
  return on ? chats.filter(c => nowMs / 1000 - c.when <= OLD_TEXT_S) : chats;
}
/** One chat's messages: those older than 24 h are dropped, but the newest always stays; `hidden` says some were. */
export function recentMessages(msgs: ChatMessage[], nowMs: number, on: boolean): { messages: ChatMessage[]; hidden: boolean } {
  if (!on || !msgs.length) return { messages: msgs, hidden: false };
  const newest = msgs.reduce((a, b) => (b.when > a.when ? b : a));
  const messages = msgs.filter(m => m === newest || nowMs / 1000 - m.when <= OLD_TEXT_S);
  return { messages, hidden: messages.length < msgs.length };
}

export function clip(text: string, width = WIDTH): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > width ? flat.slice(0, width - 1) + '…' : flat;
}

export function wrap(text: string, width = WIDTH): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      for (let piece = word; piece; piece = piece.slice(width)) {
        const part = piece.slice(0, width);
        if (!line) line = part;
        else if (line.length + 1 + part.length <= width) line += ' ' + part;
        else { lines.push(line); line = part; }
      }
    }
    lines.push(line);
  }
  return lines;
}

export function age(seconds: number, nowMs: number): string {
  const s = Math.max(0, nowMs / 1000 - seconds);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const STATE_WORD: Record<string, string> = { working: 'busy', done: 'done', attention: 'needs you', error: 'error', stopped: 'stopped', idle: 'ready' };
const MARK: Record<string, string> = { attention: '!', error: '!', working: '•', done: '-', stopped: '-', idle: '·' };
const NOTICE_MS = 10 * 60_000;



export function clock(nowMs: number, timeZone?: string): string {
  const d = new Date(nowMs);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return `${day.replace(',', '')} · ${time}`;
}

/**
 * A terminal tail as readable lines. A plain terminal screen is shown as it is; a conversation
 * (lines with ::msg headers) shows what was said only, no commands. An agent's run of messages
 * between two of yours is one reply: each progress note replaces the last, so a finished reply
 * is just the answer.
 */
export function conversationLines(raw: string[], width = WIDTH): string[] {
  if (!raw.some(line => line.startsWith('::msg '))) return raw.flatMap(line => (line ? wrap(line, width) : ['']));
  const said: { who: string; ms: number; text: string[] }[] = [];
  for (const line of raw) {
    const header = line.match(/^::msg (\w+) (\d+)$/);
    if (header) {
      const [, who, ms] = header;
      const last = said.at(-1);
      if (last && who !== 'you' && last.who === who) Object.assign(last, { ms: Number(ms), text: [] });
      else said.push({ who, ms: Number(ms), text: [] });
    } else if (said.length && !/^\[[\w.-]+\] /.test(line)) said.at(-1)!.text.push(line);
  }
  // A blank line above every bar but the first keeps your messages and the agent's apart.
  return said.flatMap((m, i) => [...(i ? [''] : []), messageBar(m.who, m.ms).slice(0, width), ...m.text.join('\n').trim().split('\n').flatMap(line => (line ? wrap(line, width) : ['']))]);
}

/** Studio: one line per computer, then the conversation, newest first, in plain English. */
export function studioText(st: Studio, nowMs: number, width = WIDTH): string[] {
  const lines = st.machines.map(m => clip(`${m.busy ? '>' : '-'} ${m.name}: ${m.line}`, width));
  lines.push(RULE.slice(0, width));
  for (const e of st.feed) lines.push(...wrap(`${age(e.t, nowMs)} ${e.text}`, width));
  return lines;
}

export class HomeModel {
  data: HomeData | null = null;
  error = '';
  battery: number | undefined;
  hideDone = false;
  /** Hide texts older than 24 h on the Home screens (the setting 'Hide old texts'). */
  hideOldTexts = true;
  private screen: Screen = { kind: 'home' };
  private cursor = 0;
  private scroll = 0;
  private seenPending = new Set<string>();
  private chatLines: string[] | null = null;
  private museLines: string[] | null = null;
  private flash = { text: '', until: 0 };
  private lastState = new Map<string, string>();
  private notices: { key: string; text: string; at: number }[] = [];
  private terminal: { key: string; lines: string[] } | null = null;
  private termScroll = 0;
  private alerts: Alert[] = [];
  private returnTo: Screen | null = null;
  private seenTexts = new Map<number, number>();
  private firstUpdate = true;
  private waitingFor: { machine: string; pane: string; until: number } | null = null;

  get screenKind(): Screen['kind'] { return this.screen.kind; }

  /** New data from the hub. Anything new that needs you becomes a pop-up. */
  update(data: HomeData): void {
    this.data = data;
    this.error = '';
    const quiet = this.firstUpdate; // what's already there when Home opens isn't news
    this.firstUpdate = false;
    for (const p of data.pending) {
      if (this.seenPending.has(pendingKey(p))) continue;
      this.seenPending.add(pendingKey(p));
      this.queue({ id: `approve:${pendingKey(p)}`, title: `APPROVE? ${cap(p.agent)} · ${p.machine}`, detail: `${p.tool}: ${p.summary}`, open: { kind: 'approval', machine: p.machine, id: p.id } }, true);
    }
    // An approval answered elsewhere (at the desk, or it expired) closes its card and its pop-up.
    this.alerts = this.alerts.filter(a => a.open.kind !== 'approval' || data.pending.some(p => p.machine === (a.open as { machine: string }).machine && p.id === (a.open as { id: string }).id));
    if (this.screen.kind === 'approval' && !this.currentPending()) this.finish();
    if (this.screen.kind === 'alert' && !this.alerts.some(a => a.id === (this.screen as { alert: Alert }).alert.id)) this.finish();
    for (const x of data.sessions) {
      const key = sessionKey(x);
      const before = this.lastState.get(key);
      if (!before || before === x.state) continue;
      if (x.state === 'done' && before !== 'done') {
        const text = `${x.name} · ${x.machine} finished · ${x.page}`;
        this.notices = [{ key, text, at: data.now }, ...this.notices.filter(n => n.key !== key)];
        this.queue({ id: `agent:${key}`, title: clip(`DONE · ${x.name} · ${x.machine}`), detail: x.page || 'finished', open: { kind: 'agent', key } });
      }
      if (x.state === 'attention') {
        this.queue({ id: `agent:${key}`, title: clip(`NEEDS YOU · ${x.name} · ${x.machine}`), detail: x.page || 'waiting for you', open: { kind: 'agent', key } });
      }
    }
    this.lastState = new Map(data.sessions.map(x => [sessionKey(x), x.state]));
    // A just-started agent: open its page as soon as it shows up.
    const w = this.waitingFor;
    if (w && data.now > w.until) this.waitingFor = null;
    else if (w && data.sessions.some(x => x.machine === w.machine && x.pane === w.pane)) {
      this.waitingFor = null;
      if (!['listen', 'confirm', 'reply', 'textReply', 'approval', 'alert'].includes(this.screen.kind)) this.go({ kind: 'agent', key: `${w.machine}/${w.pane}` });
    }
    this.notices = this.notices.filter(n => data.now - n.at < NOTICE_MS && this.lastState.has(n.key));
    for (const c of data.messages ?? []) {
      const seen = this.seenTexts.get(c.id);
      this.seenTexts.set(c.id, Math.max(seen ?? 0, c.when));
      if (quiet) continue;
      if (c.unread && !c.fromMe && c.when > (seen ?? 0)) {
        this.queue({ id: `text:${c.id}`, title: clip(`TEXT · ${c.name}`), detail: c.snippet, open: { kind: 'chat', id: c.id, name: c.name } });
      }
    }
    this.showNextAlert();
  }

  /** Add a pop-up (replacing an older one about the same thing). Approvals jump the queue. */
  private queue(alert: Alert, urgent = false): void {
    this.alerts = this.alerts.filter(a => a.id !== alert.id);
    if (urgent) this.alerts.unshift(alert);
    else this.alerts.push(alert);
  }

  /** Pop the next alert up, but never in the middle of talking, confirming, or replying. */
  private showNextAlert(): void {
    // Already looking at it? Then it isn't news.
    const here = JSON.stringify(this.screen);
    this.alerts = this.alerts.filter(a => JSON.stringify(a.open) !== here);
    const busy = ['listen', 'confirm', 'reply', 'textReply', 'approval', 'alert'].includes(this.screen.kind);
    if (busy || !this.alerts.length) return;
    if (!this.returnTo) this.returnTo = this.screen;
    const alert = this.alerts[0];
    // An approval is its own card; everything else gets an Open / Later pop-up.
    if (alert.open.kind === 'approval') {
      this.alerts.shift();
      this.go(alert.open);
    } else {
      this.go({ kind: 'alert', alert });
      // "Later" is selected, so a stray touch on the glasses' arm dismisses the pop-up instead of opening a chat.
      this.cursor = 1;
    }
  }

  /** Done with what a pop-up opened: back to where you were, then the next pop-up if any. */
  private finish(): void {
    const back = this.returnTo ?? { kind: 'home' as const };
    this.returnTo = null;
    this.go(back.kind === 'alert' || back.kind === 'approval' ? { kind: 'home' } : back);
    this.showNextAlert();
  }

  /** The agent whose conversation should be fetched for the open agent page, if any. */
  terminalTarget(): { machine: string; pane: string; window?: string; appThread?: string; key: string } | null {
    const s = this.screen;
    const x = this.session();
    if (s.kind !== 'agent' || !x || !talkable(x)) return null;
    return { machine: x.machine, pane: x.pane ?? '', ...(x.window ? { window: x.window } : {}), ...(x.appThread ? { appThread: x.appThread } : {}), key: s.key };
  }

  setTerminal(key: string, lines: string[] | null): void {
    if (this.screen.kind === 'agent' && this.screen.key === key) this.terminal = { key, lines: lines ?? ['(Could not read this agent.)'] };
  }

  private terminalLines(): string[] | null {
    const s = this.screen;
    if (s.kind !== 'agent' || this.terminal?.key !== s.key) return null;
    return conversationLines(this.terminal.lines);
  }

  setFolders(machine: string, folders: string[] | null): void {
    const s = this.screen;
    if (s.kind === 'newAgent' && s.machine === machine) this.screen = { ...s, folders: folders ?? ['Projects'] };
  }
  /** After asking a computer to start an agent: open it when it appears (for up to a minute). */
  expectAgent(machine: string, pane: string, nowMs: number): void {
    if (pane) this.waitingFor = { machine, pane, until: nowMs + 60_000 };
  }

  /** Speech-to-text result for the listen screen; empty or null means nothing usable. */
  setTranscript(text: string | null, nowMs: number): void {
    const s = this.screen;
    if (s.kind !== 'listen') return;
    if (text) this.go({ kind: 'confirm', key: s.key, text, ...(s.chat ? { chat: s.chat } : {}), ...(s.muse ? { muse: true as const } : {}), ...(s.reminder ? { reminder: true as const } : {}), ...(s.start ? { start: s.start } : {}) });
    else {
      this.showFlash(text === null ? 'Voice failed. Try again' : "Didn't catch that", nowMs);
      this.go(s.reminder ? { kind: 'home' } : s.chat ? { kind: 'chat', ...s.chat } : s.muse ? { kind: 'muse' } : s.start ? { kind: 'agents' } : { kind: 'agent', key: s.key });
    }
  }

  setError(message: string): void { this.error = message; }
  goHome(): void { this.goTo('home'); }
  /** Jump straight to a main page from the long-press menu (not while you're mid-recording). */
  goTo(kind: 'home' | 'agents' | 'messages' | 'muse'): void {
    if (this.screen.kind === 'listen') return;
    this.returnTo = null;
    this.go({ kind });
    if (kind === 'muse') this.museLines = null;
  }
  /**
   * Open a full screen from a Tiles action. Voice steps fall back to the quick-reply lists when the
   * microphone is not available, as they do from the full screens.
   */
  openTarget(target: OpenTarget): Action | null {
    this.returnTo = null;
    if (target.kind === 'home' || target.kind === 'messages' || target.kind === 'needs' || target.kind === 'studio') {
      this.go({ kind: target.kind });
      this.scroll = 0;
      return null;
    }
    if (target.kind === 'muse') {
      this.museLines = null;
      if (target.then === 'listen' && this.data?.voice) { this.go({ kind: 'listen', key: '', thinking: false, muse: true }); return { kind: 'startMic' }; }
      this.go({ kind: 'muse' });
      return { kind: 'loadMuse' };
    }
    if (target.kind === 'chat') {
      const chat = { id: target.id, name: target.name };
      this.chatLines = null;
      if (target.then === 'listen' && this.data?.voice) { this.go({ kind: 'listen', key: '', thinking: false, chat }); return { kind: 'startMic' }; }
      this.go(target.then === 'textReply' || target.then === 'listen' ? { kind: 'textReply', ...chat } : { kind: 'chat', ...chat });
      return { kind: 'loadChat', id: target.id };
    }
    if (target.kind === 'reminderAdd') {
      if (this.data?.voice) { this.go({ kind: 'listen', key: '', thinking: false, reminder: true }); return { kind: 'startMic' }; }
      this.go({ kind: 'home' });
      return null;
    }
    this.notices = this.notices.filter(n => n.key !== target.key);
    const x = this.data?.sessions.find(y => sessionKey(y) === target.key);
    if (target.then === 'listen' && x && talkable(x) && this.data?.voice) { this.go({ kind: 'listen', key: target.key, thinking: false }); return { kind: 'startMic' }; }
    this.go(target.then && x && this.replyChoices(x).length ? { kind: 'reply', key: target.key } : { kind: 'agent', key: target.key });
    return null;
  }

  /** `forChat`: the chat these messages belong to; they are dropped if another screen is open by now. */
  setChat(messages: ChatMessage[] | null, nowMs: number, forChat?: number): void {
    if (forChat !== undefined && !(this.screen.kind === 'chat' && this.screen.id === forChat)) return;
    const shown = messages && recentMessages(messages, nowMs, this.hideOldTexts);
    this.chatLines = shown === null ? ['Could not load this chat.']
      : [...(shown.hidden ? ['(older messages hidden)'] : []), ...[...shown.messages].reverse().flatMap(m => wrap(`${m.fromMe ? 'Me' : m.from} (${age(m.when, nowMs)}): ${m.text}`))];
    this.scroll = Math.max(0, this.chatLines.length - BODY_LINES);
  }
  private chatAtBottom(): boolean { return this.scroll >= Math.max(0, (this.chatLines?.length ?? 0) - BODY_LINES); }
  /** Show the newest part of a Muse answer (it is long-form; swipe up to read from the start). */
  setMuseAnswer(question: string, reply: string): void {
    const m = museDisplay(question, reply);
    this.museLines = [...wrap(`You: ${m.question}`), '', ...wrap(`Muse: ${m.reply}`)];
    this.scroll = 0;
  }
  /** Muse didn't answer: say why, in the relay's own words. */
  setMuseProblem(question: string, reason: string): void {
    this.museLines = [...wrap(`You: ${question}`), '', ...wrap(`Muse didn't get it: ${reason || 'no answer'}.`), '', 'Nothing was typed anywhere else.'];
    this.scroll = 0;
  }
  private museAnswerLines(question: string, reply: string): string[] {
    const m = museDisplay(question, reply);
    return [...wrap(`You: ${m.question}`), '', ...wrap(`Muse: ${m.reply}`)];
  }
  setMuse(latest: { question: string; reply: string } | null): void {
    this.museLines = latest === null ? ["Couldn't reach Muse."]
      : latest.question || latest.reply ? this.museAnswerLines(latest.question, latest.reply) : ['No Muse conversation yet.'];
    this.scroll = 0;
  }
  showFlash(text: string, nowMs: number): void { this.flash = { text, until: nowMs + 3000 }; }

  /** Bumped whenever the screen is replaced (by a press, an alert or a poll): queued presses use it to notice. */
  generation = 0;

  private go(screen: Screen): void {
    this.generation++;
    this.screen = screen;
    this.cursor = 0;
    this.scroll = 0;
    this.termScroll = 0;
  }

  private currentPending(): Pending | undefined {
    const s = this.screen;
    return s.kind === 'approval' ? this.data?.pending.find(p => p.machine === s.machine && p.id === s.id) : undefined;
  }

  private visibleSessions(): Session[] {
    const all = this.data?.sessions ?? [];
    return this.hideDone ? all.filter(s => s.state !== 'done' && s.state !== 'stopped') : all;
  }

  /** Home: the agent status bar, the menu of pages, and one row for anything waiting on you. */
  private homeRows(nowMs = Date.now()): Row[] {
    const d = this.data;
    if (!d) return [];
    const counts = new Map<string, number>();
    for (const x of d.sessions) counts.set(x.state, (counts.get(x.state) ?? 0) + 1);
    const summary = ['attention', 'error', 'working', 'done', 'stopped', 'idle']
      .filter(state => counts.get(state))
      .map(state => `${counts.get(state)} ${STATE_WORD[state]}`)
      .join(' · ');
    const rows: Row[] = [title(clip(`AGENTS │ ${summary || 'none running'}`, WIDTH - 2)), title(RULE)];
    // The menu always comes first; anything waiting is one row that opens its own page.
    const waiting = d.pending.length + this.notices.length;
    rows.push(title('MENU'));
    const online = d.machines.filter(m => m.online).length;
    rows.push({ text: clip(`Agents · ${d.sessions.length} on ${online} computer${online === 1 ? '' : 's'}`, WIDTH - 2), open: { kind: 'agents' } });
    if (d.messages) {
      const chats = recentChats(d.messages, nowMs, this.hideOldTexts);
      const unread = chats.filter(c => c.unread).length;
      const top = chats[0];
      const latest = top ? `${top.fromMe ? 'You' : top.name}: ${top.snippet}` : 'no recent texts';
      rows.push({ text: clip(`Messages${unread ? ` · ${unread} new` : ''} · ${latest}`, WIDTH - 2), open: { kind: 'messages' } });
    }
    if (d.muse) rows.push({ text: 'Muse · latest reply', open: { kind: 'muse' } });
    if (d.studio) {
      const busy = d.studio.machines.filter(m => m.busy);
      rows.push({ text: clip(`Studio · ${busy.length ? `${busy.length} working · ${busy[0].name}: ${busy[0].line}` : 'standing by'}`, WIDTH - 2), open: { kind: 'studio' } });
    }
    if (waiting) rows.push({ text: clip(`! Needs you · ${waiting}${d.pending.length ? ` (${d.pending.length} approval${d.pending.length === 1 ? '' : 's'})` : ''}`, WIDTH - 2), open: { kind: 'needs' } });
    rows.push({ text: 'Tiles · 5 pages of apps', open: { kind: 'tiles' } });
    return rows;
  }

  /** Everything waiting on you: approvals first, then agents that finished. */
  private needsRows(): Row[] {
    const d = this.data;
    if (!d) return [];
    return [
      ...d.pending.map(p => ({ text: clip(`! ${cap(p.agent)} · ${p.machine} · ${p.tool}: ${p.summary}`, WIDTH - 2), open: { kind: 'approval' as const, machine: p.machine, id: p.id } })),
      ...this.notices.map(n => ({ text: clip(`* ${n.text}`, WIDTH - 2), open: { kind: 'agent' as const, key: n.key } })),
    ];
  }

  /**
   * Two big sections, each grouped by computer, so the chats you talk to are never buried:
   *   TALK      the live terminal agents Home types into (Mini 1: its Claude and Codex, Mini 2: ...)
   *   THREADS   app threads and other chats, to read (Codex app threads can still be answered)
   * then COMPUTERS: + New agent and workspaces. Order is fixed (computer, agent, project) so rows don't
   * reshuffle on every refresh.
   */
  private agentRows(nowMs: number): Row[] {
    const rows: Row[] = [];
    const sessions = this.visibleSessions();
    const known = [...new Set([...(this.data?.machines ?? []).map(m => m.name), ...sessions.map(x => x.machine)])];
    const rank = (m: string) => { const i = MACHINE_ORDER.indexOf(m); return i < 0 ? MACHINE_ORDER.length + known.indexOf(m) : i; };
    const machines = [...known].sort((a, b) => rank(a) - rank(b));
    const when = (x: Session) => `${STATE_WORD[x.state] ?? x.state}${x.at ? ` ${age(x.at, nowMs)}` : ''}`;
    const terminal = (x: Session) => Boolean(x.pane || x.window);
    const kind = (x: Session) => (x.appThread ? 0 : x.desktopSession ? 1 : 2);
    const order = (a: Session, b: Session) => kind(a) - kind(b) || a.name.localeCompare(b.name) || a.page.localeCompare(b.page) || sessionKey(a).localeCompare(sessionKey(b));
    const section = (heading: string, pick: (x: Session) => boolean, text: (x: Session) => string) => {
      const out: Row[] = [];
      for (const machine of machines) {
        const mine = sessions.filter(x => x.machine === machine && pick(x)).sort(order);
        if (!mine.length) continue;
        out.push(title(`── ${machine} ──`));
        for (const x of mine) out.push({ text: clip(text(x), WIDTH - 2), open: { kind: 'agent', key: sessionKey(x) } });
      }
      if (out.length) rows.push(title(heading), ...out);
    };

    section('TALK', terminal, x => {
      const ws = x.workspace && x.window ? ` ws${x.workspace.split(',')[0]}` : '';
      return `${MARK[x.state] ?? '-'} ${x.name}${ws} · ${x.page || 'no project'} · ${when(x)}`;
    });
    section('THREADS', x => !terminal(x), x => {
      // Threads are mostly idle; only say the state when it isn't ("ready" would just crowd the line).
      const state = x.state === 'idle' ? (x.at ? ` · ${age(x.at, nowMs)}` : '') : ` · ${when(x)}`;
      return `${MARK[x.state] ?? '-'} ${x.name} · ${x.page || 'no project'}${x.desktopSession ? ' [continue]' : ''}${state}`;
    });

    const computer: Row[] = [];
    for (const machine of machines) {
      const info = this.data?.machines.find(m => m.name === machine);
      if (info && !info.online) { computer.push(title(`${machine}: offline`)); continue; }
      if (info?.canStart?.length) computer.push({ text: `+ New agent on ${machine}`, open: { kind: 'newAgent', machine } });
      const desk = this.data?.desktops?.find(dk => dk.machine === machine);
      if (desk?.workspaces.length) {
        const list = desk.workspaces.map(w => (w.id === desk.active ? `[${w.id}]` : String(w.id))).join(' ');
        computer.push({ text: clip(`${machine} workspaces ${list} →`, WIDTH - 2), open: { kind: 'workspaces', machine } });
      }
    }
    if (computer.length) rows.push(title('COMPUTERS'), ...computer);
    return rows;
  }

  /** The "replies" page under an agent: quick replies, then Show on screen. */
  private replyChoices(x: Session | undefined): string[] {
    if (!x) return [];
    // "Back" first: swiping down lands here, and a stray tap must not send anything.
    const replies = talkable(x) ? (x.appThread ? QUICK_REPLIES.filter(r => r !== 'Stop (Esc)') : QUICK_REPLIES) : [];
    return ['Back', ...replies, ...(x.workspace ? [`Show on screen (workspace ${x.workspace})`] : [])];
  }

  private workspaceRows(): { row: Row; machine: string; id: number }[] {
    const only = this.screen.kind === 'workspaces' ? this.screen.machine : undefined;
    return (this.data?.desktops ?? []).filter(desk => !only || desk.machine === only).flatMap(desk => desk.workspaces.map(w => ({
      machine: desk.machine,
      id: w.id,
      row: { text: clip(`${desk.machine} ${w.id}${w.id === desk.active ? ' (here)' : ''} · ${w.windows[0] ?? ''}${w.windows.length > 1 ? ` +${w.windows.length - 1}` : ''}`, WIDTH - 2) },
    })));
  }

  private listRows(nowMs: number): Row[] {
    if (this.screen.kind === 'reply') return this.replyChoices(this.session()).map(text => ({ text }));
    if (this.screen.kind === 'textReply') return ['Back', ...QUICK_TEXTS].map(text => ({ text }));
    if (this.screen.kind === 'newAgent') {
      const s = this.screen;
      if (!s.agent) return (this.data?.machines.find(m => m.name === s.machine)?.canStart ?? []).map(a => ({ text: cap(a) }));
      return (s.folders ?? []).map(f => ({ text: f === 'Projects' ? 'Projects (all)' : f }));
    }
    if (this.screen.kind === 'confirm') return CONFIRM_CHOICES.map(text => ({ text }));
    if (this.screen.kind === 'workspaces') return this.workspaceRows().map(w => w.row);
    if (this.screen.kind === 'home') return this.homeRows(nowMs);
    if (this.screen.kind === 'needs') return this.needsRows();
    if (this.screen.kind === 'agents') return this.agentRows(nowMs);
    if (this.screen.kind === 'messages') {
      return recentChats(this.data?.messages ?? [], nowMs, this.hideOldTexts).map(c => ({
        text: clip(`${c.unread ? '*' : ' '} ${c.name} ${age(c.when, nowMs)}: ${c.fromMe ? 'You: ' : ''}${c.snippet}`, WIDTH - 2),
        open: { kind: 'chat', id: c.id, name: c.name },
      }));
    }
    if (this.screen.kind === 'approval') return APPROVAL_CHOICES.map(c => ({ text: c.label }));
    return [];
  }

  private session(): Session | undefined {
    const s = this.screen;
    const key = 'key' in s ? s.key : undefined;
    return key ? this.data?.sessions.find(x => sessionKey(x) === key) : undefined;
  }

  /** Apply one tap or swipe. Returns work for the network layer, if any. */
  input(input: Input, nowMs: number): Action | null {
    const s = this.screen;
    if (s.kind === 'alert') {
      this.alerts = this.alerts.filter(a => a.id !== s.alert.id);
      if (input === 'back' || (input === 'select' && this.cursor === 1)) { this.finish(); return null; }
      if (input === 'up' || input === 'down') { this.cursor = input === 'down' ? 1 : 0; this.alerts.unshift(s.alert); return null; }
      const target = s.alert.open;
      if (target.kind === 'agent') this.notices = this.notices.filter(n => n.key !== target.key);
      this.go(target);
      if (target.kind === 'chat') { this.chatLines = null; return { kind: 'loadChat', id: target.id }; }
      return null;
    }
    // Double-tap out of something a pop-up opened returns to where you were.
    if (input === 'back' && this.returnTo && ['agent', 'chat'].includes(s.kind)) { this.finish(); return null; }
    if (s.kind === 'listen') {
      if (input === 'back') { this.go(s.reminder ? { kind: 'home' } : s.chat ? { kind: 'chat', ...s.chat } : s.muse ? { kind: 'muse' } : s.start ? { kind: 'agents' } : { kind: 'agent', key: s.key }); return { kind: 'cancelMic' }; }
      if (input === 'select' && !s.thinking) { this.screen = { ...s, thinking: true }; return { kind: 'stopMic' }; }
      return null;
    }
    if (input === 'back') {
      // One double-tap always gets you home; only a chat and the reply/confirm steps go back one level.
      if (s.kind === 'chat') this.go({ kind: 'messages' });
      else if (s.kind === 'textReply') this.go({ kind: 'chat', id: s.id, name: s.name });
      else if (s.kind === 'confirm' && s.chat) this.go({ kind: 'chat', ...s.chat });
      else if (s.kind === 'confirm' && s.muse) this.go({ kind: 'muse' });
      else if (s.kind === 'confirm' && s.reminder) this.go({ kind: 'home' });
      else if ((s.kind === 'confirm' && s.start) || s.kind === 'newAgent') this.go({ kind: 'agents' });
      else if (s.kind === 'reply' || s.kind === 'confirm') this.go({ kind: 'agent', key: s.key });
      else this.go({ kind: 'home' });
      return null;
    }
    if (s.kind === 'chat') {
      // A text conversation: tap replies by voice, swipe scrolls, swipe down at the newest opens quick texts.
      const chat = { id: s.id, name: s.name };
      if (input === 'select') {
        if (this.data?.voice) { this.go({ kind: 'listen', key: '', thinking: false, chat }); return { kind: 'startMic' }; }
        this.go({ kind: 'textReply', ...chat });
        return null;
      }
      const max = Math.max(0, (this.chatLines?.length ?? 0) - BODY_LINES);
      if (input === 'up') this.scroll = Math.max(0, this.scroll - 3);
      if (input === 'down') {
        if (this.chatAtBottom()) this.go({ kind: 'textReply', ...chat });
        else this.scroll = Math.min(max, this.scroll + 3);
      }
      return null;
    }
    if (s.kind === 'textReply' && input === 'select') {
      const text = ['Back', ...QUICK_TEXTS][this.cursor];
      if (text === 'Back') { this.go({ kind: 'chat', id: s.id, name: s.name }); return null; }
      // A text is one and done: if a pop-up brought you here, sending closes it.
      if (this.returnTo && text) this.finish();
      else this.go({ kind: 'chat', id: s.id, name: s.name });
      return text ? { kind: 'sendText', chat: s.id, name: s.name, text } : null;
    }
    if (s.kind === 'confirm' && s.chat && input === 'select') {
      const choice = CONFIRM_CHOICES[this.cursor];
      if (choice === 'Talk again') { this.go({ kind: 'listen', key: '', thinking: false, chat: s.chat }); return { kind: 'startMic' }; }
      if (choice === 'Send' && this.returnTo) this.finish();
      else this.go({ kind: 'chat', ...s.chat });
      return choice === 'Send' ? { kind: 'sendText', chat: s.chat.id, name: s.chat.name, text: s.text } : null;
    }
    if (s.kind === 'confirm' && s.reminder && input === 'select') {
      const choice = CONFIRM_CHOICES[this.cursor];
      if (choice === 'Talk again') { this.go({ kind: 'listen', key: '', thinking: false, reminder: true }); return { kind: 'startMic' }; }
      this.go({ kind: 'home' });
      return choice === 'Send' ? { kind: 'addReminder', title: s.text } : null;
    }
    if (s.kind === 'confirm' && s.muse && input === 'select') {
      const choice = CONFIRM_CHOICES[this.cursor];
      if (choice === 'Talk again') { this.go({ kind: 'listen', key: '', thinking: false, muse: true }); return { kind: 'startMic' }; }
      this.go({ kind: 'muse' });
      if (choice !== 'Send') return null;
      this.museLines = [...wrap(`You: ${s.text}`), '', 'Muse is thinking…'];
      return { kind: 'askMuse', text: s.text };
    }
    if (s.kind === 'newAgent' && input === 'select') {
      if (!s.agent) {
        const agent = this.data?.machines.find(m => m.name === s.machine)?.canStart?.[this.cursor];
        if (!agent) return null;
        this.go({ kind: 'newAgent', machine: s.machine, agent, folders: null });
        return { kind: 'loadFolders', machine: s.machine };
      }
      const folder = s.folders?.[this.cursor];
      if (!folder) return null;
      const start = { machine: s.machine, agent: s.agent, folder };
      if (this.data?.voice) { this.go({ kind: 'listen', key: '', thinking: false, start }); return { kind: 'startMic' }; }
      this.go({ kind: 'confirm', key: '', text: '', start });
      return null;
    }
    if (s.kind === 'confirm' && s.start && input === 'select') {
      const choice = CONFIRM_CHOICES[this.cursor];
      if (choice === 'Talk again') { this.go({ kind: 'listen', key: '', thinking: false, start: s.start }); return { kind: 'startMic' }; }
      this.go({ kind: 'agents' });
      if (choice !== 'Send') return null;
      this.showFlash(`Starting ${cap(s.start.agent)} on ${s.start.machine}…`, nowMs);
      return { kind: 'startAgent', ...s.start, text: s.text };
    }
    if (s.kind === 'muse' && input === 'select') {
      if (!this.data?.voice) return null;
      this.go({ kind: 'listen', key: '', thinking: false, muse: true });
      return { kind: 'startMic' };
    }
    if (s.kind === 'studio') {
      const lines = this.studioLines(nowMs) ?? [];
      const max = Math.max(0, lines.length - BODY_LINES);
      if (input === 'up') this.scroll = Math.max(0, this.scroll - 3);
      if (input === 'down') this.scroll = Math.min(max, this.scroll + 3);
      return null;
    }
    if (s.kind === 'muse') {
      const lines = this.museLines ?? [];
      const max = Math.max(0, lines.length - BODY_LINES);
      if (input === 'up') this.scroll = Math.max(0, this.scroll - 3);
      if (input === 'down') this.scroll = Math.min(max, this.scroll + 3);
      return null;
    }
    if (s.kind === 'agent') {
      // Terminal view: tap talks, swipe up scrolls back, swipe down at the bottom opens replies.
      const x = this.session();
      if (!x) return null;
      const total = this.terminalLines()?.length ?? 0;
      if (input === 'up') { this.termScroll = Math.min(this.termScroll + 3, Math.max(0, total - TERM_LINES)); return null; }
      if (input === 'down') {
        if (this.termScroll > 0) { this.termScroll = Math.max(0, this.termScroll - 3); return null; }
        if (this.replyChoices(x).length) this.go({ kind: 'reply', key: s.key });
        return null;
      }
      if (x.desktopSession && input === 'select') {
        this.showFlash('Opening it on the glasses…', nowMs);
        return { kind: 'continueSession', machine: x.machine, session: x.desktopSession };
      }
      if (talkable(x) && this.data?.voice) { this.go({ kind: 'listen', key: s.key, thinking: false }); return { kind: 'startMic' }; }
      if (this.replyChoices(x).length) this.go({ kind: 'reply', key: s.key });
      return null;
    }
    const rows = this.listRows(nowMs).filter(r => !r.header);
    if (input === 'up') { this.cursor = Math.max(0, this.cursor - 1); return null; }
    if (input === 'down') { this.cursor = Math.min(Math.max(0, rows.length - 1), this.cursor + 1); return null; }
    // select
    if (s.kind === 'approval') {
      const choice = APPROVAL_CHOICES[this.cursor];
      this.finish();
      return choice ? { kind: 'decide', machine: s.machine, id: s.id, behavior: choice.behavior } : null;
    }
    if (s.kind === 'reply' || s.kind === 'confirm') {
      const session = this.session();
      if (!session) { this.go({ kind: 'agents' }); return null; }
      const target = { kind: 'prompt' as const, machine: session.machine, pane: session.pane ?? '', ...(session.window ? { window: session.window } : {}), ...(session.appThread ? { appThread: session.appThread } : {}) };
      if (s.kind === 'reply') {
        const text = this.replyChoices(session)[this.cursor];
        this.go({ kind: 'agent', key: s.key });
        if (!text || text === 'Back') return null;
        if (text.startsWith('Show on screen')) return { kind: 'focus', machine: session.machine, workspace: session.workspace };
        return text === 'Stop (Esc)' ? { ...target, key: 'Escape' } : { ...target, text };
      }
      const choice = CONFIRM_CHOICES[this.cursor];
      if (choice === 'Send') { this.go({ kind: 'agent', key: s.key }); return { ...target, text: s.text }; }
      if (choice === 'Talk again') { this.go({ kind: 'listen', key: s.key, thinking: false }); return { kind: 'startMic' }; }
      this.go({ kind: 'agent', key: s.key });
      return null;
    }
    if (s.kind === 'workspaces') {
      const w = this.workspaceRows()[this.cursor];
      return w ? { kind: 'focus', machine: w.machine, workspace: String(w.id) } : null;
    }
    const target = rows[this.cursor]?.open;
    if (!target) return null;
    if (target.kind === 'tiles') return { kind: 'openTiles' };
    if (target.kind === 'agent') this.notices = this.notices.filter(n => n.key !== target.key);
    this.go(target);
    if (target.kind === 'chat') { this.chatLines = null; return { kind: 'loadChat', id: target.id }; }
    if (target.kind === 'muse') { this.museLines = null; return { kind: 'loadMuse' }; }
    return null;
  }

  private header(nowMs: number, timeZone?: string): string {
    if (this.flash.text && nowMs < this.flash.until) return this.flash.text;
    const parts = [clock(nowMs, timeZone)];
    const w = this.data?.weather;
    if (w) parts.push(`${w.temp}° ${w.desc}${w.rainAt ? ` · rain ${w.rainAt}` : ''}`);
    if (this.battery !== undefined) parts.push(`${this.battery}%`);
    if (this.data?.paused) parts.push('approvals paused');
    return clip(parts.join('   '));
  }

  private list(rows: Row[]): string[] {
    const items = rows.filter(r => !r.header);
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
    const selected = rows.indexOf(items[this.cursor]);
    const start = Math.min(Math.max(0, selected - Math.floor(LIST_ROWS / 2)), Math.max(0, rows.length - LIST_ROWS));
    return rows.slice(start, start + LIST_ROWS).map((r, i) => r.header ? r.text : `${start + i === selected ? '>' : ' '} ${r.text}`);
  }

  private studioLines(nowMs: number): string[] | null {
    const st = this.data?.studio;
    return st ? studioText(st, nowMs) : null;
  }

  private body(lines: string[] | null, loading: string): string[] {
    if (lines === null) return [loading];
    const view = lines.slice(this.scroll, this.scroll + BODY_LINES);
    if (this.scroll + BODY_LINES < lines.length) view.push('  ▼');
    return view;
  }

  /** The full text block for the glasses. */
  render(nowMs: number, timeZone?: string): string {
    const lines = [this.header(nowMs, timeZone), ''];
    const s = this.screen;
    if (!this.data) {
      lines.push(this.error || 'Connecting to your computers…');
      return lines.join('\n');
    }
    if (s.kind === 'home') {
      lines.push(...this.list(this.homeRows(nowMs)));
      const offline = this.data.machines.filter(m => !m.online).map(m => m.name);
      if (this.error) lines.push(clip(`Offline: ${this.error}`));
      else if (offline.length) lines.push(`Offline: ${offline.join(', ')}`);
    } else if (s.kind === 'needs') {
      lines[0] = 'HOME › NEEDS YOU';
      const rows = this.needsRows();
      lines.push(...(rows.length ? this.list(rows) : ['Nothing is waiting on you.']));
    } else if (s.kind === 'agents') {
      lines[0] = 'HOME › AGENTS';
      const rows = this.agentRows(nowMs);
      lines.push(...(rows.some(r => !r.header) ? this.list(rows) : ['No agents running right now.']));
    } else if (s.kind === 'approval') {
      const p = this.currentPending();
      lines[0] = clip(`APPROVE? ${cap(p?.agent ?? '')} on ${s.machine} · ${p?.page ?? ''}`);
      lines.push(...wrap(`${p?.tool ?? ''}: ${p?.summary ?? ''}`).slice(0, 4), '');
      lines.push(...this.list(this.listRows(nowMs)));
    } else if (s.kind === 'agent') {
      const x = this.session();
      if (!x) lines.push('This session has ended.');
      else {
        const promptable = talkable(x);
        lines.splice(0, 2, clip(`${x.name.toUpperCase()} · ${x.machine} · ${x.page || 'no project'} · ${STATE_WORD[x.state] ?? x.state}`));
        if (x.desktopSession) {
          lines.push('', clip(`"${x.page}" is open in the Claude app on ${x.machine}.`), '', 'Tap to continue it on the glasses: same', 'conversation, in a session Home can reach.', '', 'tap: continue on glasses');
        } else if (!promptable) {
          lines.push('', clip(`This chat is in the ${x.agent === 'codex' ? 'Codex' : 'Claude'} app, so it can't`), clip(`be shown or prompted here. Use one under Talk.`));
          if (x.workspace) lines.push('', '▼ swipe down: show on screen');
        } else {
          const all = this.terminalLines();
          if (all === null) lines.push('Loading…');
          else {
            const end = all.length - this.termScroll;
            const start = Math.max(0, end - TERM_LINES);
            const view = all.slice(start, end);
            lines.push(...view, ...Array(TERM_LINES - view.length).fill(''));
            // Scrolled back: the time of the message on screen and of the newest one, so you can tell how far back you are.
            const timeAt = (i: number) => { for (; i >= 0; i--) { const t = all[i].match(BAR_TIME); if (t) return t[1]; } return ''; };
            const firstBar = view.findIndex(l => BAR_TIME.test(l));
            const reading = timeAt(firstBar >= 0 ? start + firstBar : start);
            const newest = timeAt(all.length - 1);
            if (this.termScroll) lines.push(reading && newest ? `${reading} · newest ${newest} · ▼ newer` : 'swipe up: scroll · down: newer');
          }
          if (!this.termScroll || all === null) lines.push(`${this.data.voice ? 'tap: talk · ' : ''}swipe up: scroll · down: quick replies`);
        }
      }
    } else if (s.kind === 'workspaces') {
      lines[0] = `AGENTS › ${s.machine ? `${s.machine.toUpperCase()} ` : ''}WORKSPACES`;
      const rows = this.listRows(nowMs);
      lines.push(...(rows.length ? this.list(rows) : ['No workspaces reported.']));
    } else if (s.kind === 'alert') {
      const more = this.alerts.filter(a => a.id !== s.alert.id).length;
      lines[0] = clip(`${s.alert.title}${more ? `  (+${more})` : ''}`);
      lines.push(...wrap(s.alert.detail).slice(0, 4), '', `${this.cursor === 0 ? '>' : ' '} Open`, `${this.cursor === 1 ? '>' : ' '} Later`, '', this.cursor === 0 ? 'tap: open · double-tap: later' : 'swipe up: Open · tap: later');
    } else if (s.kind === 'textReply') {
      lines[0] = clip(`QUICK TEXT → ${s.name}`);
      lines.push(...this.list(this.listRows(nowMs)));
    } else if (s.kind === 'newAgent') {
      lines[0] = clip(`NEW AGENT · ${s.machine}`);
      if (s.agent && !s.folders) lines.push('Loading folders…');
      else {
        lines.push(s.agent ? `${cap(s.agent)} · pick a folder` : 'Pick an agent');
        lines.push(...this.list(this.listRows(nowMs)));
      }
      lines.push('', 'Full access: it works without asking you');
    } else if ((s.kind === 'confirm' || s.kind === 'listen') && s.start) {
      const where = `${cap(s.start.agent)} on ${s.start.machine} · ${s.start.folder}`;
      if (s.kind === 'listen') {
        lines[0] = clip(`NEW ${where}`);
        lines.push(s.thinking ? 'Turning speech into text…' : 'Listening… say what it should do.', '', s.thinking ? '' : 'Tap when done. Double-tap to cancel.');
      } else {
        lines[0] = clip(`START ${where.toUpperCase()}?`);
        lines.push(...(s.text ? wrap(`"${s.text}"`).slice(0, 3) : ['(no task; it will wait for you)']), 'Full access: no approvals', '');
        lines.push(...this.list(this.listRows(nowMs)));
      }
    } else if ((s.kind === 'confirm' || s.kind === 'listen') && s.reminder) {
      if (s.kind === 'listen') {
        lines[0] = 'ADD REMINDER';
        lines.push(s.thinking ? 'Turning speech into text…' : 'Listening… say the reminder.', '', s.thinking ? '' : 'Tap when done. Double-tap to cancel.');
      } else {
        lines[0] = 'ADD REMINDER?';
        lines.push(...wrap(`"${s.text}"`).slice(0, 4), '');
        lines.push(...this.list(this.listRows(nowMs)));
      }
    } else if ((s.kind === 'confirm' || s.kind === 'listen') && s.muse) {
      if (s.kind === 'listen') {
        lines[0] = 'ASK MUSE';
        lines.push(s.thinking ? 'Turning speech into text…' : 'Listening… ask Muse anything.', '', s.thinking ? '' : 'Tap when done. Double-tap to cancel.');
      } else {
        lines[0] = 'ASK MUSE?';
        lines.push(...wrap(`"${s.text}"`).slice(0, 4), '');
        lines.push(...this.list(this.listRows(nowMs)));
      }
    } else if ((s.kind === 'confirm' || s.kind === 'listen') && s.chat) {
      if (s.kind === 'listen') {
        lines[0] = clip(`TEXT → ${s.chat.name}`);
        lines.push(s.thinking ? 'Turning speech into text…' : 'Listening… speak your text.', '', s.thinking ? '' : 'Tap when done. Double-tap to cancel.');
      } else {
        lines[0] = clip(`TEXT TO ${s.chat.name.toUpperCase()}?`);
        lines.push(...wrap(`"${s.text}"`).slice(0, 4), '');
        lines.push(...this.list(this.listRows(nowMs)));
      }
    } else if (s.kind === 'reply' || s.kind === 'confirm' || s.kind === 'listen') {
      const x = this.session();
      const who = x ? `${x.name} · ${x.machine}` : 'agent';
      if (s.kind === 'reply') {
        lines[0] = clip(`QUICK REPLY → ${who}`);
        lines.push(...this.list(this.listRows(nowMs)));
      } else if (s.kind === 'listen') {
        lines[0] = clip(`TALK → ${who}`);
        lines.push(s.thinking ? 'Turning speech into text…' : 'Listening… speak now.', '', s.thinking ? '' : 'Tap when done. Double-tap to cancel.');
      } else {
        lines[0] = clip(`SEND TO ${who.toUpperCase()}?`);
        lines.push(...wrap(`"${s.text}"`).slice(0, 4), '');
        lines.push(...this.list(this.listRows(nowMs)));
      }
    } else if (s.kind === 'messages') {
      lines[0] = 'HOME › MESSAGES';
      const rows = this.listRows(nowMs);
      lines.push(...(rows.length ? this.list(rows) : ['No recent texts.']));
      lines.push('Tap a chat to read and reply');
    } else if (s.kind === 'chat') {
      lines[0] = clip(`MESSAGES › ${s.name}`);
      lines.push(...this.body(this.chatLines, 'Loading…'));
      if (this.chatLines) lines.push(this.chatAtBottom() ? `${this.data.voice ? 'tap: reply by voice · ' : ''}swipe up: scroll · down: quick texts` : 'swipe up/down: scroll');
    } else if (s.kind === 'studio') {
      lines[0] = 'HOME › STUDIO';
      lines.push(...this.body(this.studioLines(nowMs), 'Studio Routing is not running on the laptop.'), 'swipe: scroll');
    } else if (s.kind === 'muse') {
      lines[0] = 'HOME › MUSE';
      lines.push(...this.body(this.museLines, 'Reading Muse…'), this.data.voice ? 'tap: ask Muse by voice · swipe: scroll' : 'swipe: scroll');
    }
    // Short confirmations ("Sent", "Allowed", "… finished") replace the title on every page.
    if (this.flash.text && nowMs < this.flash.until) lines[0] = clip(this.flash.text);
    return lines.slice(0, MAX_LINES).join('\n');
  }
}

function cap(text: string): string { return text ? text[0].toUpperCase() + text.slice(1) : text; }
