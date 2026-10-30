// Tiles: Omarchy-style pages on the glasses. Five pages, each two tiles side by side; any
// Home "app" (a widget) can go in any tile. Like model.ts, this file is free of the SDK and
// the network so it can be tested on its own. docs/TILES.md describes the format for other apps.
//
// CONTRACT (set by the architect; changing a type here is a breaking change: tell the
// architect first). The implementation below the line is the main session's.
import { MUSE_UNREACHABLE } from './musecache';
import { clip, clock, conversationLines, museDisplay, recentChats, sessionKey, studioText, STATE_WORD, wrap } from './model';
import type { Action, Chat, HomeData, Input, Session } from './model';
import { clockTime, mmss } from './conversation';
import type { ConvView } from './conversation';

/** One tile is 288 px wide: 27 characters, 9 lines, title included. More lines make the glasses auto-scroll and swallow swipes. */
export const TILE_WIDTH = 27;
export const TILE_LINES = 9;
export const PAGE_COUNT = 5;

/**
 * Widget ids, as stored in the layout:
 *   agent:<machine>/<pane-or-agent>  a terminal tail; matches a pane first, else the newest session of that agent there
 *   muse | messages | approvals | studio | clock | reminders | conversation | empty
 *   chat:<id> | chat:recent          one Messages thread (chat:recent = the newest thread)
 *   url:<endpoint>                   a plug-in: GET returns UrlTile; an action is POSTed back (through the hub)
 */
export type WidgetId = string;
export type WidgetKind = 'agent' | 'muse' | 'chat' | 'messages' | 'approvals' | 'studio' | 'clock' | 'reminders' | 'conversation' | 'url' | 'empty';

export interface PageLayout { left: WidgetId; right: WidgetId }
export interface Layout { pages: PageLayout[] } // always PAGE_COUNT pages

/** Used when the hub has no layout.json yet. The hub (GET /api/layout) returns the same default. */
export const DEFAULT_LAYOUT: Layout = {
  pages: [
    { left: 'muse', right: 'agent:Dell/claude' },
    { left: 'chat:recent', right: 'agent:Mini 1/codex' },
    { left: 'reminders', right: 'studio' },
    { left: 'approvals', right: 'messages' },
    { left: 'clock', right: 'empty' },
  ],
};

/** What a url: endpoint returns. */
export interface UrlTile { title: string; lines: string[]; actions?: { label: string; id: string }[] }

/** An Apple Reminders item, as the hub passes it on from the Mini 1 relay. */
export interface Reminder {
  id: string; title: string; due: string | null; list: string;
  /** Due time in ms (for sorting; `due` is the short label), null if none. Optional: older hubs don't send it. */
  dueAt?: number | null;
  /** When the hub first saw this reminder, in ms: a stand-in for "added" (the relay doesn't send a creation date). */
  added?: number;
}

/** Everything a widget may read. The tiles model never fetches; main.ts fills these in. */
export interface TileContext {
  data: HomeData | null;
  now: number;
  timeZone?: string;
  battery?: number;
  /** Raw terminal lines for a session key (same format as /api/terminal), or null if not loaded yet. */
  terminal(key: string): string[] | null;
  chat(id: number): string[] | null;
  muse(): { question: string; reply: string } | null;
  reminders(): Reminder[] | null;
  url(endpoint: string): UrlTile | null;
  /** The Conversation tile's state. Optional: without it the tile says it is not available. */
  conversation?(): ConvView | null;
  /** Which hub Home talks to, for the clock tile ("via Mini 1"); down = no allowed hub answers. Optional. */
  hub?: { name: string | null; down: boolean };
  /** What was just sent to the agent in this pane ("sent to Claude"), for a few seconds. Optional. */
  sent?(pane: string): string | null;
}

/** Something the tile asks for in the background so it can render: main.ts polls these for the visible page. */
export type TileNeed =
  | { kind: 'terminal'; machine: string; pane: string; window?: string; appThread?: string; key: string }
  | { kind: 'chat'; id: number }
  | { kind: 'muse' }
  | { kind: 'reminders' }
  | { kind: 'conversation' }
  | { kind: 'url'; endpoint: string };

/** A full Home screen a tile can open (then double-tap there returns to Tiles). */
export type OpenTarget =
  | { kind: 'agent'; key: string; then?: 'listen' | 'reply' }
  | { kind: 'chat'; id: number; name: string; then?: 'listen' | 'textReply' }
  | { kind: 'muse'; then?: 'listen'; fromTile?: true }
  | { kind: 'messages' } | { kind: 'needs' } | { kind: 'studio' } | { kind: 'home' }
  | { kind: 'reminderAdd' };

/** What an action does: a Home action (send, decide, ...), open a full screen, or something tiles-only. */
export type TileEffect =
  | { kind: 'action'; action: Action }
  | { kind: 'open'; target: OpenTarget }
  | { kind: 'reminderDone'; id: string }
  | { kind: 'conversation'; op: 'start' | 'stop' | 'sendMuse' }
  | { kind: 'urlAction'; endpoint: string; id: string };

export interface TileAction { id: string; label: string }

/**
 * The widget contract. Scrolling, focus and the action list are handled by the tiles model, the
 * same for every widget; a widget only says what it shows and what its actions do.
 */
export interface Widget {
  id: WidgetId;
  kind: WidgetKind;
  /** Short title, shown on the tile's first line and in the page header. */
  title(ctx: TileContext): string;
  /** The tile's body, already wrapped to `width`; may be longer than `lines` (the model scrolls). Newest last. */
  body(ctx: TileContext, width: number): string[];
  /** Actions for the tap menu. The model always adds "Full screen". */
  actions(ctx: TileContext): TileAction[];
  act(actionId: string, ctx: TileContext): TileEffect | null;
  /** Optional: what a tap does straight away instead of opening the action menu (null = open the menu). */
  tap?(ctx: TileContext): TileEffect | null;
  needs(ctx: TileContext): TileNeed[];
}

/** One frame of the tiled page: each tile is at most TILE_LINES lines of at most TILE_WIDTH characters. */
export interface TilesFrame { page: number; focus: 'page' | 'choose-left' | 'choose-right' | 'left' | 'right'; left: string; right: string }

/** What a gesture led to. */
export type TilesResult = TileEffect | { kind: 'exit' } | null;

/** The Tiles state machine (implemented below by the main session). */
export interface TilesApi {
  setLayout(layout: Layout): void;
  input(input: Input, ctx: TileContext): TilesResult;
  render(ctx: TileContext): TilesFrame;
  needs(ctx: TileContext): TileNeed[];
}


// ---- implementation (main session) ----

const W = TILE_WIDTH;
const BODY_LINES = TILE_LINES - 1;
const FULL = 'full';
const fmt = (ms: number, tz: string | undefined, opts: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString('en-US', { ...opts, timeZone: tz });
const noNeeds = () => [];

function empty(id: WidgetId, kind: WidgetKind, title: string): Widget {
  return { id, kind, title: () => title, body: () => [], actions: () => [], act: () => null, needs: noNeeds };
}

// What a pinned agent tile remembers between frames: which kind of agent its session was, and when it moved.
const kindSeen = new Map<string, string>();
const movedAt = new Map<string, number>();
const MOVED_NOTE_MS = 60_000;
/** For tests: forget what pinned tiles remember. */
export function resetAgentMemory(): void { kindSeen.clear(); movedAt.clear(); }

const AGENT_KINDS = ['claude', 'codex', 'hermes'];
const live = (s: Session) => Boolean(s.pane || s.window);

/**
 * The session an agent:<machine>/<ref> tile follows.
 *  - The exact pane, window or session wins whenever it exists (and is remembered as that kind of agent).
 *  - A plain agent name (claude, codex): that agent's best session there: a pane, then a window, then an app thread,
 *    then a finished rollout; newest among equals.
 *  - A pinned ref whose session is gone falls back to the same kind of agent on that machine: working or needing you,
 *    then idle, then the rest; a pane or window before an app thread; newest. `moved` says it is no longer the pinned one.
 */
export function findSession(data: HomeData | null, ref: string, now: number): { session?: Session; moved: boolean } {
  if (!data) return { moved: false };
  const exact = data.sessions.find(s => sessionKey(s) === ref || (s.pane && `${s.machine}/${s.pane}` === ref) || (s.window && `${s.machine}/${s.window}` === ref));
  if (exact) {
    kindSeen.set(ref, exact.agent.toLowerCase());
    movedAt.delete(ref);
    return { session: exact, moved: false };
  }
  const slash = ref.indexOf('/');
  const machine = ref.slice(0, slash);
  const name = ref.slice(slash + 1).toLowerCase();
  // The orchestrator is only ever found by its exact ref (or its own tile), never as "the Claude on this computer".
  const onMachine = data.sessions.filter(s => s.machine === machine && s.pane !== 'orchestrator');
  const byName = onMachine.filter(s => s.agent.toLowerCase() === name || s.name.toLowerCase() === name);
  if (byName.length || AGENT_KINDS.includes(name)) {
    const rank = (s: Session) => (s.pane ? 0 : s.window ? 1 : s.appThread ? 2 : 3);
    return { session: byName.sort((a, b) => rank(a) - rank(b) || b.at - a.at)[0], moved: false };
  }
  const kind = kindSeen.get(ref) ?? 'claude';
  const state = (s: Session) => (s.state === 'working' || s.state === 'attention' ? 0 : s.state === 'idle' ? 1 : 2);
  const rank = (s: Session) => (live(s) ? 0 : s.appThread ? 1 : 2);
  const session = onMachine
    .filter(s => s.agent.toLowerCase() === kind)
    .sort((a, b) => state(a) - state(b) || rank(a) - rank(b) || b.at - a.at)[0];
  if (session && !movedAt.has(ref)) movedAt.set(ref, now);
  if (!session) movedAt.delete(ref);
  return { session, moved: Boolean(session) };
}

/** The orchestrator tile: the Claude session the laptop node reports with pane 'orchestrator'. Same read view and replies as its Home row. */
const isOrch = (s: Session) => s.pane === 'orchestrator';
function agentWidget(id: WidgetId): Widget {
  const orch = id === 'orchestrator';
  const ref = orch ? 'orchestrator' : id.slice('agent:'.length);
  const resolve = (ctx: TileContext): { session?: Session; moved: boolean } => (orch ? { session: ctx.data?.sessions.find(isOrch), moved: false } : findSession(ctx.data, ref, ctx.now));
  const find = (ctx: TileContext) => resolve(ctx).session;
  const talkable = (s: Session) => Boolean(s.pane || s.window || s.appThread);
  const target = (s: Session) => ({ machine: s.machine, pane: s.pane ?? '', ...(s.window ? { window: s.window } : {}), ...(s.appThread ? { appThread: s.appThread } : {}) });
  return {
    id, kind: 'agent',
    title: ctx => {
      const { session: s, moved } = resolve(ctx);
      if (!s) return orch ? 'Orchestrator' : ref.slice(ref.indexOf('/') + 1);
      const sent = orch && s.pane ? ctx.sent?.(s.pane) : null;
      if (sent) return sent;
      const note = moved && ctx.now - (movedAt.get(ref) ?? ctx.now) < MOVED_NOTE_MS ? ` (moved to ${s.page})` : '';
      return `${s.name || s.agent} · ${STATE_WORD[s.state] ?? s.state}${note}`;
    },
    body: (ctx, width) => {
      const s = find(ctx);
      if (!s && orch) return ctx.data ? [ctx.data.machines.find(m => m.name === 'Dell')?.online === true ? 'Orchestrator is not running.' : 'laptop offline'] : ['Loading…'];
      if (!s) return ctx.data ? ['No such agent right now.', ref] : ['Loading…'];
      const raw = ctx.terminal(sessionKey(s));
      return raw === null ? ['Loading…'] : conversationLines(raw, width);
    },
    actions: ctx => {
      const s = find(ctx);
      if (!s || !talkable(s)) return [];
      return [{ id: 'listen', label: 'Reply by voice' }, { id: 'reply', label: 'Quick reply' }, { id: 'continue', label: 'Continue' }, ...(isOrch(s) ? [] : [{ id: 'esc', label: 'Stop (Esc)' }])];
    },
    act: (actionId, ctx) => {
      const s = find(ctx);
      if (!s) return null;
      const key = sessionKey(s);
      if (actionId === FULL) return { kind: 'open', target: { kind: 'agent', key } };
      if (!talkable(s)) return null;
      if (actionId === 'listen') return { kind: 'open', target: { kind: 'agent', key, then: 'listen' } };
      if (actionId === 'reply') return { kind: 'open', target: { kind: 'agent', key, then: 'reply' } };
      if (actionId === 'continue') return { kind: 'action', action: { kind: 'prompt', ...target(s), text: 'Continue' } };
      if (actionId === 'esc' && !isOrch(s)) return { kind: 'action', action: { kind: 'prompt', ...target(s), key: 'Escape' } };
      return null;
    },
    needs: ctx => {
      const s = find(ctx);
      return s ? [{ kind: 'terminal', ...target(s), key: sessionKey(s) }] : [];
    },
  };
}

function museWidget(): Widget {
  return {
    id: 'muse', kind: 'muse',
    title: () => 'Muse',
    body: (ctx, width) => {
      if (ctx.data && !ctx.data.muse) return wrap('Muse is not set up.', width);
      const raw = ctx.muse();
      if (!raw) return ['Loading…'];
      if (raw === MUSE_UNREACHABLE) return ["Muse: can't reach"];
      // The question (at most two lines), a blank, then the answer from its start; swipe scrolls on.
      const m = museDisplay(raw.question, raw.reply);
      const q = wrap(`You: ${m.question}`, width);
      const question = q.length > 2 ? [q[0], `${q[1].slice(0, width - 1)}…`] : q;
      return [...question, '', ...(m.reply ? wrap(m.reply, width) : ['Muse is thinking…'])];
    },
    actions: ctx => [...(ctx.muse() === MUSE_UNREACHABLE ? [{ id: 'retry', label: 'Retry' }] : []), { id: 'ask', label: 'Ask Muse' }],
    act: actionId => {
      if (actionId === 'retry') return { kind: 'action', action: { kind: 'loadMuse' } };
      if (actionId === 'ask') return { kind: 'open', target: { kind: 'muse', then: 'listen', fromTile: true } };
      return actionId === FULL ? { kind: 'open', target: { kind: 'muse' } } : null;
    },
    needs: () => [{ kind: 'muse' }],
  };
}

/**
 * The chat list the tiles see. Old chats (24 h+) are dropped when `on`, except those a tile is pinned to by id
 * (chat:<id>): they stay, marked `old`, so the pinned tile still shows its last message. The Messages tile and
 * chat:recent skip the marked ones.
 */
export function tileChats(chats: Chat[], layout: Layout, nowMs: number, on: boolean): Chat[] {
  if (!on) return chats;
  const pinned = new Set(layout.pages.flatMap(p => [p.left, p.right]).filter(w => /^chat:\d+$/.test(w)).map(w => Number(w.slice(5))));
  const recent = new Set(recentChats(chats, nowMs, true));
  return chats.filter(c => recent.has(c) || pinned.has(c.id)).map(c => (recent.has(c) ? c : { ...c, old: true }));
}

function chatWidget(id: WidgetId): Widget {
  const ref = id.slice('chat:'.length);
  const find = (ctx: TileContext) => {
    const chats = ctx.data?.messages ?? [];
    return ref === 'recent' ? [...chats].filter(c => !c.old).sort((a, b) => b.when - a.when)[0] : chats.find(c => String(c.id) === ref);
  };
  return {
    id, kind: 'chat',
    title: ctx => find(ctx)?.name ?? 'Chat',
    body: (ctx, width) => {
      const c = find(ctx);
      if (!c) return ctx.data?.messages ? [ref === 'recent' ? 'No recent chats.' : 'No such chat.'] : ['Loading…'];
      const lines = ctx.chat(c.id);
      return lines === null ? ['Loading…'] : lines.flatMap(line => (line ? wrap(line, width) : ['']));
    },
    actions: ctx => (find(ctx) ? [{ id: 'listen', label: 'Reply by voice' }, { id: 'text', label: 'Quick text' }] : []),
    act: (actionId, ctx) => {
      const c = find(ctx);
      if (!c) return null;
      if (actionId === FULL) return { kind: 'open', target: { kind: 'chat', id: c.id, name: c.name } };
      if (actionId === 'listen') return { kind: 'open', target: { kind: 'chat', id: c.id, name: c.name, then: 'listen' } };
      if (actionId === 'text') return { kind: 'open', target: { kind: 'chat', id: c.id, name: c.name, then: 'textReply' } };
      return null;
    },
    needs: ctx => { const c = find(ctx); return c ? [{ kind: 'chat', id: c.id }] : []; },
  };
}

function messagesWidget(): Widget {
  const chats = (ctx: TileContext) => [...(ctx.data?.messages ?? [])].filter(c => !c.old).sort((a, b) => b.when - a.when);
  return {
    id: 'messages', kind: 'messages',
    title: ctx => { const n = chats(ctx).filter(c => c.unread).length; return n ? `Messages · ${n} new` : 'Messages'; },
    body: ctx => {
      if (!ctx.data?.messages) return ['Loading…'];
      if (!chats(ctx).length) return ['No messages.'];
      return chats(ctx).map(c => clip(`${c.unread ? '•' : ' '} ${c.name}: ${c.snippet}`, W));
    },
    actions: ctx => chats(ctx).slice(0, 5).map(c => ({ id: `chat:${c.id}`, label: clip(c.name, W - 2) })),
    act: (actionId, ctx) => {
      if (actionId === FULL) return { kind: 'open', target: { kind: 'messages' } };
      const c = chats(ctx).find(x => `chat:${x.id}` === actionId);
      return c ? { kind: 'open', target: { kind: 'chat', id: c.id, name: c.name } } : null;
    },
    needs: noNeeds,
  };
}

function approvalsWidget(): Widget {
  const first = (ctx: TileContext) => ctx.data?.pending[0];
  return {
    id: 'approvals', kind: 'approvals',
    title: ctx => { const n = ctx.data?.pending.length ?? 0; return n ? `Needs you · ${n}` : 'Needs you'; },
    body: (ctx, width) => {
      if (!ctx.data) return ['Loading…'];
      if (!ctx.data.pending.length) return ['Nothing is waiting on you.'];
      return ctx.data.pending.flatMap((p, i) => [...(i ? [''] : []), ...wrap(`${p.agent} on ${p.machine}: ${p.tool} ${p.summary}`, width)]);
    },
    // The safe choice first, like the full approval screen.
    actions: ctx => (first(ctx) ? [{ id: 'desk', label: 'Leave for desk' }, { id: 'deny', label: 'Deny' }, { id: 'allow', label: 'Allow' }] : []),
    act: (actionId, ctx) => {
      if (actionId === FULL) return { kind: 'open', target: { kind: 'needs' } };
      const p = first(ctx);
      if (!p || (actionId !== 'allow' && actionId !== 'deny' && actionId !== 'desk')) return null;
      return { kind: 'action', action: { kind: 'decide', machine: p.machine, id: p.id, behavior: actionId } };
    },
    needs: noNeeds,
  };
}

function studioWidget(): Widget {
  return {
    id: 'studio', kind: 'studio',
    title: () => 'Studio',
    body: (ctx, width) => {
      if (!ctx.data) return ['Loading…'];
      return ctx.data.studio ? studioText(ctx.data.studio, ctx.now, width) : wrap('Studio Routing is not running.', width);
    },
    actions: () => [],
    act: actionId => (actionId === FULL ? { kind: 'open', target: { kind: 'studio' } } : null),
    needs: noNeeds,
  };
}

function clockWidget(): Widget {
  return {
    id: 'clock', kind: 'clock',
    title: () => 'Clock',
    body: ctx => {
      const lines = [fmt(ctx.now, ctx.timeZone, { weekday: 'long' }), fmt(ctx.now, ctx.timeZone, { month: 'long', day: 'numeric' }), '', fmt(ctx.now, ctx.timeZone, { hour: 'numeric', minute: '2-digit' })];
      const w = ctx.data?.weather;
      if (w) lines.push('', clip(`${Math.round(w.temp)}° ${w.desc}`, W), `High ${Math.round(w.hi)}° · low ${Math.round(w.lo)}°`);
      if (w?.rainAt) lines.push(clip(`Rain ${w.rainAt} · ${Math.round(w.rainChance)}%`, W));
      // The hub line must never fall below the fold (8 body lines): battery and hub share a line, and blanks give way.
      const battery = ctx.battery !== undefined ? `Glasses ${Math.round(ctx.battery)}%` : '';
      if (ctx.hub?.down) lines.push(...(battery ? [battery] : []), 'Mini 1 and Neo unreachable');
      else if (ctx.hub?.name) lines.push(clip(battery ? `${battery} · via ${ctx.hub.name}` : `via ${ctx.hub.name}`, W));
      else if (battery) lines.push(battery);
      for (let i = lines.indexOf(''); lines.length > BODY_LINES && i >= 0; i = lines.indexOf('')) lines.splice(i, 1);
      return lines;
    },
    actions: () => [],
    act: actionId => (actionId === FULL ? { kind: 'open', target: { kind: 'home' } } : null),
    needs: noNeeds,
  };
}

const DAY_MS = 24 * 3600_000;
const JUST_ADDED = 'just-added';
const NOTICE_MS = 5000;
/** Overdue or due within 24 h first (soonest first), then the newest added, then the rest; ties: the 'Reminders' list first. */
export function sortReminders(list: Reminder[], now: number): Reminder[] {
  const soon = (r: Reminder) => typeof r.dueAt === 'number' && r.dueAt <= now + DAY_MS;
  return [...list].sort((a, b) =>
    Number(soon(b)) - Number(soon(a))
    || (soon(a) && soon(b) ? (a.dueAt as number) - (b.dueAt as number) : 0)
    || (b.added ?? -Infinity) - (a.added ?? -Infinity)
    || Number(b.list === 'Reminders') - Number(a.list === 'Reminders'));
}

function remindersWidget(): Widget {
  // main.ts puts a {id: 'just-added', title, added} entry in front of the list for a few seconds after a voice add.
  const split = (ctx: TileContext) => {
    const all = ctx.reminders();
    if (!all) return null;
    const note = all.find(r => r.id === JUST_ADDED && ctx.now - (r.added ?? 0) < NOTICE_MS);
    return { note, list: sortReminders(all.filter(r => r.id !== JUST_ADDED), ctx.now) };
  };
  return {
    id: 'reminders', kind: 'reminders',
    title: ctx => { const n = split(ctx)?.list.length; return n ? `Reminders · ${n}` : 'Reminders'; },
    body: (ctx, width) => {
      const v = split(ctx);
      if (!v) return ['Loading…'];
      const head = v.note ? [...wrap(`Added: ${v.note.title}`, width), ''] : [];
      if (!v.list.length) return [...head, 'No reminders.'];
      return [...head, ...v.list.flatMap(r => wrap(`• ${r.title}${r.due ? ` (${r.due})` : ''}${r.list && r.list !== 'Reminders' ? ` · ${r.list}` : ''}`, width))];
    },
    actions: ctx => [{ id: 'add', label: 'Add by voice' }, ...(split(ctx)?.list ?? []).slice(0, 5).map(r => ({ id: `done:${r.id}`, label: clip(`Done: ${r.title}`, W - 2) }))],
    act: actionId => {
      if (actionId === 'add') return { kind: 'open', target: { kind: 'reminderAdd' } };
      return actionId.startsWith('done:') ? { kind: 'reminderDone', id: actionId.slice('done:'.length) } : null;
    },
    needs: () => [{ kind: 'reminders' }],
  };
}

/** Conversation: listens only after a Start; hints while listening, then the summary. See docs/CONVERSATION.md. */
function conversationWidget(): Widget {
  const view = (ctx: TileContext) => ctx.conversation?.() ?? null;
  const fallbackLine = (v: ConvView, width: number) => (v.fallback ? wrap(v.fallback, width) : []);
  return {
    id: 'conversation', kind: 'conversation',
    title: ctx => {
      const v = view(ctx);
      if (!v) return 'Conversation';
      if (v.phase === 'listening') return `● Listening ${mmss(v.elapsedMs)}`;
      if (v.phase === 'starting') return 'Starting…';
      if (v.phase === 'stopping' || v.phase === 'summarizing') return 'Summarizing…';
      if (v.phase === 'done') return `Summary · ${clockTime(v.stoppedAt)}`;
      return 'Conversation';
    },
    body: (ctx, width) => {
      const v = view(ctx);
      if (!v) return wrap('Conversation is not available here.', width);
      const note = [...(v.notice ? [...wrap(v.notice, width), ''] : []), ...(v.warning ? [...wrap(v.warning, width), ''] : [])];
      const missed = v.skipped > 0 ? [`${v.skipped} piece${v.skipped === 1 ? '' : 's'} missed`] : [];
      switch (v.phase) {
        case 'starting': return [...note, 'Starting…'];
        case 'listening': {
          const hints = v.hints.length ? v.hints.flatMap(h => wrap(`• ${h}`, width)) : wrap('Listening… hints appear after about 10 seconds.', width);
          return [...note, ...(v.error ? [...wrap(v.error, width), ''] : []), ...hints, ...(v.fallback ? ['', ...fallbackLine(v, width)] : []), ...(missed.length ? ['', ...missed] : []), '', 'Tap to stop.'];
        }
        case 'stopping': case 'summarizing': return [...note, 'Summarizing…', ...(missed.length ? ['', ...missed] : []), ...(v.fallback ? ['', ...fallbackLine(v, width)] : [])];
        case 'done': {
          const lines = [...note, ...v.summary.flatMap(l => wrap(l, width))];
          if (v.actions.length) lines.push('', 'Action items:', ...v.actions.flatMap(a => wrap(`- ${a}`, width)));
          if (v.fallback) lines.push('', ...fallbackLine(v, width));
          if (missed.length) lines.push('', ...missed);
          return lines.length ? lines : ['(Nothing was said.)'];
        }
        case 'error': return [...note, ...wrap(v.error || 'Something went wrong.', width), '', 'Tap to start again.'];
        default: return [...note, 'Tap to start listening.', '', 'Nothing is heard until you do.'];
      }
    },
    tap: ctx => {
      const v = view(ctx);
      if (!v) return null;
      if (v.phase === 'listening' || v.phase === 'starting') return { kind: 'conversation', op: 'stop' };
      return v.phase === 'idle' || v.phase === 'error' ? { kind: 'conversation', op: 'start' } : null;
    },
    actions: ctx => {
      const v = view(ctx);
      if (!v) return [];
      if (v.phase === 'listening' || v.phase === 'starting') return [{ id: 'stop', label: 'Stop listening' }];
      if (v.phase === 'done') return [{ id: 'start', label: 'Start new' }, v.sent ? { id: 'sent', label: 'Sent to Muse' } : { id: 'muse', label: 'Send summary to Muse' }];
      if (v.phase === 'idle' || v.phase === 'error') return [{ id: 'start', label: 'Start listening' }];
      return [{ id: 'wait', label: 'Summarizing…' }];
    },
    act: (actionId, ctx) => {
      const v = view(ctx);
      if (!v) return null;
      if (actionId === 'stop' && (v.phase === 'listening' || v.phase === 'starting')) return { kind: 'conversation', op: 'stop' };
      if (actionId === 'start' && (v.phase === 'idle' || v.phase === 'error' || v.phase === 'done')) return { kind: 'conversation', op: 'start' };
      if (actionId === 'muse' && v.phase === 'done' && !v.sent) return { kind: 'conversation', op: 'sendMuse' };
      return null;
    },
    needs: () => [{ kind: 'conversation' }],
  };
}

function urlWidget(id: WidgetId): Widget {
  const endpoint = id.slice('url:'.length);
  return {
    id, kind: 'url',
    title: ctx => ctx.url(endpoint)?.title ?? 'App',
    body: (ctx, width) => { const t = ctx.url(endpoint); return t ? t.lines.flatMap(l => (l ? wrap(l, width) : [''])) : ['Loading…']; },
    actions: ctx => (ctx.url(endpoint)?.actions ?? []).map(a => ({ id: a.id, label: clip(a.label, W - 2) })),
    act: (actionId, ctx) => (ctx.url(endpoint)?.actions?.some(a => a.id === actionId) ? { kind: 'urlAction', endpoint, id: actionId } : null),
    needs: () => [{ kind: 'url', endpoint }],
  };
}

export function widgetFor(id: WidgetId): Widget {
  if ((id.startsWith('agent:') && id.includes('/')) || id === 'orchestrator') return agentWidget(id);
  if (id.startsWith('chat:') && id.length > 5) return chatWidget(id);
  if (id.startsWith('url:') && id.length > 4) return urlWidget(id);
  switch (id) {
    case 'muse': return museWidget();
    case 'messages': return messagesWidget();
    case 'approvals': return approvalsWidget();
    case 'studio': return studioWidget();
    case 'clock': return clockWidget();
    case 'reminders': return remindersWidget();
    case 'conversation': return conversationWidget();
    default: return empty('empty', 'empty', 'Empty');
  }
}

/** Every widget Home knows right now (for the phone editor and "Edit page" on the glasses). */
export function availableWidgets(data: HomeData | null): { id: WidgetId; label: string }[] {
  const out: { id: WidgetId; label: string }[] = [
    { id: 'muse', label: 'Muse' }, { id: 'messages', label: 'Messages' }, { id: 'approvals', label: 'Needs you' },
    { id: 'studio', label: 'Studio' }, { id: 'orchestrator', label: 'Orchestrator' }, { id: 'reminders', label: 'Reminders' }, { id: 'clock', label: 'Clock' }, { id: 'conversation', label: 'Conversation' }, { id: 'empty', label: 'Empty' },
  ];
  if (data) {
    const seen = new Set<string>();
    for (const s of [...data.sessions].sort((a, b) => b.at - a.at)) {
      const id = `agent:${s.machine}/${s.agent.toLowerCase()}`;
      if (!seen.has(id)) { seen.add(id); out.push({ id, label: `${s.agent} on ${s.machine}` }); }
    }
    // Each live terminal on its own, to pin a tile to that very window or pane.
    for (const s of [...data.sessions].filter(live).sort((a, b) => b.at - a.at)) {
      const id = `agent:${s.machine}/${s.window || s.pane}`;
      if (!seen.has(id)) { seen.add(id); out.push({ id, label: `${s.name || s.agent} · ${s.page} (${s.machine})` }); }
    }
    out.push({ id: 'chat:recent', label: 'Latest chat' });
    for (const c of data.messages ?? []) out.push({ id: `chat:${c.id}`, label: `Chat: ${c.name}` });
  }
  return out;
}

const KNOWN = /^(agent:[^/]+\/.+|chat:(recent|\d+)|url:.+|muse|messages|approvals|studio|clock|reminders|conversation|orchestrator|empty)$/;

/** A layout from the hub, repaired: always PAGE_COUNT pages, unknown ids become 'empty'. */
export function normalizeLayout(raw: unknown): Layout {
  const pages = Array.isArray((raw as Layout | null)?.pages) ? (raw as Layout).pages : [];
  const id = (v: unknown, fallback: WidgetId) => (typeof v === 'string' && KNOWN.test(v) ? v : fallback);
  return {
    pages: Array.from({ length: PAGE_COUNT }, (_, i) => {
      const p = (pages[i] ?? {}) as Partial<PageLayout>;
      return { left: id(p.left, 'empty'), right: id(p.right, 'empty') };
    }),
  };
}

type Side = 'left' | 'right';
/** Three levels: PAGE (swipe = page), CHOOSE (swipe toggles the highlighted tile), TILE (swipe scrolls). */
type Mode = { kind: 'page' } | { kind: 'choose'; side: Side } | { kind: 'tile'; side: Side; menu: number | null };

export class Tiles implements TilesApi {
  private layout: Layout = normalizeLayout(DEFAULT_LAYOUT);
  private page = 0;
  private mode: Mode = { kind: 'page' };
  /** Lines scrolled up from the newest (log-like tiles) or down from the top (lists), per tile. */
  private scroll = 0;
  /** "Edit page": pick the left, then the right widget for the current page from everything Home knows. */
  private edit: { side: Side; cursor: number; left: WidgetId } | null = null;
  private edited: Layout | null = null;
  /** The side last highlighted on each page while Home is open; a page not visited yet starts on the left. */
  private sides: Side[] = [];

  /** Remember the page, focus and scroll before a remote up. */
  capturePosition(): () => void {
    const page = this.page, mode = { ...this.mode }, scroll = this.scroll;
    const sides = this.sides.slice(), edit = this.edit ? { ...this.edit } : null;
    return () => { this.page = page; this.mode = mode; this.scroll = scroll; this.sides = sides; this.edit = edit; };
  }

  getLayout(): Layout { return this.layout; }

  /** Start editing the current page (the long-press menu's "Edit page"). */
  startEdit(ctx: TileContext): void {
    this.edit = { side: 'left', cursor: this.optionIndex(ctx, this.layout.pages[this.page].left), left: '' };
    this.mode = { kind: 'tile', side: 'left', menu: null };
  }

  /** The layout the last "Edit page" produced, once; main.ts saves it to the hub. */
  takeEdited(): Layout | null {
    const out = this.edited;
    this.edited = null;
    return out;
  }

  private options(ctx: TileContext): { id: WidgetId; label: string }[] {
    return availableWidgets(ctx.data);
  }

  private optionIndex(ctx: TileContext, id: WidgetId): number {
    return Math.max(0, this.options(ctx).findIndex(o => o.id === id));
  }

  private inputEdit(input: Input, ctx: TileContext): TilesResult {
    const edit = this.edit!;
    const options = this.options(ctx);
    if (input === 'back') { this.edit = null; this.mode = { kind: 'page' }; return null; }
    if (input === 'up' || input === 'down') { edit.cursor = (edit.cursor + options.length + (input === 'down' ? 1 : -1)) % options.length; return null; }
    const pick = options[edit.cursor]?.id ?? 'empty';
    if (edit.side === 'left') {
      this.edit = { side: 'right', cursor: this.optionIndex(ctx, this.layout.pages[this.page].right), left: pick };
      this.mode = { kind: 'tile', side: 'right', menu: null };
      return null;
    }
    const pages = this.layout.pages.map((p, i) => (i === this.page ? { left: edit.left, right: pick } : p));
    this.layout = normalizeLayout({ pages });
    this.edited = this.layout;
    this.edit = null;
    this.mode = { kind: 'page' };
    return null;
  }

  setLayout(layout: Layout): void {
    this.layout = normalizeLayout(layout);
  }

  /** Back to page 1 (Start in Tiles). A layout arriving later does not move you: setLayout keeps the page. */
  resetPage(): void {
    this.page = 0;
    this.mode = { kind: 'page' };
    this.scroll = 0;
  }

  private highlight(side: Side): void {
    this.mode = { kind: 'choose', side };
    this.sides[this.page] = side;
  }

  private widget(side: Side): Widget {
    return widgetFor(this.layout.pages[this.page][side]);
  }

  /** Log-like tiles open at the newest line; lists open at the top. */
  private anchoredBottom(w: Widget): boolean { return w.kind === 'agent' || w.kind === 'chat'; }

  private menuItems(w: Widget, ctx: TileContext): TileAction[] {
    const full = w.act(FULL, ctx) ? [{ id: FULL, label: 'Full screen' }] : [];
    return [...w.actions(ctx), ...full];
  }

  /** The body lines to show for a scroll offset, and whether there is more above or below. */
  private window(w: Widget, lines: string[], scroll: number): { view: string[]; above: boolean; below: boolean; max: number } {
    const max = Math.max(0, lines.length - BODY_LINES);
    const start = this.anchoredBottom(w) ? max - Math.min(scroll, max) : Math.min(scroll, max);
    return { view: lines.slice(start, start + BODY_LINES), above: start > 0, below: start + BODY_LINES < lines.length, max };
  }

  input(input: Input, ctx: TileContext): TilesResult {
    if (this.edit) return this.inputEdit(input, ctx);
    const mode = this.mode;
    if (mode.kind === 'page') {
      if (input === 'up' || input === 'down') {
        const n = this.layout.pages.length;
        this.page = (this.page + (input === 'down' ? 1 : n - 1)) % n;
        this.scroll = 0;
        return null;
      }
      if (input === 'select') { this.mode = { kind: 'choose', side: this.sides[this.page] ?? 'left' }; this.scroll = 0; return null; }
      return { kind: 'exit' };
    }
    if (mode.kind === 'choose') {
      if (input === 'up' || input === 'down') { this.highlight(mode.side === 'left' ? 'right' : 'left'); return null; }
      if (input === 'select') { this.mode = { kind: 'tile', side: mode.side, menu: null }; this.scroll = 0; return null; }
      this.mode = { kind: 'page' };
      return null;
    }
    this.sides[this.page] = mode.side;
    const w = this.widget(mode.side);
    if (mode.menu !== null) {
      const items = this.menuItems(w, ctx);
      if (input === 'back') { mode.menu = null; return null; }
      if (input === 'up') { mode.menu = (mode.menu + items.length - 1) % items.length; return null; }
      if (input === 'down') { mode.menu = (mode.menu + 1) % items.length; return null; }
      const item = items[mode.menu];
      mode.menu = null;
      if (!item) return null;
      return w.act(item.id, ctx);
    }
    if (input === 'back') { this.mode = { kind: 'choose', side: mode.side }; this.scroll = 0; return null; }
    if (input === 'select') {
      const tap = w.tap?.(ctx);
      if (tap) return tap;
      mode.menu = 0;
      return null;
    }
    const lines = w.body(ctx, W);
    const max = Math.max(0, lines.length - BODY_LINES);
    const toward = input === 'up' ? -1 : 1; // up reads earlier text, down reads later text
    const delta = this.anchoredBottom(w) ? -toward : toward;
    this.scroll = Math.min(max, Math.max(0, this.scroll + delta));
    return null;
  }

  render(ctx: TileContext): TilesFrame {
    const m = this.mode;
    const focus: TilesFrame['focus'] = m.kind === 'page' ? 'page' : m.kind === 'choose' ? `choose-${m.side}` : m.side;
    const tile = (side: Side): string => {
      const w = this.widget(side);
      const lit = m.kind !== 'page' && m.side === side;
      const focused = m.kind === 'tile' && lit;
      const menu = focused && this.mode.kind === 'tile' ? this.mode.menu : null;
      let title = w.title(ctx);
      if (side === 'left') title = `${this.page + 1}/${this.layout.pages.length} ${title}`;
      let view: string[];
      let mark = '';
      if (this.edit && this.edit.side === side) {
        const options = this.options(ctx);
        const c = this.edit.cursor;
        const start = Math.min(Math.max(0, c - Math.floor(BODY_LINES / 2)), Math.max(0, options.length - BODY_LINES));
        title = `Pick ${side}`;
        view = options.slice(start, start + BODY_LINES).map((o, i) => `${start + i === c ? '>' : ' '} ${clip(o.label, W - 2)}`);
      } else if (menu !== null) {
        const items = this.menuItems(w, ctx);
        const start = Math.min(Math.max(0, menu - Math.floor(BODY_LINES / 2)), Math.max(0, items.length - BODY_LINES));
        view = items.slice(start, start + BODY_LINES).map((it, i) => `${start + i === menu ? '>' : ' '} ${clip(it.label, W - 2)}`);
      } else {
        const win = this.window(w, w.body(ctx, W), focused ? this.scroll : 0);
        view = win.view;
        mark = `${win.above ? '▲' : ''}${win.below ? '▼' : ''}`;
      }
      const lead = lit ? '> ' : '';
      const room = W - lead.length - (mark ? mark.length + 1 : 0);
      const head = clip(title, room);
      const first = mark ? `${lead}${head.padEnd(room)} ${mark}` : `${lead}${head}`;
      return [first, ...view.map(l => l.slice(0, W))].join('\n');
    };
    return { page: this.page, focus, left: tile('left'), right: tile('right') };
  }

  needs(ctx: TileContext): TileNeed[] {
    const p = this.layout.pages[this.page];
    return [...widgetFor(p.left).needs(ctx), ...widgetFor(p.right).needs(ctx)];
  }
}
