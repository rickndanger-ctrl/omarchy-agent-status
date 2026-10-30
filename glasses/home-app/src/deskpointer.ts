// Head pointer for the Desk. The glasses' IMU samples are an accelerometer in g (z ~ 1 = gravity at rest), so head
// movement is read as TILT: roll = atan2(x, z) (left/right) and pitch = atan2(y, z) (up/down), in degrees. Pure: no SDK,
// no timers, time is passed in, so tests drive it with a fake IMU.
//   * the centre is the MEDIAN pose of the first SETTLE_MS after the Desk opens and after every press (recenter()); no steps until then,
//     so one noisy sample, or a head that is already moving, cannot set it;
//   * a low-pass (~0.3 s) takes out the jitter;
//   * a tilt past STEP degrees moves one cell; it re-arms only when the head is back under REARM degrees;
//   * held past the step angle it repeats every REPEAT_MS;
//   * drift: resting inside the re-arm zone for RECENTER_MS makes that pose the centre (never while tilted past it).

export interface Sample { x: number; y: number; z: number }
export interface PointerConfig {
  /** Degrees of tilt from the centre that make a step. */
  stepDeg: number;
  /** Back under this and the pointer is armed again. */
  rearmDeg: number;
  /** Low-pass time constant (ms). */
  lowpassMs: number;
  /** While tilted past the step angle: another step every this many ms. */
  repeatMs: number;
  /** Resting inside the re-arm zone this long (ms) makes the pose the new centre. */
  recenterMs: number;
  /** Phone switches: roll and pitch trade places; left/right and up/down flip. */
  swapAxes: boolean;
  invertX: boolean;
  invertY: boolean;
}
export const DEFAULT_POINTER: PointerConfig = { stepDeg: 11, rearmDeg: 5, lowpassMs: 300, repeatMs: 800, recenterMs: 2000, swapAxes: false, invertX: false, invertY: false };

/** Moving less than this (degrees) counts as resting. */
const REST_DEG = 1.5;
/** After a press or at open, samples for this long (ms) are only collected to find the centre. */
export const SETTLE_MS = 300;
const median = (v: number[]): number => { const a = [...v].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const DEG = 180 / Math.PI;
/** Tilt of a gravity reading, in degrees. */
export function tilt(s: Sample): { roll: number; pitch: number } {
  return { roll: Math.atan2(s.x, s.z) * DEG, pitch: Math.atan2(s.y, s.z) * DEG };
}
/** The gravity reading (g) of a head tilted by these angles: what the fake IMU sends. tilt(gravity(r, p)) gives r and p back. */
export function gravity(rollDeg: number, pitchDeg: number): Sample {
  const x = Math.tan(rollDeg / DEG), y = Math.tan(pitchDeg / DEG);
  const n = Math.sqrt(1 + x * x + y * y);
  return { x: x / n, y: y / n, z: 1 / n };
}

export interface Move { dCol: -1 | 0 | 1; dRow: -1 | 0 | 1 }

export class Pointer {
  private smooth: { roll: number; pitch: number } | null = null;
  private centre: { roll: number; pitch: number } | null = null;
  private lastT = 0;
  private armed = true;
  private nextRepeat = 0;
  private restSince = 0;
  private restAt = { roll: 0, pitch: 0 };

  constructor(public cfg: PointerConfig = DEFAULT_POINTER) {}

  /** Live changes from the phone page. */
  setOptions(o: Partial<Pick<PointerConfig, 'swapAxes' | 'invertX' | 'invertY'>>): void { this.cfg = { ...this.cfg, ...o }; }

  /** The Desk opened, or a press was made: the next sample becomes the centre. */
  recenter(): void { this.centre = null; this.smooth = null; this.armed = true; this.collect = null; }
  private collect: { start: number; roll: number[]; pitch: number[] } | null = null;

  /** One sample at time `t` (ms). Returns a one-cell move, or null. */
  sample(t: number, s: Sample): Move | null {
    const now = tilt(s);
    if (!this.smooth || !this.centre) {
      const c = this.collect ??= { start: t, roll: [], pitch: [] };
      if (t - c.start < SETTLE_MS) { c.roll.push(now.roll); c.pitch.push(now.pitch); return null; }
      const centre = { roll: median(c.roll), pitch: median(c.pitch) };
      this.collect = null; this.smooth = { ...centre }; this.centre = centre; this.armed = true; this.lastT = t - 1; this.restSince = t; this.restAt = { ...centre };
    }
    const a = 1 - Math.exp(-Math.max(0, t - this.lastT) / this.cfg.lowpassMs);
    this.lastT = t;
    this.smooth = { roll: this.smooth.roll + a * (now.roll - this.smooth.roll), pitch: this.smooth.pitch + a * (now.pitch - this.smooth.pitch) };
    let dx = this.smooth.roll - this.centre.roll;
    let dy = this.smooth.pitch - this.centre.pitch;
    if (this.cfg.swapAxes) [dx, dy] = [dy, dx];
    if (this.cfg.invertX) dx = -dx;
    if (this.cfg.invertY) dy = -dy;
    const big = Math.max(Math.abs(dx), Math.abs(dy));
    if (big < this.cfg.rearmDeg) {
      this.armed = true;
      // Slow drift is absorbed, but only while the head is inside the re-arm zone.
      // ...and only a head that is really resting (it has not moved more than REST_DEG since the rest began).
      if (Math.hypot(this.smooth.roll - this.restAt.roll, this.smooth.pitch - this.restAt.pitch) > REST_DEG) { this.restSince = t; this.restAt = { ...this.smooth }; }
      else if (t - this.restSince >= this.cfg.recenterMs) { this.centre = { ...this.smooth }; this.restSince = t; }
      return null;
    }
    this.restSince = t; this.restAt = { ...this.smooth };
    if (big < this.cfg.stepDeg) return null;
    const step = (): Move => (Math.abs(dx) >= Math.abs(dy) ? { dCol: dx > 0 ? 1 : -1, dRow: 0 } : { dCol: 0, dRow: dy > 0 ? 1 : -1 });
    if (this.armed) { this.armed = false; this.nextRepeat = t + this.cfg.repeatMs; return step(); }
    if (t >= this.nextRepeat) { this.nextRepeat += this.cfg.repeatMs; return step(); }
    return null;
  }
}

/** Min/max/rate of the raw samples seen, for the 'desk.imu' diag line. */
export class ImuStats {
  private n = 0;
  private first = 0;
  private lo = { x: Infinity, y: Infinity, z: Infinity };
  private hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  add(t: number, s: Sample): void {
    if (!this.n) this.first = t;
    this.n++;
    for (const k of ['x', 'y', 'z'] as const) { this.lo[k] = Math.min(this.lo[k], s[k]); this.hi[k] = Math.max(this.hi[k], s[k]); }
  }
  get count(): number { return this.n; }
  get startedAt(): number { return this.first; }
  line(t: number, pace: number): string {
    const f = (k: 'x' | 'y' | 'z') => `${k}=[${+this.lo[k].toFixed(2)},${+this.hi[k].toFixed(2)}]`;
    const secs = Math.max(0.001, (t - this.first) / 1000);
    return `pace=${pace} rate=${(this.n / secs).toFixed(1)}Hz ${f('x')} ${f('y')} ${f('z')}`;
  }
}
