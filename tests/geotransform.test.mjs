import assert from 'node:assert/strict';
import { test } from 'node:test';

import { flipRows, geoTransformFromTags, normalizeGeoTransform } from '../geotransform.js';

// The AlphaEarth embedding COGs (source.coop/tge-labs/aef) carry only a
// ModelTransformation, with a positive Y pixel size: row 0 is the south edge.
const AEF_TRANSFORMATION = [10, 0, 0, 172320, 0, 10, 0, 3932160, 0, 0, 0, 0, 0, 0, 0, 1];

test('reads a ModelTransformation raw, keeping a bottom-up sign', () => {
  assert.deepEqual(geoTransformFromTags(AEF_TRANSFORMATION, undefined, undefined), [172320, 10, 0, 3932160, 0, 10]);
});

test('reads ModelTiepoint + ModelPixelScale as north-up', () => {
  assert.deepEqual(geoTransformFromTags(undefined, [0, 0, 0, 500, 1000, 0], [2, 2, 0]), [500, 2, 0, 1000, 0, -2]);
  // A tiepoint anchored at a pixel other than (0, 0).
  assert.deepEqual(geoTransformFromTags(undefined, [10, 5, 0, 520, 990, 0], [2, 2, 0]), [500, 2, 0, 1000, 0, -2]);
  assert.equal(geoTransformFromTags(undefined, undefined, undefined), null);
});

test('normalizes a bottom-up transform to north-up with flipY', () => {
  const { gt, flipY } = normalizeGeoTransform([172320, 10, 0, 3932160, 0, 10], 8192);
  assert.equal(flipY, true);
  // Same footprint: the north edge is the south origin plus the full height.
  assert.deepEqual(gt, [172320, 10, 0, 3932160 + 81920, 0, -10]);
});

test('leaves a north-up transform alone', () => {
  const north = [500, 2, 0, 1000, 0, -2];
  assert.deepEqual(normalizeGeoTransform(Float64Array.from(north), 100), { gt: north, flipY: false });
});

test('rejects missing and rotated transforms', () => {
  assert.throws(() => normalizeGeoTransform([], 10), /no affine georeferencing/);
  assert.throws(() => normalizeGeoTransform(null, 10), /missing geotransform/);
  assert.throws(() => normalizeGeoTransform([0, 1, 0.1, 0, 0, -1], 10), /rotated/);
});

test('flips rows in place', () => {
  const buf = Float64Array.from([1, 2, 3, 4, 5, 6]);
  assert.equal(flipRows(buf, 2, 3), buf);
  assert.deepEqual(Array.from(buf), [5, 6, 3, 4, 1, 2]);
  assert.deepEqual(Array.from(flipRows(Int8Array.from([7, 8]), 2, 1)), [7, 8]);
});

test('a mirrored window read and flip recover the north-up window', () => {
  // A 3x4 bottom-up raster: stored row r holds the values of north-up row 3 - r.
  const w = 3, h = 4;
  const northUp = Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => r * 10 + c));
  const stored = [...northUp].reverse().flat();
  // Ask for north-up rows 1..3 (y = 1, height 2), as _assembleWindow does.
  const y = 1, wh = 2;
  const y0 = h - (y + wh);
  const window = Float64Array.from(stored.slice(y0 * w, (y0 + wh) * w));
  assert.deepEqual(Array.from(flipRows(window, w, wh)), northUp.slice(y, y + wh).flat());
});
