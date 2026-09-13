// The counting semaphore that bounds how many PrusaSlicer processes exist at
// once. Pure timing/ordering logic — no slicer, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "./semaphore";

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
