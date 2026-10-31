import {
  AudioInputSource, CreateStartUpPageContainer, EventSourceType, OsEventTypeList, RebuildPageContainer,
  StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade,
  utf8ByteLength, waitForEvenAppBridge, type EvenAppBridge, type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { InputName } from './input';

export interface TextFrame { left: string; right: string }
export type FrameKind = 'startup' | 'rebuild' | 'left' | 'right';
export interface GlassesOptions {
  bridge?: () => Promise<EvenAppBridge>;
  onInput(input: InputName): void;
  onAudio(pcm: Uint8Array): void;
  onLifecycle(event: 'foreground' | 'background' | 'exit'): void;
  onStatus(text: string): void;
  diag?(name: string): void;
  onFrame?(kind: FrameKind): void;
  now?: () => number;
  operationTimeoutMs?: number;
}

export const RENDER_INTERVAL_MS = 450;
export const TEXT_SAFE_MAX = 950;
const SIDES = ['left', 'right'] as const;
const IDS = { left: 1, right: 2 };
const NAMES = { left: 'listen-transcript', right: 'listen-notes' };

/** UTF-16 and UTF-8 budgets both matter to the SDK. Never split a grapheme. */
export function safeText(input: string): string {
  // The phone/model retains full Unicode history. Only the glasses' known fixed
  // font subset reaches the SDK; unsupported emoji/scripts can stall a write.
  const clean = input.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\n\x20-\x7e\u00a0-\u00ff·•…›→←▲▼─│●○]/gu, '');
  const segments: Iterable<string> = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean), part => part.segment)
    : Array.from(clean);
  let text = '', bytes = 0;
  for (const part of segments) {
    // Drop lone UTF-16 surrogates, which would otherwise become replacement bytes.
    if (part.length === 1 && /[\ud800-\udfff]/.test(part)) continue;
    const size = utf8ByteLength(part);
    if (text.length + part.length > TEXT_SAFE_MAX || bytes + size > TEXT_SAFE_MAX) break;
    text += part; bytes += size;
  }
  return text || ' ';
}

/** Serialized two-box writes. A slow SDK promise remains a serialization fence,
 * even after reporting its deadline: a late old write cannot race a newer one.
 */
export class ListenGlasses {
  private sdk: EvenAppBridge | null = null;
  private connected = false;
  private foreground = true;
  private disposed = false;
  private opening: Promise<boolean> | null = null;
  private want = { left: 'MUSE LISTEN\nReady - mic off', right: 'MUSE\nNo notes yet', key: 'idle' };
  private shown: typeof this.want | null = null;
  private busy = false;
  private lastWrite = -Infinity;
  private lastSide: 'left' | 'right' = 'right';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlines = new Set<ReturnType<typeof setTimeout>>();
  private unsubscribers: (() => void)[] = [];
  private epoch = 0;
  private rebuildSequence = 0;
  private rebuildDone = 0;
  private micTail: Promise<boolean> = Promise.resolve(true);
  private waiters = new Set<() => void>();
  constructor(private readonly o: GlassesOptions) {}
  get isConnected(): boolean { return this.connected; }
  private now(): number { return (this.o.now ?? (() => performance.now()))(); }
  private page(frame: TextFrame) {
    return { containerTotalNum: 2, textObject: SIDES.map(side => new TextContainerProperty({
      containerID: IDS[side], containerName: NAMES[side],
      xPosition: side === 'left' ? 0 : 288, yPosition: 0, width: 288, height: 288,
      borderWidth: 1, borderColor: 4, borderRadius: 3, paddingLength: 4, textColor: 4,
      isEventCapture: side === 'left' ? 1 : 0, content: frame[side],
    })) };
  }
  setFrame(frame: TextFrame, boundaryKey: string): void {
    if (this.disposed) return;
    if (this.want.key !== boundaryKey) this.rebuildSequence++;
    this.want = { left: safeText(frame.left), right: safeText(frame.right), key: boundaryKey };
    this.schedule();
  }
  private pending(): 'rebuild' | 'left' | 'right' | null {
    if (!this.shown || this.rebuildDone < this.rebuildSequence || this.shown.key !== this.want.key) return 'rebuild';
    const left = this.shown.left !== this.want.left, right = this.shown.right !== this.want.right;
    if (left && right) return this.lastSide === 'left' ? 'right' : 'left';
    return left ? 'left' : right ? 'right' : null;
  }
  private changed(): void { for (const notify of [...this.waiters]) notify(); }
  private schedule(): void {
    this.changed();
    if (this.disposed || !this.connected || !this.foreground || this.busy || this.timer !== undefined || !this.pending()) return;
    const delay = Math.max(0, RENDER_INTERVAL_MS - (this.now() - this.lastWrite));
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }
  private async operation<T>(job: Promise<T>, kind: FrameKind): Promise<T> {
    const timer = setTimeout(() => {
      this.deadlines.delete(timer);
      if (!this.disposed) { this.o.diag?.('listen.frame.deadline'); this.o.onStatus('Glasses frame delayed; waiting for the SDK.'); }
    }, this.o.operationTimeoutMs ?? 5000);
    this.deadlines.add(timer);
    try { return await job; }
    finally { clearTimeout(timer); this.deadlines.delete(timer); void kind; }
  }
  connect(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.connected) return Promise.resolve(true);
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => { this.opening = null; });
    return this.opening;
  }
  private async open(): Promise<boolean> {
    const epoch = ++this.epoch;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.o.onStatus('Connecting Muse Listen display…');
    try {
      const sdk = await (this.o.bridge ?? waitForEvenAppBridge)();
      if (this.disposed || epoch !== this.epoch) return false;
      this.sdk = sdk;
      const unsubscribe = sdk.onEvenHubEvent(event => { if (epoch === this.epoch && sdk === this.sdk) this.event(event); });
      if (typeof unsubscribe === 'function') this.unsubscribers.push(unsubscribe);
      const frame = { ...this.want }, revision = this.rebuildSequence;
      const pause = Math.max(0, RENDER_INTERVAL_MS - (this.now() - this.lastWrite));
      if (pause) await new Promise(resolve => setTimeout(resolve, pause));
      if (this.disposed || epoch !== this.epoch) return false;
      this.busy = true; this.lastWrite = this.now();
      const result = await this.operation(sdk.createStartUpPageContainer(new CreateStartUpPageContainer(this.page(frame))), 'startup');
      if (this.disposed || epoch !== this.epoch) return false;
      if (result === StartUpPageCreateResult.invalid) {
        // Reload recovery still observes the same 450ms write-start throttle.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, RENDER_INTERVAL_MS - (this.now() - this.lastWrite))));
        if (this.disposed || epoch !== this.epoch) return false;
        this.lastWrite = this.now();
        if (!await this.operation(sdk.rebuildPageContainer(new RebuildPageContainer(this.page(frame))), 'rebuild')) throw new Error('refused');
      } else if (result !== StartUpPageCreateResult.success) throw new Error('refused');
      if (this.disposed || epoch !== this.epoch) return false;
      this.shown = frame; this.rebuildDone = revision; this.connected = true; this.o.onFrame?.('startup');
      this.o.onStatus('Muse Listen display ready. Microphone is off until Start.');
      return true;
    } catch {
      if (!this.disposed) {
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.connected = false; ++this.epoch;
        this.o.diag?.('listen.frame.failed'); this.o.onStatus('Muse Listen display could not start.');
      }
      return false;
    } finally { this.busy = false; this.schedule(); }
  }
  private async flush(): Promise<void> {
    if (!this.connected || !this.sdk || this.disposed || !this.foreground || this.busy) return;
    const kind = this.pending();
    if (!kind) return;
    const frame = { ...this.want }, epoch = this.epoch, revision = this.rebuildSequence;
    this.busy = true; this.lastWrite = this.now();
    try {
      const accepted = kind === 'rebuild'
        ? await this.operation(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(frame))), kind)
        : await this.operation(this.sdk.textContainerUpgrade(new TextContainerUpgrade({
          containerID: IDS[kind], containerName: NAMES[kind], content: frame[kind],
        })), kind);
      if (this.disposed || epoch !== this.epoch) return;
      if (!accepted) throw new Error('refused');
      if (kind === 'rebuild') { this.shown = frame; this.rebuildDone = revision; }
      else if (this.shown) { this.shown = { ...this.shown, [kind]: frame[kind] }; this.lastSide = kind; }
      this.o.onFrame?.(kind);
    } catch {
      if (!this.disposed && epoch === this.epoch) {
        this.o.diag?.('listen.frame.failed'); this.o.onStatus('Glasses frame failed; retrying the latest view.');
      }
    } finally { this.busy = false; this.schedule(); }
  }
  /** Serialized across late completions; session owner supplies mic deadlines. */
  microphone(on: boolean): Promise<boolean> {
    const run = async () => {
      if (!this.sdk || on && (!this.connected || this.disposed)) return false;
      try { return await (on ? this.sdk.audioControl(true, AudioInputSource.Glasses) : this.sdk.audioControl(false)); }
      catch { this.o.diag?.('listen.mic-control-failed'); return false; }
    };
    this.micTail = this.micTail.then(run, run);
    return this.micTail;
  }
  private event(event: EvenHubEvent): void {
    if (this.disposed) return;
    const type = event.sysEvent?.eventType;
    if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.foreground = false; this.o.onLifecycle('background'); this.changed(); return;
    }
    if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.foreground = true; this.shown = null; this.o.onLifecycle('foreground'); this.schedule(); return;
    }
    if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      this.connected = false; this.foreground = false; ++this.epoch;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      clearTimeout(this.timer); this.timer = undefined; this.o.onLifecycle('exit'); this.changed(); return;
    }
    if (event.audioEvent) {
      const raw: unknown = event.audioEvent.audioPcm;
      try {
        const pcm = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw)
          : typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0)) : null;
        if (pcm?.length) this.o.onAudio(pcm);
      } catch { this.o.diag?.('listen.audio-event-invalid'); }
      return;
    }
    if (!this.connected || !this.foreground || event.sysEvent?.imuData) return;
    const types = [event.sysEvent, event.textEvent, event.listEvent]
      .filter(value => value !== undefined && value !== null)
      .map(value => value!.eventType).filter(value => value !== undefined);
    // Native simulator evidence: a temple click omits protobuf enum zero and
    // carries only eventSource. Accept that exact source-bearing shape; empty
    // envelopes, unknown sources and telemetry must never opt into recording.
    const system = event.sysEvent;
    const clickSource = system?.eventSource;
    if (system && system.eventType === undefined && !event.textEvent && !event.listEvent && !event.menuItemClickEvent
        && [EventSourceType.TOUCH_EVENT_FROM_GLASSES_R, EventSourceType.TOUCH_EVENT_FROM_GLASSES_L, EventSourceType.TOUCH_EVENT_FROM_RING].includes(clickSource as EventSourceType)
        && system.imuData === undefined && system.systemExitReasonCode === undefined
        && Object.entries(system).every(([key, value]) => ['eventType', 'eventSource'].includes(key) || value === undefined)) {
      types.push(OsEventTypeList.CLICK_EVENT);
    }
    if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) this.o.onInput('back');
    else if (types.includes(OsEventTypeList.CLICK_EVENT)) this.o.onInput('select');
    else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) this.o.onInput('up');
    else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) this.o.onInput('down');
  }
  settled(timeoutMs = 2500): Promise<'rendered' | 'pending' | 'not-visible'> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: 'rendered' | 'pending' | 'not-visible') => { clearTimeout(timer); this.waiters.delete(check); resolve(value); };
      const check = () => {
        if (this.disposed || !this.connected || !this.foreground) finish('not-visible');
        else if (!this.busy && !this.pending()) finish('rendered');
      };
      this.waiters.add(check); timer = setTimeout(() => finish('pending'), timeoutMs); check();
    });
  }
  dispose(): void {
    this.disposed = true; this.connected = false; ++this.epoch;
    clearTimeout(this.timer); this.timer = undefined;
    for (const timer of this.deadlines) clearTimeout(timer);
    this.deadlines.clear();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.changed();
  }
}
