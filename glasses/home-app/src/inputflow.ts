// What a press does, for Tiles and for the full screens (moved out of main.ts so it can be tested with the real
// model and Tiles). main.ts supplies the host: painting, running actions, and the Tiles on/off state.
import type { HomeModel, Input } from './model';
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
  runTileEffect(effect: TileEffect): void;
  runModelAction(action: NonNullable<ReturnType<HomeModel['input']>>): void;
  saveLayout(layout: Layout): void;
  refreshTiles(): void;
  refreshTerminal(): void;
  now(): number;
}

export function makeHandle(host: FlowHost): (input: Input) => void {
  return input => {
    if (host.showingTiles()) {
      const result = host.tiles.input(input, host.tileCtx());
      if (result?.kind === 'exit') { host.leaveTiles(); return; }
      host.paint();
      if (result) { host.runTileEffect(result as TileEffect); host.paint(); } // a screen it opened must be what settled() waits for
      const edited = host.tiles.takeEdited();
      if (edited) host.saveLayout(edited);
      host.refreshTiles();
      return;
    }
    if (host.inOpenedScreen() && input === 'back' && TOP_SCREENS.includes(host.model.screenKind)) {
      host.backToTiles();
      return;
    }
    const action = host.model.input(input, host.now());
    host.paint();
    if (action) { host.runModelAction(action); host.paint(); }
    host.refreshTerminal();
  };
}
