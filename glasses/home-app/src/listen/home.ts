// Listen screen controller. Home alone owns SDK events, global input and audio.
import { ListenHub, type ListenHubPort } from './hub';
import { InputMapper, type InputName } from './input';
import { applySnapshot, backToNewest, createModel, layoutText, selectNote, type ListenModel } from './model';
import { renderListenFrame, type HomeListenFrame } from './render';
import { ListenSession, type SessionView } from './session';

export interface HomeListenOptions {
  hub(): { base: string; token: string } | ListenHubPort;
  mic: { on(): Promise<boolean>; off(): Promise<boolean> };
  /** Include pending agent/Muse microphone, transcription and SDK operations. */
  busy(): boolean | string;
  changed(): void;
  /** Explicit Back only. leave() itself does cleanup without navigating. */
  leave(): void;
  now?: () => number;
  inputNow?: () => number;
  diag?(name: string): void;
  timeoutMs?: number;
}
export interface HomeListenView extends SessionView {
  active: boolean;
  ownsMic: boolean;
  notice: string;
  model: ListenModel;
  layout: ReturnType<typeof layoutText>;
  selectedNoteIndex: number | null;
  transcriptAt: number | null;
  transcriptIndex: number | null;
}

export class HomeListen {
  private model = createModel();
  private active = false;
  private closed = false;
  private claimed = false;
  private micTouched = false;
  private entry = 0;
  private notice = 'Hold to start listening.';
  private bound: ListenHubPort | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly session: ListenSession;
  private readonly mapper: InputMapper;

  constructor(private readonly o: HomeListenOptions) {
    this.mapper = new InputMapper(action => {
      if (action === 'previous') this.model = selectNote(this.model, 'up');
      else if (action === 'next') this.model = selectNote(this.model, 'down');
      else if (action === 'newest') this.model = backToNewest(this.model);
      this.notify();
    }, o.inputNow ?? o.now ?? (() => performance.now()));
    this.session = new ListenSession({
      hub: () => { if (!this.bound) throw new Error('Listen hub not configured'); return this.bound; },
      mic: {
        on: async () => {
          if (!this.active || this.closed || this.otherBusy()) return false;
          this.micTouched = true;
          return this.o.mic.on();
        },
        // Never switch off a different voice owner's microphone after our claim
        // has already ended. A pending/uncertain Listen on retains that claim.
        off: () => this.claimed && this.micTouched ? this.o.mic.off() : Promise.resolve(true),
      },
      publish: snapshot => {
        if (!this.model.session || this.model.session.id !== snapshot.id || this.model.session.startedAt !== snapshot.startedAt) this.model = createModel();
        this.model = applySnapshot(this.model, snapshot);
        this.notify();
      },
      changed: () => this.notify(), now: () => this.now(), diag: o.diag, timeoutMs: o.timeoutMs,
    });
  }
  get ownsMic(): boolean { return this.claimed; }
  private now(): number { return (this.o.now ?? Date.now)(); }
  private otherBusy(): boolean {
    try { return this.o.busy() !== false; } catch { return true; }
  }
  private notify(): void {
    if (this.claimed && !this.starting && !this.stopping) {
      const state = this.session.view();
      if (!state.micOn && !['starting', 'listening', 'stopping'].includes(state.phase)) {
        this.claimed = false; this.micTouched = false;
      }
    }
    this.o.changed();
  }
  enter(): void {
    if (this.active || this.closed) return;
    this.active = true; this.entry++; this.mapper.reset(); this.notify();
  }
  private start(): Promise<void> {
    if (!this.active || this.closed || this.starting || this.stopping || this.claimed) return this.starting ?? Promise.resolve();
    if (this.otherBusy()) {
      this.notice = 'Another voice recording or transcription is active. Stop it before Muse Listen.';
      this.notify(); return Promise.resolve();
    }
    let port: ListenHubPort;
    try {
      const value = this.o.hub();
      port = 'start' in value ? value : new ListenHub({ url: value.base, token: value.token });
    } catch {
      this.notice = 'Configure the Home hub before starting Listen.';
      this.notify(); return Promise.resolve();
    }
    this.claimed = true; this.micTouched = false; this.bound = port; this.notice = ''; this.model = createModel();
    // Publish the reservation before any await, but install the task guard before
    // callbacks can paint/re-enter. Leaving can cancel before hub.start begins.
    const job = Promise.resolve().then(async () => {
      if (this.active && !this.closed) await this.session.start();
    }).finally(() => { if (this.starting === job) this.starting = null; this.notify(); });
    this.starting = job; this.notify(); return job;
  }
  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.claimed) return Promise.resolve();
    this.mapper.reset();
    const job = Promise.resolve().then(() => this.session.stop())
      .finally(() => { if (this.stopping === job) this.stopping = null; this.notify(); });
    this.stopping = job; this.notify(); return job;
  }
  async input(input: InputName, source: 'touch' | 'remote' = 'touch', arrivedAt?: number): Promise<void> {
    if (!this.active || this.closed) return;
    if (input === 'back') { await this.leave(); this.o.leave(); return; }
    if (input === 'select') {
      this.mapper.reset();
      if (this.claimed || this.session.view().phase === 'starting') await this.stop();
      else if (source === 'remote') await this.start();
      else { this.notice = 'Hold to start listening.'; this.notify(); }
      return;
    }
    // Home may pace application behind SDK writes. Gesture timing belongs to
    // the input's local arrival, rather than the delayed render/queue turn.
    this.mapper.press(input, Number.isFinite(arrivedAt) ? arrivedAt : undefined);
  }
  hold(): Promise<void> {
    if (!this.active || this.closed) return Promise.resolve();
    this.mapper.reset();
    return this.claimed ? this.stop() : this.start();
  }
  /** Invisibility/menu/background cleanup; never changes Home's destination. */
  leave(): Promise<void> {
    if (!this.active) return this.stopping ?? Promise.resolve();
    this.active = false; this.mapper.reset();
    const job = this.stop(); this.notify(); return job;
  }
  async close(): Promise<void> { this.closed = true; this.active = false; this.mapper.reset(); await this.stop(); }
  onAudio(pcm: Uint8Array): boolean {
    if (!this.claimed) return false;
    if (this.active && !this.closed) this.session.onAudio(pcm);
    return true; // Consume/drop late Listen audio until confirmed off, even away.
  }
  async tick(): Promise<void> {
    if (!this.active || this.closed) return;
    this.notify(); await this.session.tick();
  }
  poll(): Promise<void> { return this.active && !this.closed ? this.session.poll() : Promise.resolve(); }
  frame(): HomeListenFrame { return renderListenFrame(this.model, this.session.view(), this.now(), this.entry, this.notice); }
  view(): HomeListenView {
    const layout = layoutText(this.model, this.now());
    return { ...this.session.view(), active: this.active, ownsMic: this.claimed, notice: this.notice,
      model: structuredClone(this.model), layout, selectedNoteIndex: layout.selectedNoteIndex,
      transcriptAt: layout.transcriptAt, transcriptIndex: layout.transcriptIndex };
  }
}
