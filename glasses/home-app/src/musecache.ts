// What the Muse tile shows, and the rules that keep it honest: a fetch that started before an ask must
// never overwrite a newer ask reply, and nothing is fetched while an ask is in flight. Free of the SDK and the network.
export interface MuseValue { question: string; reply: string }

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
  pageFetchStart(page: number): number | null {
    if (this.fetchedOn === page) return null;
    this.fetchedOn = page;
    return this.fetchStart();
  }

  /** Before a fetch of /api/muse: null means skip it (an ask is in flight). Hand the result to fetchDone. */
  fetchStart(): number | null { return this.asking ? null : this.stamp; }
  /** The fetch's result is used only if nothing newer (an ask) happened since it started. */
  fetchDone(stamp: number, value: MuseValue | null): void {
    if (value && !this.asking && stamp === this.stamp) this.value = value;
  }

  /** The owner asked Muse: the tile shows "thinking" (an empty reply) until the answer arrives. */
  askStart(question: string): void { this.asking = true; this.stamp++; this.value = { question, reply: '' }; }
  askReply(question: string, reply: string): void { this.stamp++; this.value = { question, reply }; }
  askEnd(): void { this.asking = false; this.stamp++; }
}
