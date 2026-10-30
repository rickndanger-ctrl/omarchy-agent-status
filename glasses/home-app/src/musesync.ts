import type { HomeModel } from './model';
import type { MuseCache, MuseValue } from './musecache';

/**
 * The relay's /latest arrived (null: the read failed) for a read that began at `stamp`. One rule for the Muse screen and the Muse tile:
 * a read that is out of date (an ask began or ended since) changes nothing, and once this session holds its own answer for its
 * newest ask, /latest never replaces it on either. `read` is the number startRead() gave when the read began. Returns whether it was taken.
 */
export function applyMuseLatest(model: HomeModel, tile: MuseCache, stamp: number | null, latest: MuseValue | null, read: number): boolean {
  if (!tile.isCurrent(stamp)) { model.restoreMuse(); return false; }
  // Two reads can share a stamp: the one that started later wins, whichever finishes first.
  if (!tile.takeRead(read)) return false;
  if (!model.setMuse(latest)) return false;
  if (latest) tile.fetchDone(stamp!, latest); else tile.fetchFailed(stamp!);
  return true;
}
