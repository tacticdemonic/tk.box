import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogoSlots } from '../apps/web/src/logo-slots.js';

// M03.5 follow-up: a guide page asks for 50–60 logos. Each holds a browser connection until it
// finishes, and the Fire TV WebView predates loading="lazy", so the page opened all of them and the
// next guide request queued behind them. The reproduction is in the evidence record: the guide's
// own request spent 6,215 ms in the browser queue while the server needed 448 ms. These assert the
// cap and the hand-back rules that stop that, without needing a browser.

test('no more than the limit run at once, and each finish admits the next waiter', () => {
  const slots = createLogoSlots(4, 100000), started: number[] = [], releases: (() => void)[] = [];
  // Fifty rows, as a guide page renders them.
  for (let i = 0; i < 50; i++) releases.push(slots(() => started.push(i), () => assert.fail('no logo should time out here')));
  assert.deepEqual(started, [0, 1, 2, 3], 'only the first four start; the rest wait');

  // Finishing one admits exactly one, in order, and never exceeds the cap.
  releases[0]!();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases[1]!(); releases[2]!();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(started.length, 7);
});

test('a release is idempotent so a double settle cannot free two slots', () => {
  const slots = createLogoSlots(2, 100000), started: number[] = [], releases: (() => void)[] = [];
  for (let i = 0; i < 4; i++) releases.push(slots(() => started.push(i), () => {}));
  assert.deepEqual(started, [0, 1]);
  releases[0]!(); releases[0]!();
  assert.deepEqual(started, [0, 1, 2], 'the second call is ignored, so only one slot was freed');
  assert.equal(started.length, 3);
});

test('releasing a still-queued logo takes it out of the queue without spending a slot', () => {
  const slots = createLogoSlots(2, 100000), started: number[] = [], releases: (() => void)[] = [];
  for (let i = 0; i < 5; i++) releases.push(slots(() => started.push(i), () => {}));
  assert.deepEqual(started, [0, 1]);
  // Row 4 unmounts before it ever starts: releasing it must not let a fifth logo run.
  releases[4]!();
  releases[0]!();
  assert.deepEqual(started, [0, 1, 2], 'the next waiter (2) starts, not a skipped one');
  releases[1]!();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(started.length, 4, 'the cancelled row never started');
});

test('an unfinished logo expires so a stuck response cannot hold the queue forever', async () => {
  const slots = createLogoSlots(2, 20), started: number[] = [], expired: number[] = [];
  // The first two are stuck; the third is only waiting for a slot.
  for (let i = 0; i < 3; i++) slots(() => started.push(i), () => expired.push(i));
  assert.deepEqual(started, [0, 1]);
  await new Promise(done => setTimeout(done, 60));
  // Freeing the stuck slots admits the waiter, which then expires on its own deadline too.
  assert.deepEqual(expired, [0, 1, 2]);
  assert.deepEqual(started, [0, 1, 2]);
});

test('a logo that settles before its deadline does not expire later', async () => {
  const slots = createLogoSlots(1, 40), started: number[] = [], expired: number[] = [];
  const release = slots(() => started.push(0), () => expired.push(0));
  release();
  await new Promise(done => setTimeout(done, 80));
  assert.deepEqual(started, [0]);
  assert.deepEqual(expired, [], 'the slot was released, so no timeout fires for it');
});

// The component sequence that produced the defect: expiry frees the slot, then calls `giveUp`,
// which in ChannelLogo is `abandon` → `settle` → the same lease the scheduler already spent.
// A harness that replays exactly that, so the double release is visible as a pool that admits
// more than its limit.
function componentPool(limit: number, timeoutMs: number) {
  const slots = createLogoSlots(limit, timeoutMs);
  const started: string[] = [], expired: string[] = [], live = new Set<string>();
  let peak = 0;
  const tile = (id: string) => {
    let lease: (() => void) | undefined;
    const abandon = () => { expired.push(id); live.delete(id); lease?.(); };
    lease = slots(() => { started.push(id); live.add(id); peak = Math.max(peak, live.size); }, abandon);
    // onLoad / onError / effect cleanup: settle the lease the effect holds.
    return () => { live.delete(id); lease?.(); };
  };
  return { slots, tile, started, expired, live, peak: () => peak };
}

test('an expiry whose giveUp releases its own lease returns capacity once', async () => {
  const pool = componentPool(4, 15);
  const tiles = Array.from({ length: 12 }, (_, i) => pool.tile(`c${i}`));
  assert.deepEqual(pool.started, ['c0', 'c1', 'c2', 'c3'], 'the first four are admitted');
  await new Promise(done => setTimeout(done, 40));
  // Component cleanup for the expired tiles must be harmless: the slot was already returned.
  tiles.forEach(tile => tile());
  assert.ok(pool.live.size < 4, `expiry retired the running jobs (${pool.live.size} still live)`);
  // A fresh batch on the drained pool must still respect the limit.
  pool.started.length = 0;
  for (let i = 0; i < 16; i++) pool.tile(`fresh${i}`);
  assert.equal(pool.started.length, 4, `a drained pool admits exactly ${4}, not ${pool.started.length}`);
  assert.ok(pool.peak() <= 4, 'never more than the limit in flight');
});

test('repeated release after expiry is a no-op, and a late load cannot free a newer slot', async () => {
  const pool = componentPool(2, 15);
  const first = pool.tile('a'), second = pool.tile('b');
  await new Promise(done => setTimeout(done, 40));
  assert.deepEqual(pool.expired, ['a', 'b']);
  // Late load/error events and effect cleanup, several times over.
  first(); first(); second(); second();
  pool.started.length = 0;
  for (let i = 0; i < 4; i++) pool.tile(`n${i}`);
  assert.equal(pool.started.length, 2, 'the pool still admits exactly its limit');
});

test('a batch that expires completely leaves the pool usable at full capacity', async () => {
  const pool = componentPool(4, 15);
  for (let i = 0; i < 12; i++) pool.tile(`c${i}`);
  await new Promise(done => setTimeout(done, 60));
  assert.equal(pool.expired.length, 12, 'every queued logo eventually reached its deadline');
  pool.started.length = 0;
  for (let i = 0; i < 8; i++) pool.tile(`next${i}`);
  assert.deepEqual(pool.started, ['next0', 'next1', 'next2', 'next3']);
  // Normal completion after the expiry storm still admits in order, one for one.
  pool.tile('late');
  assert.equal(pool.started.length, 4);
});

test('queued cancellation, normal completion and expiry share one correct count', async () => {
  const pool = componentPool(2, 20);
  const tiles = Array.from({ length: 6 }, (_, i) => pool.tile(`c${i}`));
  assert.deepEqual(pool.started, ['c0', 'c1']);
  tiles[4]!();                       // queued: leaves the queue, spends no slot
  assert.deepEqual(pool.started, ['c0', 'c1'], 'cancelling a queued logo starts nothing');
  tiles[0]!();                       // normal completion: admits exactly one
  assert.deepEqual(pool.started, ['c0', 'c1', 'c2']);
  await new Promise(done => setTimeout(done, 40));  // c1 and c2 expire
  assert.deepEqual(pool.expired, ['c1', 'c2']);
  // Each expiry returns exactly one slot, so both survivors of the queue start, in order.
  assert.deepEqual(pool.started, ['c0', 'c1', 'c2', 'c3', 'c5'], 'the cancelled queued logo (c4) never ran');
  tiles[1]!(); tiles[2]!(); tiles[3]!(); tiles[5]!();  // cleanup after expiry is harmless
  assert.equal(pool.live.size, 0);
  assert.deepEqual(pool.started, ['c0', 'c1', 'c2', 'c3', 'c5'], 'cleanup admits nothing extra');
});

test('a start that throws does not lose the slot permanently', async () => {
  // A rendering or measurement call can throw before the image exists. The job must still give its
  // slot back at the deadline rather than holding capacity for the life of the page.
  const slots = createLogoSlots(1, 20), expired: string[] = [], started: string[] = [];
  assert.throws(() => slots(() => { throw new Error('boom'); }, () => expired.push('broken')), /boom/, 'the throw surfaces');
  await new Promise(done => setTimeout(done, 50));
  assert.deepEqual(expired, ['broken']);
  slots(() => started.push('after'), () => {});
  assert.deepEqual(started, ['after'], 'capacity came back after the deadline');
});
