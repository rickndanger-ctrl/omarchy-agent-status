// "Wait until the glasses show what the model now says": callers wait for a settled state, with a cap so a stuck
// render can never block input for long. Free of the SDK so it can be tested.
//   rendered     the glasses show what was last set
//   not-visible  nothing can reach the glasses now (app in the background, disconnected, a render failed)
//   capped       the wait ran out before either happened
export type SettleResult = 'rendered' | 'not-visible' | 'capped';

export class SettleWaiters {
  private waiters = new Set<(r: SettleResult) => void>();

  /** Resolves at once if `check` says settled, else when notify() finds it settled, else with 'capped' after capMs. */
  wait(check: () => SettleResult | null, capMs: number): Promise<SettleResult> {
    const now = check();
    if (now) return Promise.resolve(now);
    return new Promise<SettleResult>(resolve => {
      const done = (r: SettleResult) => { clearTimeout(timer); this.waiters.delete(done); resolve(r); };
      const timer = setTimeout(() => done('capped'), capMs);
      this.waiters.add(done);
    });
  }

  /** Call whenever the state may have become settled. */
  notify(check: () => SettleResult | null): void {
    if (!this.waiters.size) return;
    const r = check();
    if (!r) return;
    for (const done of [...this.waiters]) done(r);
  }
}

/** Runs async jobs one after another, in the order they were asked for (a stop can never overtake a start). */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
}
