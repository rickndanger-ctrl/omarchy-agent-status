// Which hub Home talks to. Only the hubs in VITE_HUBS are allowed (in that order of preference); a stored or
// page-supplied address that is not one of them is ignored. Free of the SDK and the network: main.ts does the
// fetching and tells this what happened. See docs/TILES.md for the hubs.
const PRIMARY_CHECK_MS = 60_000;
const slash = (url: string) => (url && !url.endsWith('/') ? `${url}/` : url);

export class HubPicker {
  private readonly hubs: string[];
  private cur: string;
  private lastCheck: number;
  private down = false;
  private readonly names = new Map<string, string>();
  /** A stored base that is not an allowed hub: main.ts deletes it. */
  readonly staleStored: boolean;

  constructor(hubs: string[], here: string, stored: string, nowMs: number) {
    const own = slash(here);
    this.hubs = [...new Set(hubs.map(slash).filter(Boolean))];
    if (!this.hubs.length && own) this.hubs = [own]; // a dev page with no VITE_HUBS: itself
    const saved = slash(stored);
    this.staleStored = Boolean(saved) && !this.hubs.includes(saved);
    this.cur = this.hubs.includes(saved) ? saved : this.hubs.includes(own) ? own : this.hubs[0] ?? '';
    this.lastCheck = nowMs;
  }

  get current(): string { return this.cur; }
  get primary(): string { return this.hubs[0] ?? ''; }
  allowed(url: string): boolean { return this.hubs.includes(slash(url)); }

  /** Hubs to try, in HUBS order starting from the current one. */
  order(): string[] {
    const i = Math.max(0, this.hubs.indexOf(this.cur));
    return [...this.hubs.slice(i), ...this.hubs.slice(0, i)];
  }

  /** A hub answered. Returns true if that changed which hub is current (to store and log). Disallowed hubs are never adopted. */
  useHub(url: string, nowMs: number): boolean {
    const hub = slash(url);
    this.down = false;
    if (!this.hubs.includes(hub) || hub === this.cur) return false;
    if (hub !== this.primary) this.lastCheck = nowMs; // just left the primary: first look back in a minute
    this.cur = hub;
    return true;
  }

  /** Every allowed hub failed. */
  allFailed(): void { this.down = true; }

  /** While not on the primary, true at most once a minute: time to ask the primary's /api/health. */
  primaryCheckDue(nowMs: number): boolean {
    if (this.cur === this.primary || nowMs - this.lastCheck < PRIMARY_CHECK_MS) return false;
    this.lastCheck = nowMs;
    return true;
  }

  noteName(url: string, machine: string): void { if (machine) this.names.set(slash(url), machine); }
  knowsName(url: string): boolean { return this.names.has(slash(url)); }

  /** For the clock tile: the name of the hub in use, or down when none answers. */
  state(): { name: string | null; down: boolean } {
    return this.down ? { name: null, down: true } : { name: this.names.get(this.cur) ?? null, down: false };
  }
}

/** The hubs a request may try: all of them in order, or only the current one for a request that must never be sent twice (an ask to Muse). */
export function hubsToTry<T>(hubs: T[], once: boolean): T[] {
  return once ? hubs.slice(0, 1) : hubs;
}
