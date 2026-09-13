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

/** `acquire(timeoutMs)` gave up before a permit came free. Deliberately NOT a
 *  wire error: the semaphore knows nothing about HTTP, and its two callers want
 *  different answers (a REST visitor gets 503 `slicer_busy`; the desktop app
 *  keeps waiting and never passes a timeout at all). */
export class SemaphoreTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a permit`);
    this.name = "SemaphoreTimeoutError";
  }
}

/** One queued caller. Cancelled entries are left for `release` to skip rather
 *  than being handed a permit nobody is waiting for any more. */
interface Waiter {
  wake: () => void;
  cancelled: boolean;
}

export class Semaphore {
  /** How many permits exist. At least 1 — a size of 0 would deadlock every
   *  caller forever, which is never what a misconfigured env var should buy. */
  readonly size: number;

  /** Permits currently handed out. */
  private held = 0;

  /** Callers queued for a permit, oldest first. */
  private queue: Waiter[] = [];

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
   *
   * With `timeoutMs`, a caller that has waited that long stops waiting and the
   * promise rejects with `SemaphoreTimeoutError`. Waiting forever is the right
   * default for a desktop app and the wrong one for an HTTP request, which has
   * a browser and a proxy on the other end that will each give up on their own
   * schedule and leave the work queued behind a connection nobody is reading.
   */
  acquire(timeoutMs?: number): Promise<() => void> {
    if (this.held < this.size) {
      this.held++;
      return Promise.resolve(this.releaser());
    }
    const bounded = typeof timeoutMs === "number" && Number.isFinite(timeoutMs);
    if (bounded && timeoutMs! <= 0) {
      return Promise.reject(new SemaphoreTimeoutError(timeoutMs!));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { cancelled: false, wake: () => {} };
      let timer: ReturnType<typeof setTimeout> | undefined;
      waiter.wake = () => {
        if (timer) clearTimeout(timer);
        resolve(this.releaser());
      };
      this.queue.push(waiter);
      if (!bounded) return;
      timer = setTimeout(() => {
        // Leave the queue: a cancelled waiter still in it would be handed the
        // next permit by `release`, which would then be held by nobody and
        // never given back — the queue would wedge one permit at a time.
        waiter.cancelled = true;
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new SemaphoreTimeoutError(timeoutMs!));
      }, timeoutMs!);
      // Deliberately NOT unref'd. The timer is the only thing that can settle
      // this promise, so letting the event loop drain out from under it would
      // leave a caller awaiting a result that can never arrive — a worse trade
      // than a timer that keeps the loop alive for at most `timeoutMs`, and it
      // is cleared the moment a permit arrives.
    });
  }

  /** A one-shot release. Calling it twice (a stale reference, a `finally` that
   *  runs on both paths) must not invent a permit that was never held. */
  private releaser(): () => void {
    let spent = false;
    return () => {
      if (spent) return;
      spent = true;
      // Skip anyone who timed out while queued: handing them the permit would
      // retire it for good.
      let next = this.queue.shift();
      while (next?.cancelled) next = this.queue.shift();
      if (next) {
        // Hand the permit straight to the next in line — never drop `held` in
        // between, or a caller arriving in this tick would slip past the queue.
        next.wake();
        return;
      }
      this.held--;
    };
  }
}
