import type { ListenSnapshot, Session } from './model';
import type { ListenHubPort } from './hub';

export const CHUNK_BYTES = 16_000 * 2 * 9;
export const MAX_QUEUED_CHUNKS = 3;
export const MIC_WARNING = 'Microphone may still be on. Close the app or try Stop again.';
export interface SessionDeps {
  hub(): ListenHubPort;
  mic: { on(): Promise<boolean>; off(): Promise<boolean> };
  publish(snapshot: ListenSnapshot): void;
  changed(): void;
  diag?(name: string): void;
  now?: () => number;
  timeoutMs?: number;
}
export type ListenPhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped' | 'error';
export interface SessionView { phase: ListenPhase; id: string; startedAt: number; micOn: boolean; warning: string; error: string; droppedChunks: number }

export class ListenSession {
  private phase: ListenPhase = 'idle';
  private data: Session | null = null;
  private hub: ListenHubPort | null = null;
  private micOn = false;
  private onPending = false;
  private warning = '';
  private error = '';
  private droppedChunks = 0;
  private bytes = new Uint8Array(0);
  private queue: { seq: number; pcm: Uint8Array }[] = [];
  private seq = 0;
  private gen = 0;
  private cancelStart = false;
  private closed = false;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private pumping: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private pollCtl: AbortController | null = null;
  private chunkCtl: AbortController | null = null;
  private lastPoll = 0;
  private muse: ListenSnapshot['muse'] = { state: 'idle' };
  private readonly d: SessionDeps;
  constructor(deps: SessionDeps) { this.d = deps; }
  view(): SessionView { return { phase: this.phase, id: this.data?.id ?? '', startedAt: this.data?.startedAt ?? 0, micOn: this.micOn, warning: this.warning, error: this.error, droppedChunks: this.droppedChunks }; }
  private changed(): void { this.d.changed(); }
  private now(): number { return (this.d.now ?? Date.now)(); }
  private async bounded<T>(job: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([job.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), this.d.timeoutMs ?? 12_000); })]); }
    finally { clearTimeout(timer); }
  }
  private async off(): Promise<void> {
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) { try { ok = await this.bounded(this.d.mic.off(), false); } catch { ok = false; } }
    this.micOn = !ok || this.onPending;
    this.warning = ok && !this.onPending ? '' : MIC_WARNING;
    if (!ok) this.d.diag?.('listen.mic-off-unconfirmed');
    this.changed();
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed || this.stopping || this.micOn || this.phase === 'listening') return Promise.resolve();
    this.phase = 'starting'; this.error = ''; this.warning = ''; this.cancelStart = false;
    this.bytes = new Uint8Array(0); this.queue = []; this.seq = 0; this.droppedChunks = 0;
    const gen = ++this.gen;
    let hub: ListenHubPort;
    try { hub = this.d.hub(); } catch { this.phase = 'error'; this.error = 'The listen hub is not configured.'; this.changed(); return Promise.resolve(); }
    this.data = null; this.hub = hub; this.changed();
    this.starting = this.begin(hub, gen).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async begin(hub: ListenHubPort, gen: number): Promise<void> {
    try {
      let abandonedStart = false;
      const request = hub.start().then(async value => {
        if (abandonedStart) await this.cleanupHub(hub, value.id);
        return value;
      });
      const started = await this.bounded<Session | null>(request, null);
      if (!started) { abandonedStart = true; throw new Error('Start outcome unknown'); }
      this.data = started;
      if (this.cancelStart || this.closed || gen !== this.gen) { await this.cleanupHub(hub, started.id); this.phase = 'stopped'; return; }
      let abandonedMic = false;
      this.onPending = true; this.micOn = true; this.changed();
      const on = Promise.resolve().then(() => this.d.mic.on()).then(async ok => {
        this.onPending = false;
        if (abandonedMic || this.cancelStart || this.closed || gen !== this.gen || this.phase !== 'starting') await this.off();
        return ok;
      }, () => { this.onPending = false; return false; });
      const ok = await this.bounded(on, false);
      abandonedMic = !ok || this.cancelStart || this.closed || gen !== this.gen;
      this.micOn = true; // until an explicit off confirms otherwise
      if (!ok || this.cancelStart || this.closed || gen !== this.gen) {
        await this.off(); await this.cleanupHub(hub, started.id);
        this.phase = ok ? 'stopped' : 'error'; this.error = ok ? '' : 'The microphone did not start.'; return;
      }
      this.phase = 'listening'; this.muse = { state: 'idle' };
      this.d.publish({ ...started, state: 'listening', now_t: 0, lines: [], notes: [], muse: { state: 'idle' } });
      this.lastPoll = 0;
    } catch {
      await this.off();
      if (this.data) await this.cleanupHub(hub, this.data.id);
      this.phase = 'error'; this.error = 'Listen could not start; the hub start outcome may be unknown.';
      this.d.diag?.('listen.start-failed');
    } finally { this.changed(); }
  }
  onAudio(pcm: Uint8Array): void {
    if (this.phase !== 'listening' || !pcm.length) return;
    if (pcm.length > CHUNK_BYTES * 4) { this.audioLost(); return; }
    const joined = new Uint8Array(this.bytes.length + pcm.length);
    joined.set(this.bytes); joined.set(pcm, this.bytes.length);
    let offset = 0;
    for (; joined.length - offset >= CHUNK_BYTES; offset += CHUNK_BYTES) this.enqueue(joined.slice(offset, offset + CHUNK_BYTES));
    this.bytes = joined.slice(offset);
  }
  private audioLost(): void { this.droppedChunks++; this.error = 'Some audio did not reach the hub.'; this.d.diag?.('listen.audio-lost'); this.changed(); }
  private enqueue(pcm: Uint8Array): void {
    const seq = this.seq++;
    if (this.queue.length >= MAX_QUEUED_CHUNKS) { this.audioLost(); return; }
    this.queue.push({ seq, pcm });
    if (!this.pumping) {
      const job = this.pump(this.gen).finally(() => { if (this.pumping === job) this.pumping = null; });
      this.pumping = job;
    }
  }
  private async pump(gen: number): Promise<void> {
    for (let item = this.queue.shift(); item && gen === this.gen; item = this.queue.shift()) {
      const hub = this.hub; const data = this.data;
      if (!hub || !data) return;
      const ctl = new AbortController(); this.chunkCtl = ctl;
      try {
        const receipt = await hub.chunk(data.id, item.seq, item.pcm, ctl.signal);
        if (gen === this.gen && receipt.lines.length) this.d.publish({ ...data, state: this.phase === 'listening' ? 'listening' : 'stopped', now_t: Math.max(0, this.now() - data.startedAt), lines: receipt.lines, notes: [], muse: this.muse });
      } catch { if (gen === this.gen) this.audioLost(); }
      finally { if (this.chunkCtl === ctl) this.chunkCtl = null; }
    }
  }
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (!this.hub || !this.data || this.closed || this.phase === 'starting') return Promise.resolve();
    const hub = this.hub, data = this.data, gen = this.gen;
    const ctl = new AbortController(); this.pollCtl = ctl;
    // No independent transcript cursor exists in the contract. since=0 avoids
    // losing a late transcription whose speech t predates a newer note.
    const job = hub.poll(data.id, 0, ctl.signal).then(async snapshot => {
      if (gen !== this.gen || this.closed || ctl.signal.aborted) return;
      if (snapshot.id !== data.id || snapshot.startedAt !== data.startedAt) throw new Error('Wrong session');
      this.muse = snapshot.muse; this.d.publish(snapshot);
      if (snapshot.state === 'stopped' && this.phase === 'listening') await this.stop();
    }).catch(() => { if (!ctl.signal.aborted && gen === this.gen) { this.error = 'Listen updates are unavailable.'; this.d.diag?.('listen.poll-failed'); this.changed(); } })
      .finally(() => { if (this.pollCtl === ctl) this.pollCtl = null; if (this.polling === job) this.polling = null; });
    this.polling = job; return job;
  }
  tick(): Promise<void> {
    if (this.phase !== 'listening' || this.now() - this.lastPoll < 2000) return Promise.resolve();
    this.lastPoll = this.now(); return this.poll();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.cancelStart = true; this.pollCtl?.abort(); this.polling = null;
    this.stopping = this.finish().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  private async finish(): Promise<void> {
    this.phase = 'stopping'; this.changed();
    await this.off();
    if (this.starting) await this.starting;
    await this.off();
    const tail = this.bytes.slice(0, this.bytes.length - this.bytes.length % 2);
    if (this.bytes.length % 2) this.audioLost();
    this.bytes = new Uint8Array(0);
    if (!this.closed && tail.length) this.enqueue(tail);
    if (this.closed) { this.queue = []; this.chunkCtl?.abort(); }
    if (this.pumping) {
      const drained = await this.bounded(this.pumping.then(() => true), false);
      if (!drained) { this.queue = []; this.chunkCtl?.abort(); this.pumping = null; this.audioLost(); }
    }
    if (this.hub && this.data) await this.cleanupHub(this.hub, this.data.id);
    this.gen++;
    this.phase = this.micOn ? 'error' : 'stopped';
    if (this.data) this.d.publish({ ...this.data, state: 'stopped', now_t: Math.max(0, this.now() - this.data.startedAt), lines: [], notes: [], muse: { state: 'idle' } });
    this.changed();
  }
  private async cleanupHub(hub: ListenHubPort, id: string): Promise<void> {
    const ok = await this.bounded(hub.stop(id).then(() => true), false);
    if (!ok) { this.error = 'The hub stop was not confirmed.'; this.d.diag?.('listen.stop-unconfirmed'); }
  }
  close(): Promise<void> { this.closed = true; return this.stop(); }
}
