// Rendering ownership for ChannelLogo. A scheduler-only test cannot see this defect: the pool
// admitted correctly, but the component rendered an image from a grant earned by a *previous*
// acquisition of the same address. These render the real components against the real four-slot
// scheduler in jsdom, with no scheduler calls and no image load/error events unless stated.
//
// An <img> is in the DOM exactly when its component holds an admission, and it stays there after it
// has loaded (a completed logo keeps its picture), so the cap is asserted while nothing has
// completed: a fifth logo appearing then is a fifth request outside the pool.
import './dom.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';
import { ChannelLogo } from '../apps/web/src/live.js';

// The target keeps its identity across the transition; five others give one queued canary beyond
// the fourth admitted logo, so an extra release is visible as that canary starting early.
const others = ['a', 'b', 'c', 'd', 'e'];
const logo = (id: string, enabled = true) =>
  React.createElement(ChannelLogo, { channel: { id, name: `US: ${id}`, logo: enabled } });
const page = (target: string, enabled = true) =>
  React.createElement('div', null, logo(target, enabled), others.map(id => React.createElement('div', { key: id }, logo(id))));
const imgs = () => [...document.querySelectorAll('img')].map(node => node.getAttribute('src')!);
const url = (id: string) => `/api/v1/iptv/channels/${id}/logo`;
const shown = (id: string) => imgs().includes(url(id));
const nodeFor = (id: string) => [...document.querySelectorAll('img')].find(image => image.getAttribute('src') === url(id));
// A fresh root per test: the scheduler is shared state, and an unmounted root cannot render again.
const fresh = () => createRoot(document.getElementById('root')!);
const mount = (root: ReturnType<typeof createRoot>, element: ReactElement) => act(async () => { root.render(element); });
const unmount = (root: ReturnType<typeof createRoot>) => act(async () => { root.unmount(); });
// Cleanup is idempotent: a test that unmounts explicitly must not unmount again in its teardown.
const cleanup = (root: ReturnType<typeof createRoot>) => {
  let done = false;
  return () => { if (done) return Promise.resolve(); done = true; return unmount(root); };
};
const settle = (id: string, type: 'load' | 'error' = 'load') => act(async () => {
  const node = nodeFor(id);
  assert.ok(node, `${id} should have a rendered image to settle`);
  node.dispatchEvent(new Event(type));
});

test('returning to an earlier logo URL waits for its own admission instead of reusing a cancelled one', async t => {
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  await mount(root, page('t'));
  assert.deepEqual(imgs().sort(), ['a', 'b', 'c', 't'].map(url), 'four admitted, two queued');

  // A → B: the original A request is cancelled and the first queued logo takes its slot. B waits.
  await mount(root, page('u'));
  assert.deepEqual(imgs().sort(), ['a', 'b', 'c', 'd'].map(url), 'exactly four requests, the old target cancelled');

  // Back to A with nothing completed. A's new acquisition is queued, so it must render a monogram:
  // both the queued canary and the target stay unshown, which a second freed slot would break.
  const added: string[] = [];
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes)
      if (node instanceof HTMLImageElement) added.push(node.getAttribute('src') ?? '');
  });
  observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
  await mount(root, page('t'));
  observer.disconnect();
  assert.equal(shown('t'), false, 'the queued acquisition renders a monogram, not an image');
  assert.equal(shown('e'), false, 'only one slot was released, so only one waiter started');
  assert.equal(imgs().length, 4);
  assert.deepEqual(added, [], 'no image was created and then withdrawn by a later effect');

  // A completed logo keeps its picture after its slot is released, and admits the next waiter.
  await settle('d');
  assert.equal(shown('d'), true, 'a completed logo stays visible');
  assert.equal(shown('e'), true, 'its released slot admits the queued canary');
  assert.equal(shown('t'), false, 'the target acquisition is still queued behind the canary');
  await settle('a');
  assert.equal(shown('t'), true, 'the target is admitted on its own lease');
  await settle('t');
  assert.equal(shown('t'), true);
});

test('disabling and re-enabling the same URL requires a fresh admission', async t => {
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  await mount(root, page('t'));
  assert.equal(shown('t'), true);
  // Disabled: the grant is dropped during render and the lease returns before any effect runs.
  await mount(root, page('t', false));
  assert.equal(shown('t'), false);
  assert.equal(shown('d'), true, 'the released slot immediately admits the waiting logo');
  // Re-enabled with the identical URL: the earlier grant cannot be reused, and the pool is full.
  await mount(root, page('t'));
  assert.equal(shown('t'), false, 'a new acquisition must queue behind the four in flight');
  assert.equal(shown('e'), false, 'and exactly one slot was freed by the disable');
  await settle('a');
  assert.equal(shown('t'), false, 'one completion admits the canary, not the target');
  assert.equal(shown('e'), true);
  await settle('b');
  assert.equal(shown('t'), true);
});

test('an ordinary source replacement abandons the old image and admits the new one separately', async t => {
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  await mount(root, page('t'));
  const stale = nodeFor('t')!;
  await mount(root, page('u'));
  assert.equal(shown('t'), false, 'the replaced source is gone');
  assert.equal(shown('u'), false, 'the replacement waits for a slot');
  assert.equal(stale.getAttribute('src'), null, 'the abandoned request is cancelled at its own node');
  // A late load from the obsolete acquisition must not admit, render or release the new one.
  await act(async () => { stale.dispatchEvent(new Event('load')); });
  assert.equal(shown('u'), false, 'an obsolete callback cannot grant the current acquisition');
  assert.equal(shown('e'), false, 'nor free a slot for a queued logo');
  await settle('d');
  assert.equal(shown('e'), true);
  assert.equal(shown('u'), false);
  await settle('a');
  assert.equal(shown('u'), true);
});

test('a late error from an obsolete acquisition cannot release the current lease', async t => {
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  await mount(root, page('t'));
  const stale = nodeFor('t')!;
  await mount(root, page('u'));
  await act(async () => { stale.dispatchEvent(new Event('error')); });
  assert.deepEqual(imgs().sort(), ['a', 'b', 'c', 'd'].map(url),
    'the stale error neither frees a slot nor hides the four admitted logos');
  // Only the canary is queued: one completion admits it and releases one slot, not two.
  await settle('d');
  assert.equal(shown('e'), true, 'the single queued logo starts');
  assert.equal(imgs().length, 5, 'four still in flight plus the newly admitted canary');
});

test('the deadline cancels pending images, keeps monograms and admits the queued acquisitions', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  try {
    await mount(root, page('t'));
    assert.deepEqual(imgs().sort(), ['a', 'b', 'c', 't'].map(url));
    await act(async () => { mock.timers.tick(15001); });
    // The four expired requests are cancelled at their own nodes; both waiters take the free slots.
    assert.deepEqual(imgs().sort(), ['d', 'e'].map(url));
    await after();
    assert.equal(document.querySelectorAll('img').length, 0);
  } finally { mock.timers.reset(); }
});

test('unmounting with responses pending leaves no image and no leaked capacity', async t => {
  const root = fresh();
  const after = cleanup(root);
  t.after(after);
  await mount(root, page('t'));
  assert.equal(imgs().length, 4);
  await after();
  assert.equal(document.querySelectorAll('img').length, 0, 'no detached image keeps a request alive');
  // A fresh page must still have all four slots: the unmount released every lease exactly once.
  const next = fresh(), nextAfter = cleanup(next);
  t.after(nextAfter);
  await mount(next, page('f'));
  assert.deepEqual(imgs().sort(), ['a', 'b', 'c', 'f'].map(url));
  await nextAfter();
});
