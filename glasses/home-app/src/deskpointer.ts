// Head pointer for the Desk: turns the glasses' motion samples into "move the highlight one cell". Pure: no SDK, no timers,
// time is passed in, so tests drive it with a fake IMU. A dead zone keeps small head movements from doing anything,
// smoothing takes the jitter out, one step is made per head turn (it re-arms when the head comes back), and holding still
// (or any press) makes the current pose the new centre.

export interface Sample { x: number; y: number; z: number }
export interface PointerConfig {
  /** Which sample axes are yaw (left/right) and pitch (up/down). The first-10-s 'desk.imu' diag shows the real ranges. */
  yawAxis: keyof Sample;
  pitchAxis: keyof Sample;
  /** Smoothed offset from the centre that counts as a head turn. */
  deadZone: number;
  /** 0..1: how much of each new sample is taken in (lower = smoother). */
  smoothing: number;
  /** Still for this long (ms) and the pose becomes the centre. */
  recenterMs: number;
  /** "Still" means the smoothed pose moved less than this since the last sample. */
  stillEps: number;
}
export const DEFAULT_POINTER: PointerConfig = { yawAxis: 'x', pitchAxis: 'y', deadZone: 8, smoothing: 0.4, recenterMs: 1000, stillEps: 0.4 };

export interface Move { dCol: -1 | 0 | 1; dRow: -1 | 0 | 1 }

export class Pointer {
  private smooth: { yaw: number; pitch: number } | null = null;
  private centre: { yaw: number; pitch: number } | null = null;
  private armed = true;
  private stillSince = 0;

  constructor(private readonly cfg: PointerConfig = DEFAULT_POINTER) {}

  /** A press (or leaving and coming back): the next sample becomes the centre. */
  recenter(): void { this.centre = null; this.smooth = null; this.armed = true; }

  /** One sample at time `t` (ms). Returns a one-cell move, or null. */
  sample(t: number, s: Sample): Move | null {
    const yaw = s[this.cfg.yawAxis];
    const pitch = s[this.cfg.pitchAxis];
    if (!this.smooth) { this.smooth = { yaw, pitch }; this.centre = { yaw, pitch }; this.armed = true; this.stillSince = t; return null; }
    const a = this.cfg.smoothing;
    const before = this.smooth;
    this.smooth = { yaw: before.yaw + a * (yaw - before.yaw), pitch: before.pitch + a * (pitch - before.pitch) };
    const centre = this.centre!;
    const dYaw = this.smooth.yaw - centre.yaw;
    const dPitch = this.smooth.pitch - centre.pitch;
    const moving = Math.hypot(this.smooth.yaw - before.yaw, this.smooth.pitch - before.pitch) >= this.cfg.stillEps;
    if (moving) this.stillSince = t;
    else if (t - this.stillSince >= this.cfg.recenterMs) { this.centre = { ...this.smooth }; this.armed = true; this.stillSince = t; return null; }
    const dead = this.cfg.deadZone;
    if (Math.abs(dYaw) < dead && Math.abs(dPitch) < dead) { if (Math.abs(dYaw) < dead / 2 && Math.abs(dPitch) < dead / 2) this.armed = true; return null; }
    if (!this.armed) return null;
    this.armed = false;
    // The bigger turn wins: one cell, one direction. Pitch up = the row above.
    if (Math.abs(dYaw) >= Math.abs(dPitch)) return { dCol: dYaw > 0 ? 1 : -1, dRow: 0 };
    return { dCol: 0, dRow: dPitch > 0 ? -1 : 1 };
  }
}

/** Min/max/rate of the samples seen, for the 'desk.imu' diag line. */
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
    const f = (k: 'x' | 'y' | 'z') => `${k}=[${+this.lo[k].toFixed(1)},${+this.hi[k].toFixed(1)}]`;
    const secs = Math.max(0.001, (t - this.first) / 1000);
    return `pace=${pace} rate=${(this.n / secs).toFixed(1)}Hz ${f('x')} ${f('y')} ${f('z')}`;
  }
}
