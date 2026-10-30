import type { HomeModel } from './model';
import { MUSE_UNREACHABLE, type MuseCache, type MuseValue } from './musecache';

/**
 * The relay's /latest arrived (null: the read failed) for a read that began at `stamp`. One rule for the Muse screen and the Muse tile:
 * a read that is out of date (an ask began or ended since) changes nothing, and once this session holds its own answer for its
 * newest ask, /latest never replaces it on either. `read` is the number startRead() gave when the read began. Returns whether it was taken.
 */
export function applyMuseLatest(model: HomeModel, tile: MuseCache, stamp: number | null, latest: MuseValue | null, read: number): boolean {
  if (!tile.isCurrent(stamp)) { model.restoreMuse(); return false; }
  // A question with no reply yet (asked from another client): the newest question, "thinking"; the answer shown so far goes below, the tile keeps its last real answer.
  if (latest && latest.question && !latest.reply) {
    if (!tile.takeRead(read)) return false;
    model.showMusePending(latest.question);
    const tileHas = tile.get() !== null && tile.get() !== MUSE_UNREACHABLE && Boolean(tile.get()!.question || tile.get()!.reply);
    if (!tileHas) tile.fetchDone(stamp!, latest);
    return true;
  }
  // A failed or EMPTY read never advances the applied number and never replaces an answer: the unreachable / "no conversation" note is only for a surface with nothing to show.
  if (latest === null || (!latest.question && !latest.reply)) {
    const tileHas = tile.get() !== null && tile.get() !== MUSE_UNREACHABLE && Boolean(tile.get()!.question || tile.get()!.reply);
    const screenHas = model.museHasAnswer();
    if (screenHas) model.restoreMuse(); else model.setMuse(latest);
    if (!tileHas) { if (latest) tile.fetchDone(stamp!, latest); else tile.fetchFailed(stamp!); }
    return !screenHas || !tileHas;
  }
  // Two reads can share a stamp: the one that started later wins, whichever finishes first.
  if (!tile.takeRead(read)) return false;
  if (!model.setMuse(latest)) return false;
  tile.fetchDone(stamp!, latest);
  return true;
}
