/** Waits for one exact frame to be drawn on the glasses (the final Muse reply), and says how long after the ask it appeared. */
export class ShownWatch {
  private want: { text: string; since: number } | null = null;
  /** The final frame text that was just asked for (exactly what setText was given, after its own clean-up). */
  expect(text: string, since: number): void { this.want = { text, since }; }
  /** Arm only if the Muse screen is the one painted; otherwise nothing is waited for and false is returned ("not on screen"). */
  expectOnScreen(onMuseScreen: boolean, text: string | null, since: number): boolean {
    if (!onMuseScreen || text === null) { this.want = null; return false; }
    this.expect(text, since);
    return true;
  }
  /** A frame was drawn: the elapsed ms if it is exactly the expected frame (once), else null. A partial with the same start does not count. */
  drawn(text: string, nowMs: number): number | null {
    if (!this.want || text !== this.want.text) return null;
    const ms = nowMs - this.want.since;
    this.want = null;
    return ms;
  }
  clear(): void { this.want = null; }
}
