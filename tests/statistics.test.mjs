import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeStats, HISTOGRAM_BINS } from '../statistics.js';

test('returns the full histogram resolution expected by raster controls', () => {
  const stats = computeStats(Float64Array.from({ length: 256 }, (_, i) => i), undefined);
  const [counts, edges] = stats.histogram;

  assert.equal(counts.length, HISTOGRAM_BINS);
  assert.equal(edges.length, HISTOGRAM_BINS + 1);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 256);
  assert.ok(counts.every((count) => count === 2));
});

test('categorical values occupy bins that map back to their palette indices', () => {
  const classes = [11, 21, 22, 23, 24, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95];
  const stats = computeStats(Uint8Array.from(classes), undefined);
  const [counts] = stats.histogram;
  const binWidth = (stats.max - stats.min) / counts.length;
  const recovered = new Set();

  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0) continue;
    const low = Math.ceil(stats.min + i * binWidth);
    const high = Math.floor(
      i === counts.length - 1 ? stats.max : stats.min + (i + 1) * binWidth - 1e-9,
    );
    for (let value = low; value <= high; value++) recovered.add(value);
  }

  assert.deepEqual([...recovered], classes);
});

test('excludes nodata and NaN samples from statistics', () => {
  const stats = computeStats(Float64Array.from([1, 2, -9999, NaN]), -9999);

  assert.equal(stats.count, 2);
  assert.equal(stats.valid_percent, 50);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 2);
  assert.equal(stats.histogram[0].reduce((sum, count) => sum + count, 0), 2);
});
