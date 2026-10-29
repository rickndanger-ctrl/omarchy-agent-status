// One entry point for every press, touchpad or phone remote, and for menu choices: they wait in a single queue and
// are applied one at a time. After each one the next waits until the glasses show the result (or a cap passes), so a
// quick series never moves the model ahead of what the owner can see. Free of the SDK and the DOM.
import type { Input } from './model';
import type { SettleResult } from './settle';

export type InputSource = 'touch' | 'remote';
/** At most this many remote presses wait; touch and menu choices may queue up to MAX_TOUCH_QUEUED. */
export const MAX_QUEUED = 5;
export const MAX_TOUCH_QUEUED = 10;

export interface QueueHost {
  /** Apply one press (the app's handle flow). */
  apply(input: Input): void;
  /** Apply one long-press menu choice. */
  menu(id: number): void;
  /** The screen the model is on, for the log. */
  screen(): string;
  /**
   * A number that changes whenever the screen changes (the model's screen, Tiles on/off, a screen opened from a tile).
   * A press queued on one screen is dropped if an alert or a poll changed the screen before it ran.
   */
  generation(): number;
  /** Resolves when the glasses show what the model says (capped by the caller). */
  settled(): Promise<SettleResult>;
  log(name: string, detail: string): void;
}

type Entry = { kind: 'input'; input: Input; source: InputSource; stamp: number } | { kind: 'menu'; id: number; source: InputSource };
const label = (e: Entry) => (e.kind === 'input' ? `${e.input} from ${e.source}` : `menu ${e.id} from ${e.source}`);

export class InputQueue {
  private pending: Entry[] = [];
  private running = false;
  /** Screen changes made by our own presses; everything else counted by generation() is unsolicited. */
  private own = 0;

  constructor(private readonly host: QueueHost, private readonly max = MAX_QUEUED, private readonly maxTouch = MAX_TOUCH_QUEUED) {}

  get length(): number { return this.pending.length; }

  private unsolicited(): number { return this.host.generation() - this.own; }

  push(input: Input, source: InputSource): void {
    this.add({ kind: 'input', input, source, stamp: this.unsolicited() });
  }

  pushMenu(id: number): void {
    this.add({ kind: 'menu', id, source: 'touch' });
  }

  /** Forget everything waiting (the app left the front, or the glasses disconnected). */
  clear(reason: string): void {
    for (const e of this.pending.splice(0)) this.host.log('input.cancelled', `${label(e)} (${reason})`);
  }

  private add(entry: Entry): void {
    if (entry.source === 'remote') {
      if (this.pending.length >= this.max) {
        // Too many: the oldest remote up/down goes. If there is none, the new press is the one dropped.
        const old = this.pending.findIndex(p => p.kind === 'input' && p.source === 'remote' && (p.input === 'up' || p.input === 'down'));
        if (old < 0) { this.host.log('input.dropped', `${label(entry)} (new)`); return; }
        this.host.log('input.dropped', label(this.pending.splice(old, 1)[0]));
      }
    } else if (this.pending.length >= this.maxTouch) {
      const old = this.pending.findIndex(p => p.kind === 'input' && p.source === 'remote' && (p.input === 'up' || p.input === 'down'));
      if (old < 0) { this.host.log('input.dropped', `${label(entry)} (new)`); return; }
      this.host.log('input.dropped', label(this.pending.splice(old, 1)[0]));
    }
    this.pending.push(entry);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        if (next.kind === 'input' && next.stamp !== this.unsolicited()) {
          // An alert, a poll or something else changed the screen after this press was queued: it was meant for another screen.
          this.host.log('input.stale', `${label(next)} on ${this.host.screen()}`);
          continue;
        }
        this.host.log(next.kind === 'input' ? 'input' : 'menu', next.kind === 'input' ? `${label(next)} on ${this.host.screen()}` : `${next.id} from ${next.source} on ${this.host.screen()}`);
        const before = this.host.generation();
        try { if (next.kind === 'input') this.host.apply(next.input); else this.host.menu(next.id); } catch (error) { this.host.log('input.error', error instanceof Error ? error.message : String(error)); }
        this.own += this.host.generation() - before;
        // Always wait, even with nothing queued yet: the next press (a remote sends them ~20 ms apart) must not
        // run until the glasses show this one's result.
        const result = await this.host.settled();
        this.host.log(result === 'rendered' ? 'shown' : result === 'capped' ? 'settle-capped' : 'not-visible', this.host.screen());
      }
    } finally {
      this.running = false;
    }
  }
}
