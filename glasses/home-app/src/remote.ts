// The phone remote's live channel (docs/REMOTE-INPUT.md): one long-poll GET api/input/wait?after=<seq> to the
// CURRENT hub only, open only while Home is in front. Each input it brings goes through the app's own handle(),
// exactly like a gesture. Free of the DOM and of Muse; the only timers are the wait's own timeout and the
// error back-off.

export type RemoteInputName = 'up' | 'down' | 'select' | 'back';
const INPUTS: RemoteInputName[] = ['up', 'down', 'select', 'back'];
/** After an error: wait this long (ms) before the next try; the third and later failures keep the last value. */
export const BACKOFF_MS = [1000, 2000, 5000];
/** The hub answers after 25 s at most; give it a little longer. */
export const WAIT_TIMEOUT_MS = 30_000;

export interface RemoteOptions {
  /** The hub Home is using right now (never another one). */
  hub(): string;
  token(): string;
  /** True while a wait should be open: Home in front and paired. */
  active(): boolean;
  apply(input: RemoteInputName, seq: number): void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class RemoteInput {
  private gen = 0;
  private ctl: AbortController | null = null;
  private hub = '';
  private after = 0;

  constructor(private o: RemoteOptions) {}

  /** Call whenever something that decides the wait changes: foreground, token, current hub. */
  sync(): void {
    if (!this.o.active() || !this.o.token()) { this.stop(); return; }
    const hub = this.o.hub();
    if (this.ctl && hub === this.hub) return;
    this.stop();
    this.hub = hub;
    this.seenSeq = null;
    this.after = 0; // sequence numbers belong to one hub: a new hub starts "from now"
    void this.loop(++this.gen);
  }

  /** Drop the wait (background, signed out, hub switched). */
  stop(): void {
    this.gen += 1;
    this.ctl?.abort();
    this.ctl = null;
  }

  get waiting(): boolean { return this.ctl !== null; }

  private async loop(gen: number): Promise<void> {
    const doFetch = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let fails = 0;
    while (gen === this.gen) {
      const ctl = new AbortController();
      this.ctl = ctl;
      const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? WAIT_TIMEOUT_MS);
      try {
        const res = await doFetch(new URL(`api/input/wait?after=${this.after}`, this.hub), { headers: { Authorization: `Bearer ${this.o.token()}` }, signal: ctl.signal });
        if (!res.ok) throw new Error(`hub said ${res.status}`);
        const body = await res.json() as { seq?: number; inputs?: { seq: number; input: string }[] };
        if (gen !== this.gen) return; // switched or backgrounded while the answer was on its way: drop it
        fails = 0;
        if (typeof body.seq === 'number' && body.seq > this.after) this.after = body.seq;
        for (const item of body.inputs ?? []) {
          if (typeof item.seq !== 'number' || item.seq <= (this.seenSeq ?? 0) || !INPUTS.includes(item.input as RemoteInputName)) continue;
          this.seenSeq = item.seq;
          this.after = Math.max(this.after, item.seq);
          this.o.apply(item.input as RemoteInputName, item.seq);
        }
      } catch {
        if (gen !== this.gen) return;
        await sleep(BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)]);
        fails += 1;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  private seenSeq: number | null = null;
}
