// The Tiles layout between hub contacts: remembered on the phone (localStorage 'home.layout') so Tiles opens with the
// owner's pages at once, and fetched from the hub with quick retries at start-up. Free of the network, the clock and
// the page: main.ts hands in the storage, the fetch and a timer. Rules in docs/TILES.md.
import { normalizeLayout, type Layout } from './tiles';

/** A stored layout, repaired; null if it is not a layout at all (garbage is ignored, the default stays). */
export function parseCachedLayout(raw: string): Layout | null {
  try {
    const value = JSON.parse(raw) as { pages?: unknown } | null;
    if (!value || !Array.isArray(value.pages) || !value.pages.length || !value.pages.every(p => p && typeof p === 'object')) return null;
    return normalizeLayout(value);
  } catch {
    return null;
  }
}

/** After a failed first fetch: look again after these many ms, then the regular 60 s timer takes over. */
const QUICK_RETRY_MS = [2000, 5000, 10000];

export interface LayoutLoaderOptions {
  get(): string;
  set(value: string): void;
  fetch(): Promise<unknown>;
  apply(layout: Layout): void;
  after(ms: number, fn: () => void): void;
}

export class LayoutLoader {
  private quick = 0;
  private pending = false;
  private done = false;

  constructor(private readonly o: LayoutLoaderOptions) {}

  /** Show the remembered layout (if any) now, then ask the hub. */
  start(): void {
    const cached = parseCachedLayout(this.o.get());
    if (cached) this.o.apply(cached);
    void this.load();
  }

  /** Remember a layout (after the owner saved one). */
  remember(layout: Layout): void { this.o.set(JSON.stringify(normalizeLayout(layout))); }

  async load(): Promise<void> {
    try {
      const layout = normalizeLayout(await this.o.fetch());
      this.done = true;
      this.o.apply(layout);
      this.remember(layout);
    } catch {
      if (this.done || this.pending || this.quick >= QUICK_RETRY_MS.length) return;
      this.pending = true;
      this.o.after(QUICK_RETRY_MS[this.quick++], () => { this.pending = false; void this.load(); });
    }
  }
}
