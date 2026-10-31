import type { ListenHubPort } from './hub';

export type ListenAction = 'toggle' | 'previous' | 'next' | 'newest';
export type InputName = 'up' | 'down' | 'select' | 'back';
export const DOUBLE_DOWN_MS = 400;
export const BACKOFF_MS = [1000, 2000, 5000];

/** The same mapper is shared by phone and glasses. Unknown/audio events do nothing. */
export class InputMapper {
  private lastDown: number | null = null;
  constructor(private readonly apply: (action: ListenAction) => void, private readonly now: () => number = Date.now) {}
  reset(): void { this.lastDown = null; }
  press(input: string, at = this.now()): void {
    if (input === 'down') {
      const twice = this.lastDown !== null && at >= this.lastDown && at - this.lastDown <= DOUBLE_DOWN_MS;
      this.lastDown = twice ? null : at;
      this.apply(twice ? 'newest' : 'next');
      return;
    }
    this.lastDown = null;
    if (input === 'up') this.apply('previous');
    else if (input === 'select') this.apply('toggle');
    else if (input === 'back') this.apply('newest');
  }
  touch(event: string): void {
    const input = touchInput(event);
    if (input) this.press(input);
  }
}
export function touchInput(type: string): InputName | null {
  if (type === 'SCROLL_TOP_EVENT' || type === 'up') return 'up';
  if (type === 'SCROLL_BOTTOM_EVENT' || type === 'down') return 'down';
  if (type === 'CLICK_EVENT' || type === 'select') return 'select';
  if (type === 'DOUBLE_CLICK_EVENT' || type === 'back') return 'back';
  return null;
}
export interface RemoteOptions {
  hub(): ListenHubPort;
  active(): boolean;
  apply(input: InputName, seq: number, at?: number): void;
  sleep?(ms: number): Promise<void>;
}
/** One abortable long poll on the bound hub. Reopening starts from now (after=0). */
export class RemoteInput {
  private gen = 0;
  private ctl: AbortController | null = null;
  private running = false;
  private after = 0;
  private seen = 0;
  private releasePause: (() => void) | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly o: RemoteOptions) {}
  get waiting(): boolean { return this.running; }
  start(): void { this.sync(); }
  sync(): void {
    if (!this.o.active()) { this.stop(); return; }
    if (this.running) return;
    let hub: ListenHubPort;
    try { hub = this.o.hub(); } catch { return; }
    this.running = true; this.after = 0; this.seen = 0;
    void this.loop(hub, ++this.gen);
  }
  stop(): void {
    this.gen++; this.running = false; this.ctl?.abort(); this.ctl = null;
    clearTimeout(this.pauseTimer); this.releasePause?.(); this.releasePause = null;
  }
  close(): void { this.stop(); }
  private async pause(ms: number): Promise<void> {
    await Promise.race([
      this.o.sleep ? this.o.sleep(ms) : new Promise<void>(resolve => { this.pauseTimer = setTimeout(resolve, ms); }),
      new Promise<void>(resolve => { this.releasePause = resolve; }),
    ]);
    clearTimeout(this.pauseTimer); this.releasePause = null;
  }
  private async loop(hub: ListenHubPort, gen: number): Promise<void> {
    let fails = 0;
    while (gen === this.gen && this.o.active()) {
      const ctl = new AbortController(); this.ctl = ctl;
      try {
        const reply = await hub.waitInput(this.after, ctl.signal);
        if (gen !== this.gen || ctl.signal.aborted || !this.o.active()) return;
        if (reply.seq < this.after) this.seen = 0; // same hub restarted its counter
        this.after = reply.seq;
        for (const item of reply.inputs) {
          if (!Number.isSafeInteger(item.seq) || item.seq <= this.seen || item.seq > reply.seq) continue;
          this.seen = item.seq;
          if (!['up', 'down', 'select', 'back'].includes(item.input)) continue;
          this.o.apply(item.input as InputName, item.seq, item.at);
        }
        this.after = Math.max(this.after, this.seen); fails = 0;
      } catch {
        if (gen !== this.gen || ctl.signal.aborted) return;
        await this.pause(BACKOFF_MS[Math.min(fails++, BACKOFF_MS.length - 1)]);
      } finally { if (this.ctl === ctl) this.ctl = null; }
    }
    if (gen === this.gen) this.running = false;
  }
}
