// One entry point for every press, touchpad or phone remote, for menu choices, and for the updates that change what
// is shown (polls, refreshes): they wait in a single queue and are applied one at a time. After each one the next
// waits until the glasses show the result (or a cap passes), so a quick series never moves the model ahead of what
// the owner can see, and a press acts on the screen it was made on. Free of the SDK and the DOM.
import type { Input } from './model';
import type { SettleResult } from './settle';

export type InputSource = 'touch' | 'remote';
/** At most this many remote presses wait; touch and menu choices may queue up to MAX_TOUCH_QUEUED. When full, the new press is dropped. */
export const MAX_QUEUED = 5;
export const MAX_TOUCH_QUEUED = 10;
/** An apply that returns a promise (a menu choice waiting for the hub, the microphone) is awaited at most this long. */
export const APPLY_WAIT_MS = 3000;
/** An update (poll, terminal, tiles) waits for its frame at most this long, and not at all while a press is waiting. */
export const EXTERNAL_WAIT_MS = 300;

export interface QueueHost {
  /** Apply one press (the app's handle flow). May return a promise to be awaited (microphone changes). */
  apply(input: Input): void | Promise<void>;
  /** Apply one long-press menu choice. May return a promise (Pause waits for the hub). */
  menu(id: number): void | Promise<void>;
  /** The screen the model is on, for the log. */
  screen(): string;
  /**
   * A number that changes whenever the screen changes (the model's screen, Tiles on/off, a screen opened from a tile).
   * A press queued on one screen is dropped if an alert changed the screen before it ran.
   */
  generation(): number;
  /** Is the app in front? Presses are ignored when it is not. */
  foreground(): boolean;
  /** Resolves when the glasses show what the model says (capped by the caller). */
  settled(capMs?: number): Promise<SettleResult>;
  log(name: string, detail: string): void;
}

type Entry =
  | { kind: 'input'; input: Input; source: InputSource; stamp: number }
  | { kind: 'menu'; id: number; source: InputSource }
  | { kind: 'external'; name: string; run: () => void };
const label = (e: Entry) => (e.kind === 'input' ? `${e.input} from ${e.source}` : e.kind === 'menu' ? `menu ${e.id} from ${e.source}` : `update ${e.name}`);

export class InputQueue {
  private pending: Entry[] = [];
  private running = false;
  /** Screen changes made by our own presses; everything else counted by generation() is unsolicited. */
  private own = 0;

  constructor(private readonly host: QueueHost, private readonly max = MAX_QUEUED, private readonly maxTouch = MAX_TOUCH_QUEUED, private readonly applyWaitMs = APPLY_WAIT_MS) {}

  get length(): number { return this.pending.length; }

  private unsolicited(): number { return this.host.generation() - this.own; }

  push(input: Input, source: InputSource): void {
    if (!this.host.foreground()) { this.host.log('input.ignored', `${input} from ${source} (not in front)`); return; }
    this.add({ kind: 'input', input, source, stamp: this.unsolicited() });
  }

  pushMenu(id: number, source: InputSource = 'touch'): void {
    if (!this.host.foreground()) { this.host.log('input.ignored', `menu ${id} (not in front)`); return; }
    this.add({ kind: 'menu', id, source });
  }

  /**
   * A change to what is shown that did not come from a press (a poll, a refresh): it takes its turn, so presses made
   * before it act on what the owner saw, and presses after it wait for its frame. One waiting update per name; a
   * newer one runs after the older one in the same turn.
   */
  pushExternal(name: string, run: () => void): void {
    const waiting = this.pending.find((e): e is Extract<Entry, { kind: 'external' }> => e.kind === 'external' && e.name === name);
    if (waiting) { const older = waiting.run; waiting.run = () => { older(); run(); }; return; }
    this.pending.push({ kind: 'external', name, run });
    if (!this.running) void this.drain();
  }

  /** Forget everything waiting (the app left the front, the glasses disconnected, nothing is visible). Updates still run. */
  clear(reason: string): void {
    const keep: Entry[] = [];
    for (const e of this.pending.splice(0)) {
      if (e.kind === 'external') keep.push(e); else this.host.log('input.cancelled', `${label(e)} (${reason})`);
    }
    this.pending = keep;
  }

  private add(entry: Entry): void {
    const waiting = this.pending.filter(p => p.kind !== 'external').length;
    const cap = entry.kind === 'input' && entry.source === 'remote' ? this.max : this.maxTouch;
    if (waiting >= cap) { this.host.log('input.dropped', `${label(entry)} (queue full)`); return; }
    this.pending.push(entry);
    if (!this.running) void this.drain();
  }

  /** Await a job's promise, but not longer than APPLY_WAIT_MS. */
  private async bounded(job: void | Promise<void>): Promise<void> {
    if (!job) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([job.catch(error => this.host.log('input.error', error instanceof Error ? error.message : String(error))), new Promise<void>(r => { timer = setTimeout(r, this.applyWaitMs); })]);
    } finally { clearTimeout(timer); }
  }

  /** Presses and menu choices go before waiting updates: a press must never queue behind a poll's or a terminal's repaint. */
  private takeNext(): Entry | undefined {
    const i = this.pending.findIndex(e => e.kind !== 'external');
    return this.pending.splice(i < 0 ? 0 : i, 1)[0];
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let next = this.takeNext(); next; next = this.takeNext()) {
        if (next.kind === 'input' && next.stamp !== this.unsolicited()) {
          // An alert (or anything else) changed the screen after this press was queued: it was meant for another screen.
          this.host.log('input.stale', `${label(next)} on ${this.host.screen()}`);
          continue;
        }
        if (next.kind !== 'external') this.host.log(next.kind, next.kind === 'input' ? `${label(next)} on ${this.host.screen()}` : `${next.id} from ${next.source} on ${this.host.screen()}`);
        const before = this.host.generation();
        const screenBefore = this.host.screen();
        let job: void | Promise<void> = undefined;
        try {
          if (next.kind === 'input') job = this.host.apply(next.input);
          else if (next.kind === 'menu') job = this.host.menu(next.id);
          else next.run();
        } catch (error) { this.host.log('input.error', error instanceof Error ? error.message : String(error)); }
        // Screen changes from our own presses are not "unsolicited"; an update's are (an alert popping up).
        if (next.kind !== 'external') this.own += this.host.generation() - before;
        // A press that left its screen (Back, or a select that opened or closed one): scrolling presses already waiting were
        // meant for the screen left and must not move the cursor on the new one. A waiting back/select stays.
        if (next.kind === 'input' && this.host.screen() !== screenBefore) {
          this.pending = this.pending.filter(e => {
            if (e.kind !== 'input' || (e.input !== 'up' && e.input !== 'down')) return true;
            this.host.log('input.dropped', `${label(e)} (left ${screenBefore})`);
            return false;
          });
        }
        await this.bounded(job);
        // Always wait, even with nothing queued yet: the next press (a remote sends them ~20 ms apart) must not
        // run until the glasses show this one's result.
        // An update only waits briefly, and not at all with something queued behind it: its frame is not worth a press's time.
        if (next.kind === 'external' && this.pending.length) continue;
        const result = await this.host.settled(next.kind === 'external' ? EXTERNAL_WAIT_MS : undefined);
        if (next.kind !== 'external') this.host.log(result === 'rendered' ? 'shown' : result === 'capped' ? 'settle-capped' : 'not-visible', this.host.screen());
        // Nothing can be seen: the rest of the presses would be blind. Forget them.
        if (result === 'not-visible') this.clear('not visible');
      }
    } finally {
      this.running = false;
    }
  }
}
