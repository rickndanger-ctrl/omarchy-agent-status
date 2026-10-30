// The Desk (test): a 3x3 grid of apps, a taskbar line, and a head pointer. Loaded with import() only when it is opened
// (main.ts never imports this file at startup), so a problem in here cannot stop Home from starting.
import { Pointer, ImuStats, DEFAULT_POINTER, type PointerConfig, type Sample } from './deskpointer';

export type DeskAppId = 'muse' | 'messages' | 'agents' | 'reminders' | 'clock' | 'listen' | 'studio' | 'settings' | 'tiles';
export const DESK_APPS: { id: DeskAppId; label: string }[] = [
  { id: 'muse', label: 'Muse' }, { id: 'messages', label: 'Messages' }, { id: 'agents', label: 'Agents' },
  { id: 'reminders', label: 'Reminders' }, { id: 'clock', label: 'Clock' }, { id: 'listen', label: 'Listen' },
  { id: 'studio', label: 'Studio' }, { id: 'settings', label: 'Settings' }, { id: 'tiles', label: 'Tiles' },
];
const COLS = 3;
const MENU_CHOICES = ['Open', 'Minimize', 'Close', 'Back'] as const;
export const DOUBLE_DOWN_MS = 400;
export const IMU_DIAG_MS = 10_000;
export const IMU_PACE = 100;

export type DeskResult = { kind: 'open'; app: DeskAppId } | { kind: 'home' } | null;

export interface DeskHost {
  /** Head tracking on/off (the glasses transport). */
  imu(open: boolean): Promise<boolean>;
  paint(): void;
  /** Resolves when the glasses show what was last painted. */
  settled(): Promise<unknown>;
  diag(name: string, detail: string): void;
  now(): number;
}

export class Desk {
  private cursor = 0;
  private menu: number | null = null;
  private minimized: DeskAppId[] = [];
  private lastDownAt = -Infinity;
  private tracking = false;
  private readonly pointer: Pointer;
  private stats: ImuStats | null = null;
  private statsDone = false;
  // Pointer repaint: one frame at a time, never faster than the glasses settle.
  private painting = false;
  private painted = -1;
  private moveFrom = -1;
  private moveStart = 0;
  private notice = '';
  private failedLogged = false;

  constructor(private readonly host: DeskHost, cfg: PointerConfig = DEFAULT_POINTER) { this.pointer = new Pointer(cfg); }

  get highlighted(): DeskAppId { return DESK_APPS[this.cursor].id; }
  get minimizedApps(): readonly DeskAppId[] { return this.minimized; }
  get menuOpen(): boolean { return this.menu !== null; }
  get imuOn(): boolean { return this.tracking; }

  render(): string {
    const cell = (i: number) => {
      const label = DESK_APPS[i].label;
      const mark = this.minimized.includes(DESK_APPS[i].id) ? '·' : '';
      const text = `${label}${mark}`;
      const inner = text.padStart(Math.floor((12 + text.length) / 2)).padEnd(12);
      return i === this.cursor ? `[${inner}]` : ` ${inner} `;
    };
    const lines = [this.notice || 'HOME › DESK (test)', ''];
    for (let r = 0; r < 3; r++) {
      lines.push([0, 1, 2].map(c => cell(r * COLS + c)).join(' '));
      if (r < 2) lines.push('');
    }
    lines.push('');
    const names = this.minimized.map(id => DESK_APPS.find(a => a.id === id)!.label);
    lines.push(`Taskbar: ${names.length ? names.join(' · ') : '—'}`);
    lines.push(this.menu === null ? 'up/tap: open · down: menu · 2×down: Home' : MENU_CHOICES.map((c, i) => (i === this.menu ? `[${c}]` : ` ${c} `)).join(' '));
    return lines.join('\n');
  }

  /** One press. `at` is when it was made (ms), so two downs are judged by when they arrived, not when they were applied. */
  input(input: 'up' | 'down' | 'select' | 'back', at: number): DeskResult {
    this.notice = '';
    this.pointer.recenter();
    if (input === 'back') { this.menu = null; return { kind: 'home' }; }
    if (input === 'down') {
      const twice = at - this.lastDownAt <= DOUBLE_DOWN_MS;
      this.lastDownAt = at;
      if (twice) { this.menu = null; return { kind: 'home' }; }
      this.menu = this.menu === null ? 0 : Math.min(this.menu + 1, MENU_CHOICES.length - 1);
      return null;
    }
    if (this.menu === null) return { kind: 'open', app: this.highlighted }; // up or tap
    if (input === 'up') { this.menu = Math.max(0, this.menu - 1); return null; }
    const choice = MENU_CHOICES[this.menu];
    this.menu = null;
    const id = this.highlighted;
    if (choice === 'Open') return { kind: 'open', app: id };
    if (choice === 'Minimize') this.minimize(id);
    if (choice === 'Close') this.minimized = this.minimized.filter(x => x !== id);
    return null;
  }

  /** A short message in the title line until the next press. */
  note(text: string): void { this.notice = text; }

  /** Back from an app returns here: the app stays on the taskbar. */
  appBack(app: DeskAppId): void { this.minimize(app); }
  private minimize(id: DeskAppId): void { if (!this.minimized.includes(id)) this.minimized.push(id); }

  // --- head pointer -------------------------------------------------------------------------------------------------
  /** Desk is in front: switch head tracking on. */
  async enter(): Promise<void> {
    this.menu = null;
    this.pointer.recenter();
    this.stats = new ImuStats();
    this.statsDone = false;
    this.painted = this.cursor;
    this.tracking = true;
    if (!(await this.host.imu(true))) { this.tracking = false; if (!this.failedLogged) this.host.diag('desk.imu', 'could not start'); this.failedLogged = true; } else this.failedLogged = false;
  }
  /** Desk left (an app, Home, the glasses menu): switch it off. */
  leave(): void {
    if (!this.tracking) return;
    this.tracking = false;
    void this.host.imu(false);
  }
  /** The transport switched tracking off (left the front, app exit, reconnect). */
  imuLost(): void { this.tracking = false; }
  /** Back in front with Desk showing: tracking on again. */
  resume(): Promise<void> { return this.tracking ? Promise.resolve() : this.enter(); }

  imuSample(s: Sample): void {
    if (!this.tracking) return;
    const t = this.host.now();
    if (this.stats && !this.statsDone) {
      this.stats.add(t, s);
      if (t - this.stats.startedAt >= IMU_DIAG_MS) { this.statsDone = true; this.host.diag('desk.imu', this.stats.line(t, IMU_PACE)); }
    }
    if (this.menu !== null) return;
    const move = this.pointer.sample(t, s);
    if (!move) return;
    const col = this.cursor % COLS + move.dCol;
    const row = Math.floor(this.cursor / COLS) + move.dRow;
    if (col < 0 || col >= COLS || row < 0 || row >= COLS) return;
    const next = row * COLS + col;
    if (next === this.cursor) return;
    if (!this.painting) { this.moveFrom = this.cursor; this.moveStart = t; }
    this.cursor = next;
    this.requestPaint();
  }

  private requestPaint(): void {
    if (this.painting) return; // the frame in flight finishes first; then the newest cell is painted once
    this.painting = true;
    this.painted = this.cursor;
    const from = this.moveFrom;
    const start = this.moveStart;
    this.host.paint();
    void this.host.settled().then(() => {
      this.host.diag('desk.move', `${from}->${this.painted} ${this.host.now() - start}`);
      this.painting = false;
      if (this.tracking && this.cursor !== this.painted) { this.moveFrom = this.painted; this.moveStart = this.host.now(); this.requestPaint(); }
    });
  }
}
