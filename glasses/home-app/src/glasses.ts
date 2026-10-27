// Glasses transport for Home. The startup, recovery, lifecycle and tap handling
// are taken from the Pie Gestures prototype, which was tested on Rick's G2
// (~/Documents/Codex/2026-10-24/even-g2-gesture-prototype). The motion sensor
// is left out; long press, the glasses menu and battery are added.
import {
  AudioInputSource,
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { Input } from './model';

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
}

const CONTAINER_ID = 1;
const CONTAINER_NAME = 'home-main';
// Each redraw is a Bluetooth write; too many in a row delays taps and swipes coming back.
const MIN_RENDER_INTERVAL_MS = 450;
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
  private content = 'HOME\n\nConnecting…';
  private sentContent = '';
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderBusy = false;
  private renderBlocked = false;
  private lastRenderAt = -Infinity;
  private pressing = false;
  private deviceTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: GlassesOptions, private readonly menu: MenuItem[]) {}

  get isConnected(): boolean { return this.connected; }

  connect(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    const epoch = ++this.epoch;
    this.connecting = this.open(epoch).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private page(text: TextContainerProperty) {
    const menuObject = new MenuContainerProperty({ menuItems: this.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.name })) });
    return { containerTotalNum: 1, textObject: [text], menuObject };
  }

  private async open(epoch: number): Promise<boolean> {
    let stage = 'Even app bridge';
    this.options.onStatus('Connecting to the Even app…');
    try {
      this.sdk = await bounded(waitForEvenAppBridge(), stage);
      if (epoch !== this.epoch) return false;
      this.sdk.onEvenHubEvent(event => this.onEvent(event));
      this.sdk.onDeviceStatusChanged(status => this.options.onDevice({ battery: status.batteryLevel, wearing: status.isWearing, raw: JSON.stringify(status) }));
      // The status push may only come on a change, so also ask now and every minute (battery drains quietly).
      const ask = () => this.sdk?.getDeviceInfo().then(info => {
        const status = (info as unknown as { status?: { batteryLevel?: number; isWearing?: boolean } } | null)?.status;
        this.options.onDevice({ battery: status?.batteryLevel, wearing: status?.isWearing, raw: JSON.stringify(info) });
      }).catch(error => this.options.onDevice({ raw: `error: ${reason(error)}` }));
      void ask();
      if (!this.deviceTimer) this.deviceTimer = setInterval(() => void ask(), 60_000);
      stage = this.pageCreated ? 'Glasses display resume' : 'Glasses display startup';
      const displayed = this.content;
      const text = new TextContainerProperty({
        xPosition: 0, yPosition: 0, width: 576, height: 288,
        borderWidth: 0, paddingLength: 4,
        containerID: CONTAINER_ID, containerName: CONTAINER_NAME,
        isEventCapture: 1, content: displayed,
      });
      if (this.pageCreated) {
        const result = await bounded(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(text))), stage);
        if (!result) throw new Error('The Even app returned false for rebuilding the page.');
      } else {
        const result = await bounded(this.sdk.createStartUpPageContainer(new CreateStartUpPageContainer(this.page(text))), stage);
        // The official SDK success value is numeric zero, not a truthy flag.
        if (result === StartUpPageCreateResult.invalid) {
          // A developer reload can leave the native host owning a page: rebuild once.
          stage = 'Glasses display recovery';
          const rebuilt = await bounded(this.sdk.rebuildPageContainer(new RebuildPageContainer(this.page(text))), stage);
          if (!rebuilt) throw new Error('Startup returned code 1 (invalid), and the recovery rebuild returned false.');
        } else if (result !== StartUpPageCreateResult.success) {
          throw new Error(`The Even app returned code ${result} (${StartUpPageCreateResult[result] ?? 'unknown'}).`);
        }
      }
      if (epoch !== this.epoch) return false;
      this.pageCreated = true;
      this.connected = true;
      this.renderBlocked = false;
      this.sentContent = displayed;
      this.options.onStatus('Home is showing on your glasses.');
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
  async microphone(on: boolean): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      return await bounded(on ? this.sdk.audioControl(true, AudioInputSource.Glasses) : this.sdk.audioControl(false), 'Microphone');
    } catch (error) {
      this.options.onStatus(`Microphone failed: ${reason(error)}`);
      return false;
    }
  }

  setText(content: string): void {
    this.content = glassesSafe(content).slice(0, 950) || ' ';
    this.renderBlocked = false;
    this.scheduleRender();
  }

  private onEvent(event: EvenHubEvent): void {
    const system = event.sysEvent;
    if (system?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.options.onLifecycle?.('foreground-exit');
      this.foreground = false;
      this.options.onForeground(false);
      return;
    }
    if (system?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.options.onLifecycle?.('foreground-enter');
      this.foreground = true;
      this.renderBlocked = false;
      this.options.onForeground(true);
      this.scheduleRender();
      return;
    }
    if (system?.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT || system?.eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      this.options.onLifecycle?.(`exit ${system.eventType}`);
      ++this.epoch;
      this.connected = false;
      this.pageCreated = false;
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.options.onForeground(false);
      this.options.onStatus('The glasses app was closed. Open Home again from the glasses menu.');
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
      this.options.onForeground(true);
      this.scheduleRender();
    }
    if (event.menuItemClickEvent?.itemID) {
      this.options.onMenu(event.menuItemClickEvent.itemID);
      return;
    }
    if (!this.connected || !this.foreground || system?.imuData) return;
    // Official minimal template: taps normally arrive as sysEvent, scrolling as textEvent.
    // Only default to a click inside an actual envelope; empty or audio events aren't taps.
    const types = [event.sysEvent, event.textEvent, event.listEvent]
      .filter(envelope => envelope !== undefined && envelope !== null)
      .map(envelope => envelope!.eventType ?? OsEventTypeList.CLICK_EVENT);
    if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) { this.pressing = true; return; }
    if (types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) { this.pressing = false; return; }
    if (this.pressing) return;
    if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) this.options.onInput('back');
    else if (types.includes(OsEventTypeList.CLICK_EVENT)) this.options.onInput('select');
    else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) this.options.onInput('up');
    else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) this.options.onInput('down');
  }

  private scheduleRender(): void {
    if (!this.connected || !this.foreground || this.renderBlocked || this.renderBusy || this.renderTimer !== undefined || this.content === this.sentContent) return;
    const wait = Math.max(0, MIN_RENDER_INTERVAL_MS - (performance.now() - this.lastRenderAt));
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; void this.flushRender(); }, wait);
  }

  private async flushRender(): Promise<void> {
    if (!this.sdk || !this.connected || !this.foreground || this.renderBusy || this.content === this.sentContent) return;
    const content = this.content;
    const epoch = this.epoch;
    this.renderBusy = true;
    this.lastRenderAt = performance.now();
    try {
      const accepted = await bounded(this.sdk.textContainerUpgrade(new TextContainerUpgrade({
        containerID: CONTAINER_ID, containerName: CONTAINER_NAME, content,
      })), 'Glasses text update', 5000);
      if (epoch !== this.epoch) return;
      const took = performance.now() - this.lastRenderAt;
      if (took > 2000) this.options.onSlowRender?.(Math.round(took));
      if (!accepted) throw new Error('The Even app returned false for the text update.');
      this.sentContent = content;
    } catch (error) {
      if (epoch === this.epoch) {
        this.renderBlocked = true;
        this.options.onStatus(`Glasses text update failed: ${reason(error)}`);
      }
    } finally {
      this.renderBusy = false;
      this.scheduleRender();
    }
  }
}
