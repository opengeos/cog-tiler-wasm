import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRescale, sampleWindows } from '../statistics.js';

test('samples an overview-less raster within the pixel budget', () => {
  // The 4350x6170 NAIP tile (256px blocks, no overviews) that rendered white.
  const budget = 1024 * 1024;
  const windows = sampleWindows(4350, 6170, 256, 256, budget);
  const pixels = windows.reduce((n, [, , w, h]) => n + w * h, 0);
  assert.ok(windows.length > 1, 'spreads over several windows');
  assert.ok(pixels <= budget, `stays within budget (${pixels})`);
  for (const [x, y, w, h] of windows) {
    assert.equal(x % 256, 0, 'block-aligned x');
    assert.equal(y % 256, 0, 'block-aligned y');
    assert.ok(x + w <= 4350 && y + h <= 6170, 'inside the image');
  }
  // Spread across the image, not clustered in one corner.
  const xs = windows.map(([x]) => x), ys = windows.map(([, y]) => y);
  assert.ok(Math.max(...xs) > 4350 / 2 && Math.min(...xs) < 4350 / 2);
  assert.ok(Math.max(...ys) > 6170 / 2 && Math.min(...ys) < 6170 / 2);
});

test('reads every block when the budget covers the image', () => {
  const windows = sampleWindows(512, 300, 256, 256, 1 << 20);
  assert.deepEqual(windows, [[0, 0, 256, 256], [256, 0, 256, 256]]);
});

test('handles untiled (striped) levels with a default block', () => {
  const windows = sampleWindows(10000, 10000, 0, 0, 1 << 20);
  assert.ok(windows.length >= 1);
  assert.ok(windows.every(([, , w, h]) => w === 256 && h === 256));
});

const total = (windows) => windows.reduce((n, [, , w, h]) => n + w * h, 0);

test('keeps a very wide raster within the budget', () => {
  const budget = 1 << 20;
  const windows = sampleWindows(1048576, 256, 256, 256, budget);
  assert.ok(windows.length <= budget / (256 * 256), `window count ${windows.length}`);
  assert.ok(total(windows) <= budget);
});

test('shrinks the window when one block exceeds the budget', () => {
  const budget = 256 * 256;
  const windows = sampleWindows(4350, 6170, 1024, 1024, budget);
  assert.equal(windows.length, 1);
  assert.ok(total(windows) <= budget, `read ${total(windows)} pixels`);
  assert.equal(windows[0][0] % 1024, 0, 'still starts on a block');
});

test('defaults 8-bit data to its full range, everything else to [0, 1]', () => {
  assert.deepEqual(defaultRescale('uint8'), [0, 255]);
  assert.deepEqual(defaultRescale('int8'), [-128, 127]);
  assert.deepEqual(defaultRescale('uint16'), [0, 1]);
  assert.deepEqual(defaultRescale('float32'), [0, 1]);
});
