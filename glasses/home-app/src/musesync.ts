import type { HomeModel } from './model';
import type { MuseCache, MuseValue } from './musecache';
import { MUSE_UNREACHABLE } from './musecache';

/**
 * The relay's /latest arrived (null: the read failed) for a read that began at `stamp`. It only SEEDS an empty Muse session with its one
 * exchange (screen and tile); once this session has a chat it changes nothing. A read that is out of date (an ask began or ended since),
 * or older than one already applied, changes nothing either. Returns whether it was used.
 */
export function applyMuseLatest(model: HomeModel, tile: MuseCache, stamp: number | null, latest: MuseValue | null, read: number): boolean {
  if (!tile.isCurrent(stamp)) { model.restoreMuse(); return false; }
  const real = latest !== null && Boolean(latest.question || latest.reply);
  // A real exchange (or a question still waiting for its reply) is ordered by when its read began; a failed or empty one never advances the order.
  if (real && !tile.takeRead(read)) return false;
  if (!model.museIsEmpty()) { model.restoreMuse(); return false; }
  const tileHas = tile.get() !== null && tile.get() !== MUSE_UNREACHABLE && Boolean(tile.get()!.question || tile.get()!.reply);
  model.setMuse(latest);
  if (real) tile.fetchDone(stamp!, latest!);
  else if (!tileHas) { if (latest) tile.fetchDone(stamp!, latest); else tile.fetchFailed(stamp!); }
  return true;
}
