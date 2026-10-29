// "Only the newest request counts": a late answer to an older request is ignored. Free of everything.
export class Latest {
  private n = 0;
  /** Start a request; remember the number it gets. */
  next(): number { return ++this.n; }
  /** Make every request so far out of date (a cancel). */
  invalidate(): void { this.n++; }
  isLatest(id: number): boolean { return id === this.n; }
}
