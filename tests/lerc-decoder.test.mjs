import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyLercMask,
  configureLercDecoder,
  lercLoadOptions,
  lercMaskFillValue,
} from '../lerc-decoder.js';

test('float rasters fill masked pixels with NaN when no nodata is declared', () => {
  assert.ok(Number.isNaN(lercMaskFillValue(undefined, new Float32Array(1))));
  assert.ok(Number.isNaN(lercMaskFillValue('', new Float64Array(1))));
  // GDAL writes NaN nodata as the string "nan".
  assert.ok(Number.isNaN(lercMaskFillValue('nan', new Float64Array(1))));
});

test('a declared numeric nodata is used verbatim', () => {
  assert.equal(lercMaskFillValue('-9999', new Float32Array(1)), -9999);
  assert.equal(lercMaskFillValue(' 0 ', new Uint8Array(1)), 0);
  assert.equal(lercMaskFillValue('255', new Uint8Array(1)), 255);
  assert.equal(lercMaskFillValue('-32768', new Int16Array(1)), -32768);
});

test('integer rasters without a representable nodata are left alone', () => {
  assert.equal(lercMaskFillValue(undefined, new Uint8Array(1)), undefined);
  assert.equal(lercMaskFillValue('nan', new Int16Array(1)), undefined);
  assert.equal(lercMaskFillValue('-1', new Uint8Array(1)), undefined); // wraps to 255
  assert.equal(lercMaskFillValue('70000', new Uint16Array(1)), undefined);
});

test('applyLercMask writes the fill into masked pixels only', () => {
  const px = Float32Array.from([1, 2, 3, 4]);
  applyLercMask(px, Uint8Array.from([1, 0, 1, 0]), 1, NaN);
  assert.equal(px[0], 1);
  assert.ok(Number.isNaN(px[1]));
  assert.equal(px[2], 3);
  assert.ok(Number.isNaN(px[3]));
});

test('applyLercMask handles pixel-interleaved multi-band blocks', () => {
  // Two pixels, three bands each; the second pixel is masked.
  const px = Int16Array.from([10, 20, 30, 40, 50, 60]);
  applyLercMask(px, Uint8Array.from([1, 0]), 3, -1);
  assert.deepEqual(Array.from(px), [10, 20, 30, -1, -1, -1]);
});

test('applyLercMask is a no-op without a mask or a fill value', () => {
  const px = Float32Array.from([1, 2]);
  assert.equal(applyLercMask(px, null, 1, NaN), px);
  assert.deepEqual(Array.from(px), [1, 2]);
  applyLercMask(px, Uint8Array.from([0, 0]), 1, undefined);
  assert.deepEqual(Array.from(px), [1, 2]);
});

test('configureLercDecoder routes lerc to the host-provided wasm URL', () => {
  assert.deepEqual(lercLoadOptions(), {});
  configureLercDecoder({ wasmUrl: '/assets/lerc-wasm-abc123.wasm' });
  assert.equal(lercLoadOptions().locateFile('lerc-wasm.wasm', '/wrong/'), '/assets/lerc-wasm-abc123.wasm');
  configureLercDecoder({ wasmUrl: new URL('https://cdn.example.com/lerc-wasm.wasm') });
  assert.equal(lercLoadOptions().locateFile(), 'https://cdn.example.com/lerc-wasm.wasm');
  configureLercDecoder();
  assert.deepEqual(lercLoadOptions(), {});
});
