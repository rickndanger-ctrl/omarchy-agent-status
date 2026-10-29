// The Conversation tile's engine (docs/CONVERSATION.md). Free of the SDK, the DOM and the network: the microphone,
// the hub and the clock are handed in, so tests use fakes. It never touches Muse; "Send summary to Muse" only hands
// Home's existing {kind: 'askMuse', text} action to the dispatcher it is given.
import type { Action } from './model';

export type ConvBackend = 'local' | 'claude' | 'codex';
export const CONV_BACKENDS: { id: ConvBackend; label: string }[] = [
  { id: 'claude', label: 'Claude' }, { id: 'local', label: 'Local model (free)' }, { id: 'codex', label: 'ChatGPT (Codex)' },
];
export const DEFAULT_CONV_BACKEND: ConvBackend = 'claude';
export const asBackend = (v: unknown): ConvBackend => (v === 'local' || v === 'claude' || v === 'codex' ? v : DEFAULT_CONV_BACKEND);

/** 16 kHz, s16le, mono: 9 seconds. */
export const CHUNK_BYTES = 16_000 * 2 * 9;
/** A last piece shorter than this at Stop is not worth a request. */
export const MIN_LAST_CHUNK_BYTES = 16_000 * 2;
export const MAX_LISTEN_MS = 30 * 60_000;
export const POLL_EVERY_MS = 2000;
export const SUMMARY_WAIT_MS = 3 * 60_000;
export const MUSE_MAX_CHARS = 1500;
const CHUNK_RETRY_MS = [500, 1500];

/** What GET /api/conversation returns. */
export interface Conversation {
  id?: string;
  state: 'listening' | 'summarizing' | 'done' | 'error' | 'idle';
  backend?: string; startedAt?: number; stoppedAt?: number;
  hints?: string[]; summary?: string[]; actions?: string[];
  fallback?: string; error?: string; chunks?: number; words?: number;
}

/** A failed hub call; `status` is the HTTP status when there was one. */
export class ConvHttpError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export interface ConvHub {
  start(backend: ConvBackend): Promise<{ id: string; startedAt: number }>;
  chunk(id: string, seq: number, pcm: Uint8Array): Promise<void>;
  stop(id: string): Promise<void>;
  get(): Promise<Conversation>;
}
/** off() resolves to whether the microphone really went off (glasses.microphone(false)). */
export interface ConvMic { on(): Promise<boolean>; off(): Promise<boolean> }
export const MIC_STILL_ON = 'Microphone may still be on: close the app';

/** Runs a state change now, or in the app's input queue turn. */
export type Defer = (apply: () => void) => void;

export interface ConvDeps {
  /** The hub for a new session: bound to the hub current at that moment, kept for the whole session. */
  hub(): ConvHub;
  mic: ConvMic;
  /** True while the voice-reply microphone is recording. */
  voiceMicBusy(): boolean;
  /** Summary ids already sent to Muse (remembered across restarts). */
  sent: { has(id: string): boolean; add(id: string): void };
  diag(name: string, detail?: string | number): void;
  /** Called when the view changed outside a tap (so the screen repaints). */
  changed(): void;
  sleep?(ms: number): Promise<void>;
}

export type ConvPhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'summarizing' | 'done' | 'error';

export interface ConvView {
  phase: ConvPhase;
  elapsedMs: number;
  hints: string[]; summary: string[]; actions: string[];
  fallback: string; error: string; notice: string;
  /** Pieces of audio that never reached the hub, and a lasting warning (the microphone may still be on). */
  skipped: number; warning: string;
  id: string; stoppedAt: number;
  /** This summary was already sent to Muse. */
  sent: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const clockTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

/** The text Muse is asked about, at most MUSE_MAX_CHARS. */
export function museSummaryText(summary: string[], actions: string[], at: number): string {
  const d = new Date(at);
  const head = `Summary of a conversation (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}):`;
  const parts = [head, ...summary, ...(actions.length ? ['Action items:', ...actions.map(a => `- ${a}`)] : [])];
  const text = parts.join('\n');
  return text.length <= MUSE_MAX_CHARS ? text : `${text.slice(0, MUSE_MAX_CHARS - 1)}…`;
}

export class ConversationSession {
  private phase: ConvPhase = 'idle';
  private id = '';
  private startedAt = 0;
  private stoppedAt = 0;
  private hub: ConvHub | null = null;
  private seq = 0;
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private queue: { seq: number; pcm: Uint8Array }[] = [];
  private pumping: Promise<void> | null = null;
  private data: Conversation | null = null;
  private notice = '';
  private errorText = '';
  private lastPoll = 0;
  private polling = false;
  private summarizingSince = 0;
  private loaded = false;
  private stopping: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private cancelStart = false;
  private skipped = 0;
  private warning = '';
  /** Sent ids also live here, so a localStorage that fails cannot allow a second send. */
  private sentMem = new Set<string>();
  private now: () => number;

  constructor(private readonly deps: ConvDeps, now: () => number = Date.now) { this.now = now; }

  /** True from Start until the microphone is released: the voice-reply microphone must stay away. */
  isListening(): boolean { return this.phase === 'starting' || this.phase === 'listening' || this.phase === 'stopping'; }

  view(): ConvView {
    const d = this.data;
    const mine = d && d.id === this.id;
    return {
      phase: this.phase,
      elapsedMs: this.phase === 'listening' || this.phase === 'stopping' ? this.now() - this.startedAt : 0,
      hints: mine ? d.hints ?? [] : [], summary: mine ? d.summary ?? [] : [], actions: mine ? d.actions ?? [] : [],
      fallback: mine ? d.fallback ?? '' : '', error: this.errorText, notice: this.notice,
      id: this.id, stoppedAt: this.stoppedAt || (mine ? d.stoppedAt ?? 0 : 0),
      skipped: this.skipped, warning: this.warning,
      sent: Boolean(this.id) && this.wasSent(this.id),
    };
  }

  private wasSent(id: string): boolean {
    if (this.sentMem.has(id)) return true;
    try { return this.deps.sent.has(id); } catch { return false; }
  }

  /** Microphone off; a refusal is tried once more, and a second one leaves a warning on the tile. */
  private micOffPending: Promise<void> | null = null;
  /** Tracked, so a new Start waits for an older microphone-off that is still running (it must not silence the new session). */
  private micOff(): Promise<void> {
    const job = this.micOffNow();
    this.micOffPending = job;
    void job.then(() => { if (this.micOffPending === job) this.micOffPending = null; });
    return job;
  }

  private async micOffNow(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let ok = false;
      try { ok = await this.deps.mic.off(); } catch { ok = false; }
      if (ok) { this.warning = ''; return; }
    }
    this.warning = MIC_STILL_ON;
    this.deps.diag('conv.mic-off-failed');
  }

  /** Once, when the tile is first shown: pick up the last finished summary the hub kept. */
  async load(defer: Defer = now => now()): Promise<void> {
    if (this.loaded || this.phase !== 'idle') return;
    this.loaded = true;
    try {
      const d = await this.deps.hub().get();
      // `defer` lets the app apply the answer in its input queue's turn (a press made before it acts on what the owner saw).
      defer(() => {
        if (this.phase !== 'idle') return;
        if (d.state === 'done' && d.id) { this.adopt(d); this.phase = 'done'; }
        else if (d.state === 'listening' || d.state === 'summarizing') this.notice = 'A session is already running on the hub.';
      });
    } catch { this.loaded = false; /* asked again next time the tile is shown */ }
  }

  private adopt(d: Conversation): void {
    this.data = d; this.id = d.id ?? ''; this.startedAt = d.startedAt ?? 0; this.stoppedAt = d.stoppedAt ?? 0;
  }

  start(backend: ConvBackend): Promise<void> {
    if (this.isListening() || this.phase === 'summarizing') return Promise.resolve();
    if (this.deps.voiceMicBusy()) { this.notice = 'Finish the voice reply first'; return Promise.resolve(); }
    this.notice = ''; this.errorText = ''; this.data = null; this.skipped = 0; this.cancelStart = false;
    this.phase = 'starting';
    this.starting = this.doStart(backend).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(backend: ConvBackend): Promise<void> {
    const hub = this.deps.hub();
    let started: { id: string; startedAt: number };
    try {
      started = await hub.start(backend);
      if (this.cancelStart) {
        // Stopped before the hub answered: close the session it just opened; the microphone never went on.
        void hub.stop(started.id).catch(() => {});
        this.phase = 'idle'; this.id = ''; this.notice = 'Stopped before it began';
        return;
      }
      this.id = started.id; this.hub = hub;
    } catch (e) {
      this.phase = 'idle'; this.id = '';
      this.notice = e instanceof ConvHttpError && e.status === 409 ? 'Already listening (started elsewhere)' : `Could not start: ${e instanceof Error ? e.message : e}`;
      this.deps.diag('conv.start-failed', e instanceof ConvHttpError ? e.status : 0);
      return;
    }
    this.seq = 0; this.parts = []; this.bytes = 0; this.queue = []; this.lastPoll = this.now();
    this.startedAt = this.now(); this.stoppedAt = 0;
    await this.micOffPending;
    let on = false;
    try { on = await this.deps.mic.on(); } catch { on = false; }
    if (this.cancelStart) {
      // Stopped while the microphone was starting: whatever it did, turn it off and close the hub session.
      await this.micOff();
      void this.hub.stop(this.id).catch(() => {});
      this.phase = 'idle'; this.id = ''; this.notice = 'Stopped before it began';
      return;
    }
    if (!on) {
      this.phase = 'error'; this.errorText = 'The microphone did not start.';
      void this.hub.stop(this.id).catch(() => {});
      return;
    }
    this.phase = 'listening';
    this.deps.diag('conv.start', backend);
  }

  /** One piece of microphone audio. */
  onAudio(pcm: Uint8Array): void {
    if (this.phase !== 'listening') return;
    this.parts.push(pcm); this.bytes += pcm.length;
    if (this.bytes < CHUNK_BYTES) return;
    const all = this.take();
    let at = 0;
    for (; all.length - at >= CHUNK_BYTES; at += CHUNK_BYTES) this.enqueue(all.slice(at, at + CHUNK_BYTES));
    if (at < all.length) { this.parts = [all.slice(at)]; this.bytes = all.length - at; }
  }

  private take(): Uint8Array {
    const all = new Uint8Array(this.bytes);
    let at = 0;
    for (const p of this.parts) { all.set(p, at); at += p.length; }
    this.parts = []; this.bytes = 0;
    return all;
  }

  private enqueue(pcm: Uint8Array): void {
    this.queue.push({ seq: this.seq++, pcm });
    if (!this.pumping) this.pumping = this.pump().finally(() => { this.pumping = null; });
  }

  /** Chunks go one at a time, in order. A failed one is tried again twice before it is skipped. */
  private async pump(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      const t0 = this.now();
      for (let attempt = 0; ; attempt++) {
        try {
          await this.hub!.chunk(this.id, item.seq, item.pcm);
          this.deps.diag('conv.chunk', `${item.seq} ${this.now() - t0} ms`);
          break;
        } catch (e) {
          const status = e instanceof ConvHttpError ? e.status : 0;
          if (status === 404 || status === 410) { this.deps.diag('conv.chunk-gone', status); this.queue = []; this.sessionLost(); return; }
          if (status === 413 || attempt >= CHUNK_RETRY_MS.length) { this.skipped++; this.deps.diag('conv.chunk-skipped', `${item.seq} ${status}`); break; }
          await sleep(CHUNK_RETRY_MS[attempt]);
        }
      }
    }
  }

  private sessionLost(): void {
    if (this.phase !== 'listening' && this.phase !== 'stopping') return;
    void this.micOff().then(() => this.deps.changed());
    this.phase = 'error'; this.errorText = 'The hub ended the session.';
    this.deps.changed();
  }

  /** Stop listening and ask for the summary. Safe to call twice (a tap and the background event). */
  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.phase === 'starting') { this.cancelStart = true; return this.starting ?? Promise.resolve(); }
    if (this.phase !== 'listening') return Promise.resolve();
    this.stopping = this.doStop(reason).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.phase = 'stopping';
    await this.micOffPending;
    await this.micOff();
    if (this.bytes >= MIN_LAST_CHUNK_BYTES) this.enqueue(this.take()); else { this.parts = []; this.bytes = 0; }
    await this.pumping;
    if (this.phase !== 'stopping') return; // the hub ended it meanwhile
    this.stoppedAt = this.now();
    this.deps.diag('conv.stop', `${reason} ${this.seq} chunks`);
    try {
      await this.hub!.stop(this.id);
      this.phase = 'summarizing'; this.summarizingSince = this.now(); this.lastPoll = 0;
    } catch (e) {
      this.phase = 'error'; this.errorText = `Could not reach the hub to stop (${e instanceof Error ? e.message : e}).`;
    }
  }

  /** Called from the existing 1.2 s timer: the 30 minute stop, and the 2 s poll while listening or summarizing. */
  async tick(defer: Defer = now => now()): Promise<void> {
    const now = this.now();
    if (this.phase === 'listening' && now - this.startedAt >= MAX_LISTEN_MS) { void this.stop('30 min'); return; }
    if (this.phase === 'summarizing' && now - this.summarizingSince >= SUMMARY_WAIT_MS) {
      this.phase = 'error'; this.errorText = 'The summary took too long.'; this.deps.changed(); return;
    }
    if ((this.phase !== 'listening' && this.phase !== 'summarizing') || this.polling || now - this.lastPoll < POLL_EVERY_MS) return;
    this.polling = true; this.lastPoll = now;
    try {
      const d = await this.hub!.get();
      defer(() => {
        if (d.id !== this.id) return;
        this.data = d;
        if (this.phase === 'summarizing') {
          if (d.state === 'done') this.phase = 'done';
          else if (d.state === 'error') { this.phase = 'error'; this.errorText = d.error || 'The summary failed.'; }
        } else if (this.phase === 'listening') {
          if (d.state === 'done' || d.state === 'summarizing' || d.state === 'idle') this.sessionLost();
          else if (d.state === 'error') this.errorText = d.error || '';
          else this.errorText = '';
        }
        this.deps.changed();
      });
    } catch { /* the next tick asks again */ } finally { this.polling = false; }
  }

  /**
   * "Send summary to Muse": hands Home's existing askMuse action to `dispatch`, once per summary id, only for a
   * finished summary and never while listening. Returns whether it was sent.
   */
  sendToMuse(dispatch: (action: Action) => void): boolean {
    if (this.phase !== 'done' || this.isListening() || !this.id || this.wasSent(this.id)) return false;
    const v = this.view();
    if (!v.summary.length && !v.actions.length) return false;
    // Marked first, in memory and in the store, before Muse is asked: once only, whatever happens next.
    this.sentMem.add(this.id);
    try { this.deps.sent.add(this.id); } catch { /* the in-memory mark still holds */ }
    dispatch({ kind: 'askMuse', text: museSummaryText(v.summary, v.actions, v.stoppedAt || this.startedAt) });
    this.deps.diag('conv.muse', 'sent');
    return true;
  }
}
