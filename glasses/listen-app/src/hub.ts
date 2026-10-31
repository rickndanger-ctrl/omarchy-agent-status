import type { ListenSnapshot, Session, TranscriptLine } from './model';

export interface ChunkReply { ok: boolean; lines: TranscriptLine[] }
export interface InputReply { seq: number; inputs: { seq: number; input: string; at?: number }[] }
export interface ListenHubPort {
  start(signal?: AbortSignal): Promise<Session>;
  chunk(id: string, seq: number, pcm: Uint8Array, signal?: AbortSignal): Promise<ChunkReply>;
  stop(id: string, signal?: AbortSignal): Promise<void>;
  poll(id: string, since?: number, signal?: AbortSignal): Promise<ListenSnapshot>;
  waitInput(after: number, signal?: AbortSignal): Promise<InputReply>;
}
export interface HubOptions { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number; waitTimeoutMs?: number }
export class ListenHubError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = 'ListenHubError'; }
}
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const session = (x: unknown): x is Session => object(x) && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(x.id) && number(x.startedAt);
const line = (x: unknown): x is TranscriptLine => object(x) && number(x.t) && typeof x.text === 'string' && x.text.length <= 4000;

/** Immutable endpoint/token: a session never follows a later hub selection. */
export class ListenHub implements ListenHubPort {
  readonly url: string;
  private readonly o: HubOptions;
  constructor(options: HubOptions) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ListenHubError('Invalid hub address');
    this.url = url.origin + url.pathname.replace(/\/?$/, '/');
    this.o = { ...options };
  }
  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal, timeout?: number): Promise<unknown> {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new ListenHubError(timedOut ? 'Listen hub timed out' : 'Hub request cancelled'));
      ctl.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      if (ctl.signal.aborted) { void cancelled.catch(() => {}); throw new ListenHubError('Hub request cancelled'); }
      const operation = (async () => {
        const headers = new Headers(init.headers);
        if (this.o.token) headers.set('Authorization', `Bearer ${this.o.token}`);
        const response = await (this.o.fetch ?? fetch)(new URL(path, this.url), { ...init, headers, signal: ctl.signal, redirect: 'error' });
        if (!response.ok) throw new ListenHubError('Listen hub request failed', response.status);
        const text = await response.text();
        if (text.length > 2_000_000) throw new ListenHubError('Listen reply exceeded the size limit');
        try { return JSON.parse(text) as unknown; } catch { throw new ListenHubError('Invalid listen reply'); }
      })();
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; ctl.abort(); reject(new ListenHubError('Listen hub timed out')); }, timeout ?? this.o.timeoutMs ?? 12_000); });
      return await Promise.race([operation, deadline, cancelled]);
    } catch (error) {
      if (error instanceof ListenHubError) throw error;
      throw new ListenHubError(ctl.signal.aborted ? 'Hub request cancelled' : 'Listen hub unavailable');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (rejectAbort) ctl.signal.removeEventListener('abort', rejectAbort); }
  }
  async start(signal?: AbortSignal): Promise<Session> {
    const result = await this.request('api/listen/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: 'muse' }) }, signal);
    if (!session(result)) throw new ListenHubError('Invalid listen session');
    return { id: result.id, startedAt: result.startedAt };
  }
  async chunk(id: string, seq: number, pcm: Uint8Array, signal?: AbortSignal): Promise<ChunkReply> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Number.isSafeInteger(seq) || seq < 0 || !pcm.length || pcm.length % 2 || pcm.length > 320_000) throw new ListenHubError('Invalid PCM16 chunk');
    const result = await this.request(`api/listen/chunk?id=${encodeURIComponent(id)}&seq=${seq}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.slice().buffer as ArrayBuffer }, signal);
    if (!object(result) || result.ok !== true || !Array.isArray(result.lines) || result.lines.length > 2000 || !result.lines.every(line)) throw new ListenHubError('Invalid chunk receipt');
    return result as unknown as ChunkReply;
  }
  async stop(id: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request('api/listen/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }, signal);
    if (!object(result) || result.ok !== true) throw new ListenHubError('Stop was not confirmed');
  }
  async poll(id: string, since = 0, signal?: AbortSignal): Promise<ListenSnapshot> {
    const value = await this.request(`api/listen?id=${encodeURIComponent(id)}&since=${Math.max(0, since)}`, {}, signal);
    if (!session(value) || value.id !== id || !object(value) || !number(value.now_t) || !['listening', 'stopped'].includes(String(value.state))
      || !Array.isArray(value.lines) || value.lines.length > 2000 || !value.lines.every(line)
      || !Array.isArray(value.notes) || value.notes.length > 1000 || !value.notes.every(n => line(n) && object(n) && number(n.at_t) && n.text.length <= 300)
      || !object(value.muse) || !['idle', 'thinking', 'busy', 'unavailable'].includes(String(value.muse.state))) throw new ListenHubError('Invalid listen snapshot');
    return value as unknown as ListenSnapshot;
  }
  async waitInput(after: number, signal?: AbortSignal): Promise<InputReply> {
    const value = await this.request(`api/input/wait?after=${Math.max(0, after)}`, {}, signal, this.o.waitTimeoutMs ?? 30_000);
    if (!object(value) || !Number.isSafeInteger(value.seq) || !number(value.seq) || !Array.isArray(value.inputs) || value.inputs.length > 1000) throw new ListenHubError('Invalid remote reply');
    return { seq: value.seq, inputs: value.inputs.filter((i): i is InputReply['inputs'][number] => object(i) && Number.isSafeInteger(i.seq) && number(i.seq) && typeof i.input === 'string') };
  }
}
