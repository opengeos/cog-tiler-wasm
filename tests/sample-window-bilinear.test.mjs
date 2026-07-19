import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleWindowBilinear as sample } from '../sampling.js';

// GDAL's conventional float sentinel, and the one the PACE chlorophyll COGs
// that surfaced this bug declare.
const ND = -9999;

test('does not blend a numeric nodata sentinel into a neighbouring value', () => {
  // A swath edge: the left column is valid chlorophyll, the right is nodata.
  const buf = Float64Array.from([2.5, ND, 3.0, ND]);
  for (const tx of [0, 0.25, 0.5, 0.75]) {
    const v = sample(buf, 2, 2, tx, 0, ND);
    // Interpolating toward the sentinel used to drag the sample to roughly
    // -2500 / -5000 / -7500. Those match neither the sentinel nor NaN, so the
    // caller's `v === nodata` mask let them through, they clamped to the bottom
    // of the rescale window, and the colormap's first colour (dark navy under
    // `jet`) painted a border along every nodata boundary.
    assert.equal(v, 2.5, `tx=${tx} must hold the valid value, not blend toward nodata`);
  }
});

test('still interpolates normally when the dataset declares no nodata', () => {
  const buf = Float64Array.from([0, 10, 0, 10]);
  assert.equal(sample(buf, 2, 2, 0.5, 0, undefined), 5);
});

test('a sentinel value is not special-cased when no nodata is declared', () => {
  // Without a declared sentinel, -9999 is ordinary data and must interpolate.
  const buf = Float64Array.from([0, -9999, 0, -9999]);
  assert.equal(sample(buf, 2, 2, 0.5, 0, undefined), -4999.5);
});

test('keeps the existing NaN-neighbour nearest fallback', () => {
  const buf = Float64Array.from([2.5, NaN, 3.0, NaN]);
  assert.equal(sample(buf, 2, 2, 0.5, 0, ND), 2.5);
});

test('sampling on a nodata cell stays transparent', () => {
  const buf = Float64Array.from([ND, 2.5, ND, 3.0]);
  assert.ok(Number.isNaN(sample(buf, 2, 2, 0, 0, ND)));
});

test('sampling outside the window stays transparent', () => {
  const buf = Float64Array.from([1, 2, 3, 4]);
  assert.ok(Number.isNaN(sample(buf, 2, 2, -1, 0, ND)));
  assert.ok(Number.isNaN(sample(buf, 2, 2, 0, 2, ND)));
});

test('interpolates across an interior window of valid data', () => {
  const buf = Float64Array.from([0, 10, 20, 30]);
  assert.equal(sample(buf, 2, 2, 0.5, 0, ND), 5);
  assert.equal(sample(buf, 2, 2, 0, 0.5, ND), 10);
  assert.equal(sample(buf, 2, 2, 0.5, 0.5, ND), 15);
});
