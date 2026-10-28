// What the Muse tile shows, and the rules that keep it honest: a fetch that started before an ask must
// never overwrite a newer ask reply, and nothing is fetched while an ask is in flight. Free of the SDK and the network.
export interface MuseValue { question: string; reply: string }

export class MuseCache {
  private value: MuseValue | null = null;
  private stamp = 0;
  private asking = false;

  get(): MuseValue | null { return this.value; }
  get isAsking(): boolean { return this.asking; }

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
