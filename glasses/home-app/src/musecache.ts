// What the Muse tile shows, and the rules that keep it honest: a fetch that started before an ask must
// never overwrite a newer ask reply, and nothing is fetched while an ask is in flight. Free of the SDK and the network.
export interface MuseValue { question: string; reply: string }
/** What the tile shows when a read of /api/muse failed ("Muse: can't reach", with a Retry action). */
export const MUSE_UNREACHABLE: MuseValue = { question: '', reply: '' };

export class MuseCache {
  private value: MuseValue | null = null;
  private stamp = 0;
  private asking = false;

  get(): MuseValue | null { return this.value; }
  get isAsking(): boolean { return this.asking; }

  private fetchedOn = -1;

  /** Forget which page was fetched (entering Tiles): the next page view fetches again. */
  resetPage(): void { this.fetchedOn = -1; }
  /**
   * The timed refresh's rule: /api/muse is read once per page view, marked before the call. While an ask is in
   * flight the page is marked too, so no extra read happens after the ask. null means do not fetch.
   */
  pageFetchStart(page: number, homeLoaded = true): number | null {
    if (!homeLoaded) return null; // wait for the first /api/home: nothing is read at startup
    if (this.fetchedOn === page) return null;
    this.fetchedOn = page;
    return this.fetchStart();
  }

  /** Before a fetch of /api/muse: null means skip it (an ask is in flight). Hand the result to fetchDone. */
  fetchStart(): number | null { return this.asking ? null : this.stamp; }
  private readSeq = 0;
  private appliedRead = 0;
  /** Every /latest read (screen or tile) gets its own increasing number when it starts. */
  startRead(): number { return ++this.readSeq; }
  /** A result is taken only if no read that started later has been applied already; taking it records that. */
  takeRead(read: number): boolean {
    if (read < this.appliedRead) return false;
    this.appliedRead = read;
    return true;
  }
  /** Is a fetch that started with this stamp still the newest word (no ask began or ended since)? */
  isCurrent(stamp: number | null): boolean { return stamp !== null && !this.asking && stamp === this.stamp; }
  /** The fetch's result is used only if nothing newer (an ask) happened since it started. */
  fetchDone(stamp: number, value: MuseValue | null): void {
    if (value && !this.asking && stamp === this.stamp) this.value = value;
  }

  /** A read failed: the tile says it can't reach Muse and offers Retry (one read per tap). */
  fetchFailed(stamp: number): void {
    if (!this.asking && stamp === this.stamp) this.value = MUSE_UNREACHABLE;
  }

  /** The owner asked Muse: the tile shows "thinking" (an empty reply) until the answer arrives. */
  askStart(question: string): void { this.asking = true; this.stamp++; this.value = { question, reply: '' }; }
  askReply(question: string, reply: string): void { this.stamp++; this.value = { question, reply }; }
  askEnd(): void { this.asking = false; this.stamp++; }
}
