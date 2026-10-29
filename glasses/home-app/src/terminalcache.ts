// Which terminal fetches change what the glasses show. The same text as last time changes nothing (no repaint); a failed
// fetch forgets the text, so the next success is shown even when it is identical (it replaces "Could not read this agent").
export class TerminalCache {
  private last = new Map<string, string>();

  /** Should this fetch result (null = failed) be applied? `hasShown`: the model already shows a terminal for this key. */
  shouldApply(key: string, lines: string[] | null, hasShown: boolean): boolean {
    if (lines === null) { this.last.delete(key); return true; }
    const text = JSON.stringify(lines);
    const same = this.last.get(key) === text;
    this.last.set(key, text);
    return !same || !hasShown;
  }
}
