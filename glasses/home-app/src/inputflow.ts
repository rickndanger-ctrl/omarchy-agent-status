// What a press does, for Tiles and for the full screens (moved out of main.ts so it can be tested with the real
// model and Tiles). main.ts supplies the host: painting, running actions, and the Tiles on/off state.
import type { Action, HomeModel, Input } from './model';
import type { ConversationSession, ConvBackend } from './conversation';
import type { Layout, TileContext, TileEffect, Tiles } from './tiles';

/** Screens a tile opens: one double-tap there goes straight back to Tiles. */
export const TOP_SCREENS = ['agent', 'chat', 'muse', 'messages', 'needs', 'studio', 'home', 'settings'];

export interface FlowHost {
  model: HomeModel;
  tiles: Tiles;
  tileCtx(): TileContext;
  showingTiles(): boolean;
  /** Tiles are active and a full screen opened from a tile is showing. */
  inOpenedScreen(): boolean;
  /** Double-tap on the Tiles page: leave Tiles for the old Home. */
  leaveTiles(): void;
  /** Double-tap on a screen a tile opened: back to Tiles. */
  backToTiles(): void;
  paint(): void;
  /** Display off: the glasses show a blank page. Any press wakes it and is not passed on. */
  isBlank(): boolean;
  wake(): void;
  /** May return a promise (a Conversation start/stop); the queue waits for it, capped. */
  runTileEffect(effect: TileEffect): void | Promise<void>;
  /** May return a promise; the microphone actions' promises are awaited by the queue. */
  runModelAction(action: NonNullable<ReturnType<HomeModel['input']>>): void | Promise<void>;
  saveLayout(layout: Layout): void;
  refreshTiles(): void;
  refreshTerminal(): void;
  now(): number;
  /** The Desk (src/desk.ts, loaded on demand) is in front: it takes every press. */
  showingDesk?(): boolean;
  deskInput?(input: Input): void;
  /** A screen opened from the Desk is showing. */
  inDeskApp?(): boolean;
  /** An app opened from the Desk went back to Home: return to the Desk instead. */
  backToDesk?(): void;
}

export function makeHandle(host: FlowHost): (input: Input) => void | Promise<void> {
  const handle = (input: Input): void | Promise<void> => {
    if (host.isBlank()) { host.wake(); return; }
    if (host.showingDesk?.()) { host.deskInput?.(input); return; }
    if (host.showingTiles()) {
      const result = host.tiles.input(input, host.tileCtx());
      if (result?.kind === 'exit') { host.leaveTiles(); return; }
      host.paint();
      let job: void | Promise<void> = undefined;
      if (result) { job = host.runTileEffect(result as TileEffect); host.paint(); } // a screen it opened must be what settled() waits for
      const edited = host.tiles.takeEdited();
      if (edited) host.saveLayout(edited);
      host.refreshTiles();
      // A Conversation start/stop must finish before the next press (a stop must not overtake its start).
      return result?.kind === 'conversation' ? job : undefined;
    }
    if (host.inOpenedScreen() && input === 'back' && TOP_SCREENS.includes(host.model.screenKind)) {
      host.backToTiles();
      return;
    }
    const action = host.model.input(input, host.now());
    if (host.inDeskApp?.() && host.model.screenKind === 'home') { host.backToDesk?.(); return; }
    host.paint();
    const job = action ? host.runModelAction(action) : undefined;
    if (action) host.paint();
    host.refreshTerminal();
    // Microphone on/off and a Conversation start must finish before the next press (a stop must not overtake its start); other actions go on in the background.
    return action && (action.kind === 'startMic' || action.kind === 'stopMic' || action.kind === 'cancelMic' || action.kind === 'startConversation' || action.kind === 'closeApp') ? job : undefined;
  };
  return handle;
}

export interface ConversationHost {
  conv: ConversationSession;
  backend(): ConvBackend;
  /** Home's existing action runner; "Send summary to Muse" hands it the unchanged askMuse action. */
  dispatch(action: Action): void;
  flash(text: string): void;
  paint(): void;
}

/** The tile's Start, and the long-press menu's "Listen". */
export async function startConversation(h: ConversationHost): Promise<void> {
  await h.conv.start(h.backend());
  const v = h.conv.view();
  h.flash(v.phase === 'listening' ? 'Listening' : v.notice || v.error || 'Could not start');
  h.paint();
}

/** What the Conversation tile's tap and menu choices do. Returned to the input queue so the next press waits for it. */
export function runConversationEffect(h: ConversationHost, op: 'start' | 'stop' | 'sendMuse'): void | Promise<void> {
  if (op === 'start') return startConversation(h);
  if (op === 'stop') return h.conv.stop('tap').then(() => h.paint());
  h.conv.sendToMuse(action => h.dispatch(action));
  h.paint();
}

/** What Quick settings needs from the app (main.ts supplies it; tests supply fakes). */
export interface SettingsHost {
  model: HomeModel;
  isBlank(): boolean;
  wake(): void;
  setBlank(): void;
  showingTiles(): boolean;
  /** The screen is opened from Tiles: a double-tap there goes back to Tiles. */
  markOpenedFromTile(): void;
  /** Settings was left with Back: if it was opened from Tiles, return to Tiles. */
  returnToTiles(): void;
  saveBrightness(value: number): void;
  closeApp(): Promise<unknown>;
  paint(): void;
}

/** The phone remote's "settings" button (arrives as a queue menu choice): wakes a blank display instead, else opens Quick settings. */
export function openSettings(h: SettingsHost): void {
  if (h.isBlank()) { h.wake(); return; }
  if (h.showingTiles()) h.markOpenedFromTile();
  h.model.openSettings();
  h.paint();
}

/** Quick settings rows: the model decided; this does the work. Returns undefined for an action that is not Quick settings. */
export function runSettingsAction(h: SettingsHost, action: NonNullable<ReturnType<HomeModel['input']>>): { handled: boolean; job?: Promise<unknown> } {
  switch (action.kind) {
    case 'displayOff': h.setBlank(); return { handled: true };
    case 'brightness': h.saveBrightness(action.value); return { handled: true };
    case 'closeApp': return { handled: true, job: h.closeApp() };
    case 'settingsBack': h.returnToTiles(); return { handled: true };
    default: return { handled: false };
  }
}
