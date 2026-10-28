// Tiles: Omarchy-style pages on the glasses. Five pages, each two tiles side by side; any
// Home "app" (a widget) can go in any tile. Like model.ts, this file is free of the SDK and
// the network so it can be tested on its own. docs/TILES.md describes the format for other apps.
//
// CONTRACT (set by the architect; changing a type here is a breaking change: tell the
// architect first). The implementation below the line is the main session's.
import type { Action, HomeData, Input } from './model';

/** One tile is 288 px wide: 27 characters, 9 lines, title included. More lines make the glasses auto-scroll and swallow swipes. */
export const TILE_WIDTH = 27;
export const TILE_LINES = 9;
export const PAGE_COUNT = 5;

/**
 * Widget ids, as stored in the layout:
 *   agent:<machine>/<pane-or-agent>  a terminal tail; matches a pane first, else the newest session of that agent there
 *   muse | messages | approvals | studio | clock | reminders | empty
 *   chat:<id> | chat:recent          one Messages thread (chat:recent = the newest thread)
 *   url:<endpoint>                   a plug-in: GET returns UrlTile; an action is POSTed back (through the hub)
 */
export type WidgetId = string;
export type WidgetKind = 'agent' | 'muse' | 'chat' | 'messages' | 'approvals' | 'studio' | 'clock' | 'reminders' | 'url' | 'empty';

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
export interface Reminder { id: string; title: string; due: string | null; list: string }

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
}

/** Something the tile asks for in the background so it can render: main.ts polls these for the visible page. */
export type TileNeed =
  | { kind: 'terminal'; machine: string; pane: string; window?: string; appThread?: string; key: string }
  | { kind: 'chat'; id: number }
  | { kind: 'muse' }
  | { kind: 'reminders' }
  | { kind: 'url'; endpoint: string };

/** A full Home screen a tile can open (then double-tap there returns to Tiles). */
export type OpenTarget =
  | { kind: 'agent'; key: string; then?: 'listen' | 'reply' }
  | { kind: 'chat'; id: number; name: string; then?: 'listen' | 'textReply' }
  | { kind: 'muse'; then?: 'listen' }
  | { kind: 'messages' } | { kind: 'needs' } | { kind: 'studio' } | { kind: 'home' };

/** What an action does: a Home action (send, decide, ...), open a full screen, or something tiles-only. */
export type TileEffect =
  | { kind: 'action'; action: Action }
  | { kind: 'open'; target: OpenTarget }
  | { kind: 'reminderDone'; id: string }
  | { kind: 'urlAction'; endpoint: string; id: string }
  | { kind: 'switchTile' };

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
  /** Actions for the tap menu. The model always adds "Full screen" and "Switch to other tile". */
  actions(ctx: TileContext): TileAction[];
  act(actionId: string, ctx: TileContext): TileEffect | null;
  needs(ctx: TileContext): TileNeed[];
}

/** One frame of the tiled page: each tile is at most TILE_LINES lines of at most TILE_WIDTH characters. */
export interface TilesFrame { page: number; focus: 'page' | 'left' | 'right'; left: string; right: string }

/** What a gesture led to. */
export type TilesResult = TileEffect | { kind: 'exit' } | null;

/** The Tiles state machine (implemented below by the main session). */
export interface TilesApi {
  setLayout(layout: Layout): void;
  input(input: Input, ctx: TileContext): TilesResult;
  render(ctx: TileContext): TilesFrame;
  needs(ctx: TileContext): TileNeed[];
}

export declare function widgetFor(id: WidgetId): Widget;
/** Every widget Home knows right now (for the phone editor and "Edit page" on the glasses). */
export declare function availableWidgets(data: HomeData | null): { id: WidgetId; label: string }[];
/** A layout from the hub, repaired: always PAGE_COUNT pages, unknown ids become 'empty'. */
export declare function normalizeLayout(raw: unknown): Layout;

// ---- implementation (main session) ----
