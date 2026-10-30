// Glasses transport for Home. The startup, recovery, lifecycle and tap handling
// are taken from the Pie Gestures prototype, which was tested on Rick's G2
// (~/Documents/Codex/2026-10-24/even-g2-gesture-prototype). The motion sensor
// is left out; long press, the glasses menu and battery are added.
import {
  AudioInputSource,
  MAX_TEXT_BRIGHTNESS,
  MIN_TEXT_BRIGHTNESS,
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  ImuReportPace,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { TilesFrame } from './tiles';
import type { Input } from './model';
import { SettleWaiters, Serial, type SettleResult } from './settle';

export interface MenuItem { id: number; name: string }
export interface GlassesOptions {
  onInput: (input: Input) => void;
  onMenu: (id: number) => void;
  onStatus: (status: string) => void;
  onForeground: (foreground: boolean) => void;
  /** `raw` is what the Even app sent, for diagnostics. */
  onDevice: (device: { battery?: number; wearing?: boolean; raw: string }) => void;
  onAudio: (pcm: Uint8Array) => void;
  onSlowRender?: (ms: number) => void;
  onLifecycle?: (event: string) => void;
  /** How long one write to the Even app may take before it counts as failed (default 5000; tests shorten it). */
  renderTimeoutMs?: number;
  /** How long past its timeout a write may hang before it is forgotten (default 10000; tests shorten it). */
  hungWriteMs?: number;
  /** A render reached the glasses (what: rebuild, text, left or right). */
  onFrame?: (what: string) => void;
  /** The text of a full-screen frame that was actually drawn (the Even app took the write), not just asked for. */
  onDrawn?: (text: string) => void;
  /** A head-motion sample (only while imu(true) is on). */
  onImu?: (sample: { x: number; y: number; z: number }) => void;
  /** Head tracking was switched off by the transport (left the front, app exit, reconnect): the owner of the pointer must stop too. */
  onImuOff?: () => void;
  /** Where the Even app bridge comes from (tests pass a fake). Default: the SDK's waitForEvenAppBridge. */
  bridge?: () => Promise<EvenAppBridge>;
}

const CONTAINER_ID = 1;
const CONTAINER_NAME = 'home-main';
// Tiles mode: two text containers side by side, 288 px each (27 characters, 9 lines).
const TILE_IDS = { left: 2, right: 3 } as const;
const TILE_NAMES = { left: 'tile-left', right: 'tile-right' } as const;
export const OUTLINE_FULL = 15; // the lit tile's border: the brightest grey level
export const OUTLINE_MIN = 1;
export const DEFAULT_OUTLINE = 4; // faint but visible; the phone slider moves it
const TILE_W = 288;
/** What the glasses should show: one full-screen text block, or two tiles. `key` is page + focus: a change rebuilds the page. */
type Frame = { kind: 'single'; text: string } | { kind: 'tiles'; key: string; focus: TilesFrame['focus']; left: string; right: string };
// Each redraw is a Bluetooth write; too many in a row delays taps and swipes coming back.
const MIN_RENDER_INTERVAL_MS = 450;
/** After a failed update the glasses are tried again after this long, without waiting for a touch. */
const RENDER_RETRY_MS = 1500;
/** A write that has not settled this long after its timeout is given up on and the newest frame is sent again. */
const HUNG_WRITE_MS = 10_000;
const BRIDGE_TIMEOUT_MS = 15000;

function bounded<T>(promise: Promise<T>, stage: string, ms = BRIDGE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${stage} timed out after ${ms / 1000} seconds.`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Only characters the glasses' fixed font can draw. Emoji, symbols and other scripts from agent
 * replies can hang a text update, and while one is stuck, taps and swipes don't get through.
 */
export function glassesSafe(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\t/g, '  ')
    .replace(/[^\n\x20-\x7E\u00A0-\u00FF·•…›→←▲▼─│]/gu, '');
}

export class Glasses {
  private sdk: EvenAppBridge | null = null;
  private connected = false;
  private pageCreated = false;
  private connecting: Promise<boolean> | null = null;
  private epoch = 0;
  private foreground = true;
  private want: Frame = { kind: 'single', text: 'HOME\n\nConnecting…' };
  private shown: Frame | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderBusy = false;
  private renderBlocked = false;
  private heldWhy = '';
  private failedWant: Frame | null = null;
  /** SDK writes that have not settled (ids). A write that outlives its timeout stays here until it settles or the hard limit passes. */
  private live = new Set<number>();
  private writeSeq = 0;
  /** Writes given up on that have not settled yet: when one lands it may have overwritten the frame sent since. */
  private forgotten = new Set<number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderAt = -Infinity;
  private pressing = false;
  /** Taps before this time are dropped: the tap that brings Home back to the front isn't meant for Home. */
  private quietUntil = 0;
  private deviceTimer: ReturnType<typeof setInterval> | undefined;
  /** Text brightness 0..4 (SDK range). Unfocused tiles are one step dimmer. */
  private brightness = MAX_TEXT_BRIGHTNESS;
  /** The faint outline of an unlit tile (0..15 grey levels). The SDK offers no way to change a border without rebuilding the page. */
  private outline = DEFAULT_OUTLINE;
  private urgent = false;
  private settleWaiters = new SettleWaiters();
  /** Microphone on/off run one after another, so a stop can never overtake a start. */
  private micChain = new Serial();

  constructor(private readonly options: GlassesOptions, private readonly menu: MenuItem[]) {}

  get isConnected(): boolean { return this.connected; }

  /** Text brightness for every page from now on (1..4 in the app; the SDK range is 0..4). Rebuilds the page. */
  setBrightness(value: number): void {
    this.brightness = Math.min(MAX_TEXT_BRIGHTNESS, Math.max(MIN_TEXT_BRIGHTNESS, Math.round(value)));
    this.shown = null; // a brightness change needs the page rebuilt
    this.scheduleRender();
  }

  /** A write is in flight or waiting to go (a new frame would queue behind it). */
  busy(): boolean { return this.renderBusy || this.live.size > 0; }
  /** The glasses already show exactly what was last asked for. */
  upToDate(): boolean { return this.pending() === null; }

  /** Tile outline brightness (phone slider); the page is rebuilt to draw it. */
  setOutline(level: number): void {
    this.outline = Math.min(OUTLINE_FULL, Math.max(OUTLINE_MIN, Math.round(level)));
    this.shown = null;
    this.scheduleRender();
  }

  /** Close app: the glasses ask the owner to confirm (exit mode 1). */
  async shutDown(): Promise<boolean> {
    if (!this.sdk) return false;
    try { return await bounded(this.sdk.shutDownPageContainer(1), 'Close app'); } catch (error) { this.options.onStatus(`Close app failed: ${reason(error)}`); return false; }
  }

  /** Stops the battery timer (tests; the app never calls it). */
  dispose(): void { if (this.deviceTimer) clearInterval(this.deviceTimer); this.deviceTimer = undefined; clearTimeout(this.retryTimer); this.epoch++; }

  /** rendered: nothing pending, no render running. not-visible: nothing can reach the glasses now. null: still on its way. */
  private settleState(): SettleResult | null {
    if (!this.connected || !this.foreground || this.renderBlocked) return 'not-visible';
    return !this.renderBusy && this.live.size === 0 && this.renderTimer === undefined && this.pending() === null ? 'rendered' : null;
  }

  private notifySettled(): void { this.settleWaiters.notify(() => this.settleState()); }

  /** Resolves when the glasses show what was last set (capped, so a stuck render cannot hold input back for long). */
  settled(capMs = 1500): Promise<SettleResult> {
    return this.settleWaiters.wait(() => this.settleState(), capMs);
  }

  /** Head tracking on/off (100 ms reports). Returns whether the Even app took it. */
  async imu(open: boolean): Promise<boolean> {
    if (!open && !this.imuOn) return true;
    this.imuOn = open;
    try { return Boolean(await this.sdk?.imuControl(open, ImuReportPace.P100)); } catch (error) { this.options.onLifecycle?.(`imu ${open ? 'on' : 'off'} failed: ${reason(error)}`); return false; }
  }
  private imuOn = false;
  /** The transport lost the front or the app: tracking is off on the glasses side, whatever the owner thinks. */
  private imuStopped(): void {
    if (!this.imuOn) return;
    this.imuOn = false;
    void this.sdk?.imuControl(false, ImuReportPace.P100)?.catch?.(() => {});
    this.options.onImuOff?.();
  }

  connect(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    const epoch = ++this.epoch;
    this.forgetWrites();
    this.imuStopped();
    this.connecting = this.open(epoch).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** The text containers for a frame. Exactly one has isEventCapture; in tiles mode a focused tile gets a border so you can see where you are. */
  private containers(frame: Frame): TextContainerProperty[] {
    if (frame.kind === 'single') {
      return [new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, paddingLength: 4,
        containerID: CONTAINER_ID, containerName: CONTAINER_NAME, isEventCapture: 1, content: frame.text, textColor: this.brightness,
      })];
    }
    // Both tiles always have an outline, at the faint level (phone slider); the lit one is full brightness: thin while choosing, thick inside it.
    // At page level no tile is lit: the left one catches the gestures, and both outlines are faint.
    const owner = frame.focus.endsWith('right') ? 'right' : 'left';
    const lit = (side: 'left' | 'right') => frame.focus === side || frame.focus === `choose-${side}`;
    const border = (side: 'left' | 'right') => (frame.focus === side ? 2 : 1);
    return (['left', 'right'] as const).map(side => new TextContainerProperty({
      xPosition: side === 'left' ? 0 : TILE_W, yPosition: 0, width: TILE_W, height: 288,
      borderWidth: border(side), borderColor: lit(side) ? OUTLINE_FULL : this.outline, borderRadius: 4, paddingLength: 4,
      containerID: TILE_IDS[side], containerName: TILE_NAMES[side], isEventCapture: side === owner ? 1 : 0, content: frame[side],
      // Where you are is the bright one; the other tile is a step dimmer (at page level both are bright).
      textColor: frame.focus === 'page' || frame.focus.endsWith(side) ? this.brightness : Math.max(MIN_TEXT_BRIGHTNESS, this.brightness - 1),
    }));
  }

  private page(frame: Frame) {
    const textObject = this.containers(frame);
    const menuObject = new MenuContainerProperty({ menuItems: this.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.name })) });
    return { containerTotalNum: textObject.length, textObject, menuObject };
  }

  private async open(epoch: number): Promise<boolean> {
    let stage = 'Even app bridge';
    this.options.onStatus('Connecting to the Even app…');
    try {
      this.sdk = await bounded((this.options.bridge ?? waitForEvenAppBridge)(), stage);
      if (epoch !== this.epoch) return false;
      this.sdk.onEvenHubEvent(event => this.onEvent(event));
      this.sdk.onDeviceStatusChanged(status => this.options.onDevice({ battery: status.batteryLevel, wearing: status.isWearing, raw: JSON.stringify(status) }));
      // The status push may only come on a change, so also ask now and every minute (battery drains quietly).
      const ask = () => this.sdk?.getDeviceInfo().then(info => {
        // Documented as DeviceInfo { status: {...} }, but the Even app answers with the status itself.
        type Status = { batteryLevel?: number; isWearing?: boolean };
        const status = (info as unknown as (Status & { status?: Status }) | null)?.status ?? (info as unknown as Status | null);
        this.options.onDevice({ battery: status?.batteryLevel, wearing: status?.isWearing, raw: JSON.stringify(info) });
      }).catch(error => this.options.onDevice({ raw: `error: ${reason(error)}` }));
      void ask();
      if (!this.deviceTimer) this.deviceTimer = setInterval(() => void ask(), 60_000);
      stage = this.pageCreated ? 'Glasses display resume' : 'Glasses display startup';
      const displayed = this.want;
      if (this.pageCreated) {
        const result = await bounded(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(displayed))), stage);
        if (!result) throw new Error('The Even app returned false for rebuilding the page.');
      } else {
        const result = await bounded(this.sdk.createStartUpPageContainer(new CreateStartUpPageContainer(this.page(displayed))), stage);
        // The official SDK success value is numeric zero, not a truthy flag.
        if (result === StartUpPageCreateResult.invalid) {
          // A developer reload can leave the native host owning a page: rebuild once.
          stage = 'Glasses display recovery';
          const rebuilt = await bounded(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(displayed))), stage);
          if (!rebuilt) throw new Error('Startup returned code 1 (invalid), and the recovery rebuild returned false.');
        } else if (result !== StartUpPageCreateResult.success) {
          throw new Error(`The Even app returned code ${result} (${StartUpPageCreateResult[result] ?? 'unknown'}).`);
        }
      }
      if (epoch !== this.epoch) return false;
      this.pageCreated = true;
      this.connected = true;
      this.renderBlocked = false;
      this.shown = displayed;
      this.options.onStatus('G2 OMAC is showing on your glasses.');
      this.scheduleRender();
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        this.connected = false;
        this.options.onStatus(`${stage} failed: ${reason(error)}`);
      }
      return false;
    }
  }

  /** The phone's location, for the weather (null if not allowed or not available). */
  async location(): Promise<{ lat: number; lon: number } | null> {
    if (!this.sdk) return null;
    try {
      const at = await bounded(this.sdk.getAppLocation({ timeoutMs: 10_000 }), 'Location', 12_000);
      return at ? { lat: at.latitude, lon: at.longitude } : null;
    } catch {
      return null;
    }
  }

  /** Glasses microphone on/off. Audio arrives through onAudio as 16 kHz s16le mono PCM. */
  microphone(on: boolean): Promise<boolean> {
    return this.micChain.run(() => this.setMicrophone(on));
  }

  // Known limit: the SDK's audioControl call cannot be cancelled. If one times out (bounded() below), the SDK may still
  // finish it later, after a newer on/off we have already sent. Serial keeps OUR calls in order; it cannot order the SDK's.
  private async setMicrophone(on: boolean): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      return await bounded(on ? this.sdk.audioControl(true, AudioInputSource.Glasses) : this.sdk.audioControl(false), 'Microphone');
    } catch (error) {
      this.options.onStatus(`Microphone failed: ${reason(error)}`);
      return false;
    }
  }

  setText(content: string, urgent = false): void {
    this.want = { kind: 'single', text: glassesSafe(content).slice(0, 950) || ' ' };
    if (urgent) this.urgent = true; // the next write skips the 450 ms pacing (an answer the owner is waiting for)
    this.unblockFor(this.want);
    this.scheduleRender();
  }

  /** Tiles mode. `layoutKey` names the page; changing it or the focus rebuilds the page, a text change only updates that tile. */
  setTiles(layoutKey: string, focus: TilesFrame['focus'], left: string, right: string): void {
    this.want = { kind: 'tiles', key: `${layoutKey}/${focus}`, focus, left: glassesSafe(left).slice(0, 400) || ' ', right: glassesSafe(right).slice(0, 400) || ' ' };
    this.unblockFor(this.want);
    this.scheduleRender();
  }

  /** A new frame may try at once after a failure; the same one that just failed waits for the retry timer (no 450 ms hammering). */
  private unblockFor(want: Frame): void {
    if (this.renderBlocked && this.failedWant && JSON.stringify(this.failedWant) === JSON.stringify(want)) return;
    this.renderBlocked = false;
  }

  /**
   * One write to the Even app. A write that outlives its timeout is not cancelled by the SDK and can still land later, so
   * nothing else is sent while it is in flight; when it settles the glasses may show anything, so the newest wanted frame is sent again.
   */
  private write<T>(promise: Promise<T>, stage: string): Promise<T> {
    const id = ++this.writeSeq;
    this.live.add(id);
    let timedOut = false;
    void promise.then(() => undefined, () => undefined).then(() => {
      if (!this.live.delete(id)) {
        // Given up on earlier (hung, or a reconnect): it may have landed over the frame sent since, so send the newest once more.
        if (this.forgotten.delete(id)) { this.shown = null; this.options.onLifecycle?.('frame held: late write, resent'); this.scheduleRender(); }
        return;
      }
      if (timedOut) { this.shown = null; this.scheduleRender(); }
    });
    return bounded(promise, stage, this.options.renderTimeoutMs ?? 5000).catch(error => {
      timedOut = true;
      // Past the hard limit a write that never settles is forgotten, so the glasses are not frozen for good.
      setTimeout(() => {
        if (!this.live.delete(id)) return;
        this.forgotten.add(id);
        this.shown = null;
        this.options.onLifecycle?.('frame held: write hung, resent');
        this.scheduleRender();
      }, this.options.hungWriteMs ?? HUNG_WRITE_MS);
      throw error;
    });
  }

  /** Reconnecting or closing: nothing written before can be waited for any more. */
  private forgetWrites(): void { for (const id of this.live) this.forgotten.add(id); this.live.clear(); }

  /** What still has to reach the glasses: a rebuild, one tile's text, or nothing. */
  private pending(): 'rebuild' | 'left' | 'right' | 'text' | null {
    const want = this.want;
    const shown = this.shown;
    if (!shown || shown.kind !== want.kind) return 'rebuild';
    if (want.kind === 'single') return shown.kind === 'single' && shown.text !== want.text ? 'text' : null;
    if (shown.kind !== 'tiles') return 'rebuild';
    if (shown.key !== want.key) return 'rebuild';
    return shown.left !== want.left ? 'left' : shown.right !== want.right ? 'right' : null;
  }

  private onEvent(event: EvenHubEvent): void {
    const system = event.sysEvent;
    if (system?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
      const d = system.imuData;
      if (d && this.imuOn) this.options.onImu?.({ x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? 0 });
      return;
    }
    if (system?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.imuStopped();
      this.options.onLifecycle?.('foreground-exit');
      this.foreground = false;
      this.pressing = false;
      this.options.onForeground(false);
      this.notifySettled();
      return;
    }
    if (system?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.options.onLifecycle?.('foreground-enter');
      this.foreground = true;
      this.pressing = false;
      this.quietUntil = Date.now() + 1000;
      this.renderBlocked = false;
      this.options.onForeground(true);
      this.scheduleRender();
      return;
    }
    if (system?.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT || system?.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      this.options.onLifecycle?.(`exit ${system.eventType}`);
      this.pressing = false;
      this.imuStopped();
      ++this.epoch;
      this.forgetWrites();
      this.connected = false;
      this.pageCreated = false;
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.options.onForeground(false);
      this.options.onStatus('The glasses app was closed. Open G2 OMAC again from the glasses menu.');
      this.notifySettled();
      return;
    }
    if (event.audioEvent) {
      const raw = event.audioEvent.audioPcm as unknown;
      // The host may deliver bytes, a number array, or base64.
      const pcm = raw instanceof Uint8Array ? raw
        : Array.isArray(raw) ? Uint8Array.from(raw as number[])
        : typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
        : null;
      if (pcm?.length) this.options.onAudio(pcm);
      return;
    }
    // A tap, swipe or menu choice proves Home is in front, whatever lifecycle events said before.
    // (The long-press menu sends "left the foreground" and sometimes never "came back".)
    const isInput = Boolean(event.menuItemClickEvent?.itemID || event.textEvent || event.listEvent || (event.sysEvent && !system?.imuData));
    if (isInput && !this.foreground) {
      this.foreground = true;
      this.renderBlocked = false;
      this.options.onLifecycle?.('foreground-assumed');
      this.pressing = false;
      this.options.onForeground(true);
      this.scheduleRender();
      // That tap is what brought Home back (closing the glasses menu, waking the display): don't act on it.
      this.quietUntil = Date.now() + 1000;
    }
    if (event.menuItemClickEvent?.itemID) {
      this.options.onMenu(event.menuItemClickEvent.itemID);
      return;
    }
    if (system?.imuData) return;
    // Official minimal template: taps normally arrive as sysEvent, scrolling as textEvent.
    // Only default to a click inside an actual envelope; empty or audio events aren't taps.
    const types = [event.sysEvent, event.textEvent, event.listEvent]
      .filter(envelope => envelope !== undefined && envelope !== null)
      .map(envelope => envelope!.eventType ?? OsEventTypeList.CLICK_EVENT);
    // Press and release are tracked before any other check: a release swallowed by the quiet window or
    // while Home was behind the glasses menu left `pressing` stuck and every later tap was dropped.
    if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) { this.pressing = true; return; }
    if (types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) { this.pressing = false; return; }
    if (!this.connected || !this.foreground) return;
    if (Date.now() < this.quietUntil) { this.options.onLifecycle?.('input-ignored (just came to front)'); return; }
    if (this.pressing) { this.options.onLifecycle?.('input-ignored (long press held)'); return; }
    if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) this.options.onInput('back');
    else if (types.includes(OsEventTypeList.CLICK_EVENT)) this.options.onInput('select');
    else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) this.options.onInput('up');
    else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) this.options.onInput('down');
  }

  private scheduleRender(): void {
    this.notifySettled(); // nothing pending, or no way to render: whoever waits can go on
    // A frame is wanted but cannot be sent: say why once, so the logs show a frame that is waiting rather than lost.
    const why = !this.connected ? 'not connected' : !this.foreground ? 'not in front' : this.renderBlocked ? 'last update failed' : '';
    if (why && this.pending() !== null && why !== this.heldWhy) this.options.onLifecycle?.(`frame held: ${why}`);
    this.heldWhy = why;
    if (!this.connected || !this.foreground || this.renderBlocked || this.renderBusy || this.live.size > 0 || this.renderTimer !== undefined || this.pending() === null) return;
    const wait = this.urgent ? 0 : Math.max(0, MIN_RENDER_INTERVAL_MS - (performance.now() - this.lastRenderAt));
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; void this.flushRender(); }, wait);
  }

  /** Every way out of a render attempt tells the settle waiters (an early return can be the settled state). */
  private async flushRender(): Promise<void> {
    try { await this.renderOnce(); } finally { this.notifySettled(); }
  }

  private async renderOnce(): Promise<void> {
    if (!this.sdk || !this.connected || !this.foreground || this.renderBusy) return;
    const todo = this.pending();
    if (todo === null) return;
    const want = this.want;
    const epoch = this.epoch;
    this.renderBusy = true;
    this.urgent = false;
    this.lastRenderAt = performance.now();
    try {
      let accepted: boolean;
      if (todo === 'rebuild') {
        accepted = await this.write(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(want))), 'Glasses page update');
      } else if (want.kind === 'single') {
        accepted = await this.write(this.sdk.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER_ID, containerName: CONTAINER_NAME, content: want.text,
        })), 'Glasses text update');
      } else {
        const side = todo as 'left' | 'right';
        accepted = await this.write(this.sdk.textContainerUpgrade(new TextContainerUpgrade({
          containerID: TILE_IDS[side], containerName: TILE_NAMES[side], content: want[side],
        })), 'Glasses text update');
      }
      if (epoch !== this.epoch) return;
      const took = performance.now() - this.lastRenderAt;
      if (took > 2000) this.options.onSlowRender?.(Math.round(took));
      if (!accepted) throw new Error('The Even app returned false for the text update.');
      this.options.onFrame?.(todo);
      if (want.kind === 'single') this.options.onDrawn?.(want.text);
      if (todo === 'rebuild' || want.kind === 'single') this.shown = want;
      else if (this.shown?.kind === 'tiles') this.shown = { ...this.shown, [todo]: want[todo as 'left' | 'right'] };
    } catch (error) {
      if (epoch === this.epoch) {
        this.renderBlocked = true;
        this.failedWant = want;
        this.options.onStatus(`Glasses text update failed: ${reason(error)}`);
        // Nothing may be left waiting for a touch: try again by itself (a newer setText also unblocks it at once).
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (epoch === this.epoch) { this.renderBlocked = false; this.failedWant = null; this.scheduleRender(); } }, RENDER_RETRY_MS);
      }
    } finally {
      this.renderBusy = false;
      this.scheduleRender();
    }
  }
}
