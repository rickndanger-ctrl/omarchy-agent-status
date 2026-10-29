// Which terminal fetches change what the glasses show. The same text as last time changes nothing (no repaint); a failed
// fetch forgets the text, so the next success is shown even when it is identical (it replaces "Could not read this agent").
// The text is recorded only once the model really took it (the agent may have been left before the update ran).
export class TerminalCache {
  private last = new Map<string, string>();

  /** Is this fetch result (null = failed) worth applying? `hasShown`: the model already shows a terminal for this key. */
  shouldApply(key: string, lines: string[] | null, hasShown: boolean): boolean {
    if (lines === null) return true;
    return this.last.get(key) !== JSON.stringify(lines) || !hasShown;
  }

  /** The model took this result (null = the failure text): remember it, or forget the text after a failure. */
  record(key: string, lines: string[] | null): void {
    if (lines === null) this.last.delete(key); else this.last.set(key, JSON.stringify(lines));
  }
}
