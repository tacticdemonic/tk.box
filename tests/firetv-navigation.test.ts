import test from 'node:test';
import assert from 'node:assert/strict';
import {spatialNext, type Box} from '../apps/web/src/tv-navigation.js';
import {readFileSync} from 'node:fs';

const box = (left: number, top: number, width = 100, height = 40): Box => ({left, top, right: left + width, bottom: top + height});

test('d-pad movement picks the nearest control in the pressed direction and ignores the rest', () => {
  // A row of navigation, a grid row below it, and one distant control.
  const boxes = [box(0, 0), box(140, 0), box(280, 0), box(0, 100), box(140, 100), box(280, 100), box(140, 400)];
  assert.equal(spatialNext(boxes, 0, 'right'), 1);
  assert.equal(spatialNext(boxes, 1, 'right'), 2);
  assert.equal(spatialNext(boxes, 2, 'right'), undefined);
  assert.equal(spatialNext(boxes, 0, 'down'), 3);
  assert.equal(spatialNext(boxes, 1, 'down'), 4);
  assert.equal(spatialNext(boxes, 4, 'up'), 1);
  assert.equal(spatialNext(boxes, 3, 'up'), 0);
  // Down from the right column stays in that column rather than drifting left.
  assert.equal(spatialNext(boxes, 2, 'down'), 5);
});

test('alignment beats raw distance, and degenerate or unknown boxes are skipped', () => {
  const boxes = [box(0, 0), box(10, 100, 100, 40), box(300, 60, 100, 40), box(0, 0, 0, 0)];
  // A control almost directly below wins over one slightly closer but far to the right.
  assert.equal(spatialNext(boxes, 0, 'down'), 1);
  assert.equal(spatialNext(boxes, 1, 'right'), 2);
  assert.equal(spatialNext(boxes, 9 as number, 'down'), undefined);
  assert.equal(spatialNext([], 0, 'left'), undefined);
  assert.equal(spatialNext([box(0, 0)], 0, 'left'), undefined);
});

test('the TV shell receives a Back hook and a bundle that can run on the older WebView', () => {
  const source = readFileSync(new URL('../apps/web/src/tv-navigation.ts', import.meta.url), 'utf8');
  assert.match(source, /TkBoxTv/);
  assert.match(source, /dialog\[open\]/);
  const compat = readFileSync(new URL('../apps/web/src/compat.ts', import.meta.url), 'utf8');
  for (const builtin of ['fromEntries', 'replaceAll', 'allSettled', 'AbortSignal.timeout', 'AbortSignal.any', 'queueMicrotask', 'prototype.at'])
    assert.ok(compat.includes(builtin), `${builtin} polyfill`);
  const config = readFileSync(new URL('../apps/web/vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /target: \['chrome61', 'es2018'\]/);
});

test('the Fire TV compatibility layer covers the failures found on WebView 66', () => {
  const compat = readFileSync(new URL('../apps/web/src/compat.ts', import.meta.url), 'utf8');
  // globalThis first, or the bundle never executes; then flat/flatMap for the JSX transform.
  assert.ok(compat.indexOf('globalThis') < compat.indexOf('fromEntries'), 'globalThis must be installed first');
  for (const builtin of ['flat', 'flatMap']) assert.ok(compat.includes(`array.${builtin} ??=`), builtin);
  // The probes must measure layout, because @supports (gap) is true for grid gap on this WebView.
  assert.match(compat, /legacy-flex-gap/);
  assert.match(compat, /legacy-css/);
  assert.match(compat, /getBoundingClientRect/);
  const css = readFileSync(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');
  // Flat selectors only: that WebView has no CSS nesting.
  assert.ok(!/^\.legacy-flex-gap \{[^}]*\{/m.test(css), 'legacy rules must not be nested');
  assert.match(css, /^:root\.legacy-css\{--gutter:/m);
  // The player must not pull the zod schema module into the browser bundle.
  const player = readFileSync(new URL('../apps/web/src/player.tsx', import.meta.url), 'utf8');
  assert.match(player, /contracts\/src\/quality-tiers\.js/);
});
