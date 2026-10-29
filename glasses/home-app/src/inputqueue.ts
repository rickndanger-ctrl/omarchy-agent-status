// One entry point for every press, touchpad or phone remote: they wait in a single queue and are applied one at a
// time. After each press the next one waits until the glasses show the result (or a cap passes), so a quick series
// never moves the model ahead of what the owner can see. Free of the SDK and the DOM.
import type { Input } from './model';

export type InputSource = 'touch' | 'remote';
export const MAX_QUEUED = 5;

export interface QueueHost {
  /** Apply one press (the app's handle flow). */
  apply(input: Input): void;
  /** The screen the model is on, for the log. */
  screen(): string;
  /** Resolves when the glasses show what the model says (capped by the caller). */
  settled(): Promise<void>;
  log(name: string, detail: string): void;
}

export class InputQueue {
  private pending: { input: Input; source: InputSource }[] = [];
  private running = false;

  constructor(private readonly host: QueueHost, private readonly max = MAX_QUEUED) {}

  get length(): number { return this.pending.length; }

  push(input: Input, source: InputSource): void {
    // Too many waiting: the oldest remote presses go first (a held-down remote button), never a touch.
    while (this.pending.length >= this.max) {
      const old = this.pending.findIndex(p => p.source === 'remote');
      if (old < 0) break;
      const [dropped] = this.pending.splice(old, 1);
      this.host.log('input.dropped', `${dropped.input} from remote`);
    }
    this.pending.push({ input, source });
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        this.host.log('input', `${next.input} from ${next.source} on ${this.host.screen()}`);
        try { this.host.apply(next.input); } catch (error) { this.host.log('input.error', error instanceof Error ? error.message : String(error)); }
        // Always wait, even with nothing queued yet: the next press (a remote sends them ~20 ms apart) must not
        // run until the glasses show this one's result.
        await this.host.settled();
        this.host.log('shown', this.host.screen());
      }
    } finally {
      this.running = false;
    }
  }
}
