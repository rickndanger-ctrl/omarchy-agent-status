import type { Action } from './model';
import type { Latest } from './latest';

interface AgentModel {
  agentHoldToken(): unknown | null;
  agentTranscriptToken(): unknown | null;
  abandonTalk(): void;
  setTranscript(text: string | null, now: number, token?: unknown): void;
}
export interface AgentVoiceHost {
  model: AgentModel;
  latest: Latest;
  recording(): Uint8Array[] | null;
  setRecording(value: Uint8Array[] | null): void;
  microphone(on: boolean): Promise<boolean>;
  transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string>;
  now(): number;
  diag(name: string, detail: string): void;
  changed(): void;
  failed(): void;
}

/** Agent attempts only. A null result leaves the original Muse runtime in charge. */
export class AgentVoice {
  private current: { id: number; chunks: Uint8Array[]; abort: AbortController } | null = null;
  constructor(private readonly host: AgentVoiceHost) {}

  abandon(): Promise<void> | null { this.host.model.abandonTalk(); return this.run({ kind: 'cancelMic' }); }

  run(action: Action): Promise<void> | null {
    if (action.kind === 'startMic') {
      const token = this.host.model.agentHoldToken();
      if (token == null) { this.retire(); return null; }
      this.retire();
      const attempt = { id: this.host.latest.next(), chunks: [] as Uint8Array[], abort: new AbortController() };
      this.current = attempt;
      this.host.setRecording(attempt.chunks);
      return (async () => {
        let on = false;
        try { on = await this.host.microphone(true); } catch { /* Fail closed for this agent attempt. */ }
        this.host.diag('mic.start', String(on));
        const active = this.current;
        if (!on && active && active.abort === attempt.abort && this.owns(active)) {
          if (this.host.recording() === active.chunks) this.host.setRecording(null);
          this.retire();
          this.host.model.abandonTalk();
          this.host.failed(); this.host.changed();
        }
      })();
    }
    if (action.kind === 'cancelMic' && this.current) {
      const attempt = this.current;
      // This decision is made before any await. An old agent cancellation
      // cannot fall through to the generic handler for a newer Muse buffer.
      if (!this.owns(attempt)) { this.retire(); return Promise.resolve(); }
      this.host.latest.invalidate();
      if (this.host.recording() === attempt.chunks) this.host.setRecording(null);
      this.retire();
      this.host.diag('mic.cancel', 'agent attempt');
      return this.host.microphone(false).then(() => {}, () => {});
    }
    if (action.kind !== 'stopMic') return null;
    const token = this.host.model.agentTranscriptToken();
    if (token == null) {
      if (!this.current) return null;
      this.retire(); return Promise.resolve();
    }
    const previous = this.current;
    if (!previous || !this.owns(previous)) {
      this.retire(); this.host.model.abandonTalk(); return Promise.resolve();
    }
    const attempt = { ...previous, id: this.host.latest.next() };
    this.current = attempt;
    // Freeze and detach the owned buffer BEFORE microphone(false) can wait
    // beyond the queue cap and allow another recording to start.
    const chunks = attempt.chunks.slice();
    if (this.host.recording() === attempt.chunks) this.host.setRecording(null);
    return (async () => {
      try {
        const off = await this.host.microphone(false);
        if (!this.owns(attempt) || this.host.model.agentTranscriptToken() !== token) return;
        if (!off) throw new Error('agent microphone stop failed');
        const audio = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
        let at = 0;
        for (const chunk of chunks) { audio.set(chunk, at); at += chunk.length; }
        this.host.diag('mic.stop', `${chunks.length} chunks, ${audio.length} bytes`);
        const text = await this.host.transcribe(audio, attempt.abort.signal);
        if (this.owns(attempt) && this.host.model.agentTranscriptToken() === token) {
          this.host.diag('voice.text', `${text.length} characters`);
          this.host.model.setTranscript(text, this.host.now(), token);
        }
      } catch {
        if (this.owns(attempt) && this.host.model.agentTranscriptToken() === token) {
          this.host.model.setTranscript(null, this.host.now(), token);
          this.host.diag('voice.error', 'agent transcription failed');
          this.host.failed();
        }
      } finally {
        if (this.current === attempt) this.retire();
        this.host.changed();
      }
    })();
  }

  private owns(attempt: NonNullable<AgentVoice['current']>): boolean {
    return this.current === attempt && this.host.latest.isLatest(attempt.id);
  }

  private retire(): void { this.current?.abort.abort(); this.current = null; }
}

interface ConfirmExpiryHost {
  deadline(): number | null;
  expire(now: number): boolean;
  now(): number;
  enqueue(run: () => void): void;
  changed(): void;
}

/** The real scheduled confirmation deadline; the queue owns applying expiry. */
export class AgentConfirmExpiry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduled: number | null = null;
  constructor(private readonly host: ConfirmExpiryHost,
    private readonly setTimer = setTimeout, private readonly clearTimer = clearTimeout) {}
  sync(): void {
    const deadline = this.host.deadline();
    if (deadline === this.scheduled) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.scheduled = deadline;
    if (deadline === null) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.host.enqueue(() => {
        if (this.scheduled === deadline) this.scheduled = null;
        if (this.host.deadline() === deadline) this.host.expire(this.host.now());
        this.host.changed();
      });
    }, Math.max(0, deadline - this.host.now()));
  }
}
