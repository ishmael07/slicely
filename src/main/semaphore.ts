// ─────────────────────────────────────────────────────────────────────────────
// A counting semaphore, FIFO.
//
// Slicely needs exactly one thing from it: a bound on how many PrusaSlicer
// processes exist at once. Slicing is the single most expensive thing this
// server does — a real model saturates a core for tens of seconds to minutes —
// so N concurrent visitors each starting a slice is how a host with two cores
// stops answering anything at all, including the requests that would have told
// the user what was happening. Ten queued slices that each finish are strictly
// better than ten simultaneous slices that all crawl.
//
// FIFO matters: a LIFO or arbitrary wake-up order means the visitor who has
// been waiting longest can be passed over indefinitely while later arrivals
// jump in. First come, first sliced.
// ─────────────────────────────────────────────────────────────────────────────

export class Semaphore {
  /** How many permits exist. At least 1 — a size of 0 would deadlock every
   *  caller forever, which is never what a misconfigured env var should buy. */
  readonly size: number;

  /** Permits currently handed out. */
  private held = 0;

  /** Callers queued for a permit, oldest first. */
  private queue: Array<() => void> = [];

  constructor(size: number) {
    this.size = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 1;
  }

  /** Callers waiting for a permit right now (excludes the ones holding one). */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Take a permit, waiting if none is free. Resolves with the function that
   * gives it back — call it in a `finally`, or the permit is gone for the life
   * of the process.
   *
   * A free permit is claimed SYNCHRONOUSLY (before the returned promise is even
   * awaited) so two callers in the same tick can't both see the last one.
   */
  acquire(): Promise<() => void> {
    if (this.held < this.size) {
      this.held++;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.releaser()));
    });
  }

  /** A one-shot release. Calling it twice (a stale reference, a `finally` that
   *  runs on both paths) must not invent a permit that was never held. */
  private releaser(): () => void {
    let spent = false;
    return () => {
      if (spent) return;
      spent = true;
      const next = this.queue.shift();
      if (next) {
        // Hand the permit straight to the next in line — never drop `held` in
        // between, or a caller arriving in this tick would slip past the queue.
        next();
        return;
      }
      this.held--;
    };
  }
}
