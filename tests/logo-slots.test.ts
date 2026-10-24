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
