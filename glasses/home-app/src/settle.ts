// "Wait until the glasses show what the model now says": callers wait for a settled state, with a cap so a stuck
// render can never block input for long. Free of the SDK so it can be tested.
export class SettleWaiters {
  private waiters = new Set<() => void>();

  /** Resolves at once if settled, else when notify() finds it settled, else after capMs. */
  wait(isSettled: () => boolean, capMs: number): Promise<void> {
    if (isSettled()) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, capMs);
      this.waiters.add(done);
    });
  }

  /** Call whenever the state may have become settled. */
  notify(isSettled: () => boolean): void {
    if (!this.waiters.size || !isSettled()) return;
    for (const done of [...this.waiters]) done();
  }
}
