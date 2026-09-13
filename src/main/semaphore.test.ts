// The counting semaphore that bounds how many PrusaSlicer processes exist at
// once. Pure timing/ordering logic — no slicer, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, SemaphoreTimeoutError } from "./semaphore";

test("a semaphore of size 2 admits two, queues the rest, and hands over in order", async () => {
  const sem = new Semaphore(2);
  const entered: number[] = [];
  const release: Array<() => void> = [];

  // Five callers ask at once. Nothing is awaited yet, so `waiting` must already
  // show the three that couldn't be admitted — a permit is taken synchronously
  // or not at all, otherwise two callers could both "find" the last one.
  const calls = [0, 1, 2, 3, 4].map((i) =>
    sem.acquire().then((rel) => {
      entered.push(i);
      release[i] = rel;
    }),
  );
  assert.equal(sem.waiting, 3);

  await Promise.all([calls[0], calls[1]]);
  assert.deepEqual(entered, [0, 1]);
  assert.equal(sem.waiting, 3);

  // FIFO: the permit goes to the caller who has been waiting longest, not to
  // whichever promise the runtime happens to schedule first.
  release[0]();
  await calls[2];
  assert.deepEqual(entered, [0, 1, 2]);
  assert.equal(sem.waiting, 2);

  release[1]();
  release[2]();
  await Promise.all([calls[3], calls[4]]);
  assert.deepEqual(entered, [0, 1, 2, 3, 4]);
  assert.equal(sem.waiting, 0);

  release[3]();
  release[4]();
});

test("releasing twice doesn't conjure an extra permit", async () => {
  const sem = new Semaphore(1);
  const first = await sem.acquire();
  first();
  first(); // a caller with a stale reference, or a finally block run twice

  const second = await sem.acquire();
  let thirdEntered = false;
  const third = sem.acquire().then(() => {
    thirdEntered = true;
  });
  assert.equal(sem.waiting, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(thirdEntered, false, "size 1 must never admit two at once");

  second();
  await third;
  assert.equal(thirdEntered, true);
});

test("size is clamped to at least one, so a bad config can't deadlock every slice", async () => {
  const sem = new Semaphore(0);
  assert.equal(sem.size, 1);
  const rel = await sem.acquire();
  rel();
});

// ── bounded waits ────────────────────────────────────────────────────────────
// An HTTP request cannot wait forever for a permit: the browser and any proxy in
// front of it give up on their own schedule, leaving the server slicing for a
// connection nobody is reading. `acquire(timeoutMs)` puts that decision here.

test("a bounded acquire gives up, and the giving up does not cost a permit", async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire();

  const startedAt = Date.now();
  await assert.rejects(
    () => sem.acquire(30),
    (err: unknown) => {
      assert.ok(err instanceof SemaphoreTimeoutError, "a distinct error type, not a generic one");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt >= 25, "it must actually wait, not reject immediately");
  // The abandoned waiter has to LEAVE the queue. Left in it, the next release
  // hands the permit to a promise nobody awaits, and that permit is never given
  // back — one wedged permit per timed-out visitor until the server holds none.
  assert.equal(sem.waiting, 0, "a timed-out waiter must not stay queued");

  held();
  // Proof the permit survived the timeout: this must not block.
  const after = await sem.acquire(50);
  after();
});

test("a timed-out waiter is skipped, and the caller behind it still gets the permit", async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire();

  const doomed = assert.rejects(() => sem.acquire(20));
  let servedSecond = false;
  const patient = sem.acquire().then((rel) => {
    servedSecond = true;
    rel();
  });
  assert.equal(sem.waiting, 2);

  await doomed;
  assert.equal(sem.waiting, 1, "only the patient caller is left");

  held();
  await patient;
  assert.equal(servedSecond, true, "FIFO must skip the corpse, not stall on it");
});

test("a free permit is taken immediately even when a timeout is offered", async () => {
  const sem = new Semaphore(2);
  const a = await sem.acquire(1);
  const b = await sem.acquire(1);
  a();
  b();
});

test("a non-positive timeout is refused rather than queued forever", async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire();
  await assert.rejects(() => sem.acquire(0), (err: unknown) => err instanceof SemaphoreTimeoutError);
  assert.equal(sem.waiting, 0);
  held();
});
