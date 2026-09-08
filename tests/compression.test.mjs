import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compressionDecoder,
  parseCompression,
  unsupportedCompressionMessage,
} from '../compression.js';

test('whitebox-decodable variants stay on the wasm path', () => {
  for (const v of ['None', 'Lzw', 'Deflate', 'PackBits', 'OldJpeg', 'Jpeg', 'WebP', 'JpegXl']) {
    assert.equal(compressionDecoder(v), 'wasm', v);
  }
});

test('LERC and ZSTD (reported as Other(code)) go through geotiff.js', () => {
  // whitebox-wasm renders unknown codecs with Rust's Debug output, so the
  // string is literally "Other(34887)" rather than a name.
  assert.equal(compressionDecoder('Other(34887)'), 'geotiff'); // LERC (all AddCompression modes)
  assert.equal(compressionDecoder('Other(50000)'), 'geotiff'); // ZSTD
  assert.equal(compressionDecoder('Other(32946)'), 'geotiff'); // old Deflate code
});

test('codecs neither decoder handles resolve to null', () => {
  assert.equal(compressionDecoder('Other(34925)'), null); // LZMA
  assert.equal(compressionDecoder('Other(34712)'), null); // JPEG 2000
  assert.equal(compressionDecoder('Huffman'), null); // whitebox names it but cannot decode it
  assert.equal(compressionDecoder(''), null);
  assert.equal(compressionDecoder(undefined), null);
});

test('parseCompression maps names and Other(code) strings to TIFF codes', () => {
  assert.deepEqual(parseCompression('Jpeg'), { code: 7, name: 'JPEG' });
  assert.deepEqual(parseCompression('JpegXl'), { code: 50002, name: 'JPEG-XL' });
  assert.deepEqual(parseCompression('Other(34887)'), { code: 34887, name: 'LERC' });
  assert.deepEqual(parseCompression('Other(12345)'), { code: 12345, name: 'TIFF compression 12345' });
  assert.deepEqual(parseCompression('Bogus'), { code: null, name: 'Bogus' });
});

test('the unsupported message names the codec and its TIFF code', () => {
  const msg = unsupportedCompressionMessage('Other(34925)');
  assert.match(msg, /^Unsupported compression: LZMA \(TIFF compression 34925\)\./);
  assert.match(unsupportedCompressionMessage('Huffman'), /CCITT Huffman \(TIFF compression 2\)/);
  assert.match(unsupportedCompressionMessage('Bogus'), /^Unsupported compression: Bogus\./);
  // An unnamed code is not repeated twice in the label.
  assert.match(unsupportedCompressionMessage('Other(12345)'), /^Unsupported compression: TIFF compression 12345\./);
  // GDAL >= 3.11 writes JPEG-XL with the final DNG 1.7 code, which whitebox-wasm
  // does not map yet (it only knows 50002).
  assert.match(unsupportedCompressionMessage('Other(52546)'), /JPEG-XL \(DNG 1.7 code\) \(TIFF compression 52546\)/);
});

test('direct ZSTD is only routed to geotiff.js when the installed major registers it', () => {
  // geotiff 2.x has zstddec for LERC_ZSTD only; TIFF code 50000 arrived in 3.0.0.
  assert.equal(compressionDecoder('Other(50000)', { directZstd: false }), null);
  assert.equal(compressionDecoder('Other(50000)', { directZstd: true }), 'geotiff');
  assert.equal(compressionDecoder('Other(34887)', { directZstd: false }), 'geotiff'); // LERC unaffected
  assert.match(unsupportedCompressionMessage('Other(50000)', { directZstd: false }), /needs geotiff\.js 3\.x/);
  assert.doesNotMatch(unsupportedCompressionMessage('Other(34925)', { directZstd: false }), /geotiff/);
});
