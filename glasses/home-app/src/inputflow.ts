// What a press does, for Tiles and for the full screens (moved out of main.ts so it can be tested with the real
// model and Tiles). main.ts supplies the host: painting, running actions, and the Tiles on/off state.
import type { Action, HomeModel, Input } from './model';
import type { ConversationSession, ConvBackend } from './conversation';
import type { Layout, TileContext, TileEffect, Tiles } from './tiles';

/** Screens a tile opens: one double-tap there goes straight back to Tiles. */
export const TOP_SCREENS = ['agent', 'chat', 'muse', 'messages', 'needs', 'studio', 'home'];

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
  /** May return a promise (a Conversation start/stop); the queue waits for it, capped. */
  runTileEffect(effect: TileEffect): void | Promise<void>;
  /** May return a promise; the microphone actions' promises are awaited by the queue. */
  runModelAction(action: NonNullable<ReturnType<HomeModel['input']>>): void | Promise<void>;
  saveLayout(layout: Layout): void;
  refreshTiles(): void;
  refreshTerminal(): void;
  now(): number;
}

export function makeHandle(host: FlowHost): (input: Input) => void | Promise<void> {
  return input => {
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
    host.paint();
    const job = action ? host.runModelAction(action) : undefined;
    if (action) host.paint();
    host.refreshTerminal();
    // Microphone on/off and a Conversation start must finish before the next press (a stop must not overtake its start); other actions go on in the background.
    return action && (action.kind === 'startMic' || action.kind === 'stopMic' || action.kind === 'cancelMic' || action.kind === 'startConversation') ? job : undefined;
  };
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
