// What a press does, for Tiles and for the full screens (moved out of main.ts so it can be tested with the real
// model and Tiles). main.ts supplies the host: painting, running actions, and the Tiles on/off state.
import type { HomeModel, Input } from './model';
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
  /** Tile actions run in the background. */
  runTileEffect(effect: TileEffect, source?: 'touch' | 'remote'): void | Promise<void>;
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

export function makeHandle(host: FlowHost): (input: Input, source?: 'touch' | 'remote') => void | Promise<void> {
  const handle = (input: Input, source: 'touch' | 'remote' = 'touch'): void | Promise<void> => {
    if (host.isBlank()) { host.wake(); return; }
    if (host.showingDesk?.()) { host.deskInput?.(input); return; }
    if (host.showingTiles()) {
      const result = host.tiles.input(input, host.tileCtx());
      if (result?.kind === 'exit') { host.leaveTiles(); return; }
      host.paint();
      if (result) { host.runTileEffect(result as TileEffect, source); host.paint(); } // a screen it opened must be what settled() waits for
      const edited = host.tiles.takeEdited();
      if (edited) host.saveLayout(edited);
      host.refreshTiles();
      return;
    }
    if (host.inOpenedScreen() && input === 'back' && TOP_SCREENS.includes(host.model.screenKind)) {
      if (host.model.screenKind === 'agent') host.model.abandonTalk();
      host.backToTiles();
      return;
    }
    const action = host.model.input(input, host.now(), source);
    if (host.inDeskApp?.() && host.model.screenKind === 'home') { host.backToDesk?.(); return; }
    host.paint();
    const job = action ? host.runModelAction(action) : undefined;
    if (action) host.paint();
    host.refreshTerminal();
    // Microphone on/off must finish before the next press; other actions go on in the background.
    return action && (action.kind === 'startMic' || action.kind === 'stopMic' || action.kind === 'cancelMic' || action.kind === 'closeApp') ? job : undefined;
  };
  return handle;
}

/** A distinct SDK hold path, scoped to the visible agent recording/confirmation. */
export function makeHoldHandle(host: FlowHost): (token?: unknown) => void | Promise<void> {
  return (token?: unknown): void | Promise<void> => {
    if (host.isBlank()) { host.wake(); return; }
    if (host.showingDesk?.() || host.showingTiles()) return;
    const action = host.model.hold(host.now(), token);
    host.paint();
    const job = action ? host.runModelAction(action) : undefined;
    if (action) host.paint();
    host.refreshTerminal();
    return action && (action.kind === 'stopMic' || action.kind === 'cancelMic') ? job : undefined;
  };
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

/** The phone remote's volume-up ("settings") is ignored while you are reading or talking to Muse: scrolling must never open Quick settings over it. */
export function remoteSettingsIgnored(screen: string): boolean {
  return screen === 'muse' || screen === 'listen' || screen === 'confirm';
}
