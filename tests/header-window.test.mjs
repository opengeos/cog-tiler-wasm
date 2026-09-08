import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEADER_TAIL, widenHeaderWindow as widen } from '../header-window.js';

// The layout that motivated this: the 74 MB Europe flood-hazard GeoTIFF from
// GeoLibre#1743, a plain GDAL GeoTIFF whose directory sits at byte 74026916 —
// past the pixel data, where a front-of-file prefix never reaches it.
const IFD = 74026916;

test('does not widen for an offset already inside the window', () => {
  // The bytes were handed over and the parse still failed, so the shortfall is
  // not about coverage. Widening here would refetch the same range forever.
  assert.equal(widen(IFD, IFD + HEADER_TAIL, IFD + 16), null);
  assert.equal(widen(IFD, IFD + HEADER_TAIL, IFD), null);
});

test('grows the end past an offset beyond the window', () => {
  const end = IFD + HEADER_TAIL;
  const want = end + 4096; // a tag array written after the first slice
  assert.deepEqual(widen(IFD, end, want), { start: IFD, end: want + HEADER_TAIL });
});

test('moves the start back for an offset behind the window', () => {
  // A tag array written *before* the directory: the parse asks for an offset
  // the tail never covered, and only reaching further back can satisfy it.
  const want = IFD - 4096;
  assert.deepEqual(widen(IFD, IFD + HEADER_TAIL, want), {
    start: want - HEADER_TAIL,
    end: IFD + HEADER_TAIL,
  });
});

test('never starts a window before the file', () => {
  const { start } = widen(1000, 2000, 8);
  assert.equal(start, 0);
});

test('rejects an offset it cannot act on', () => {
  // No match in the error text leaves `want` NaN; retrying on that would be a
  // guess, so the caller has to surface the original failure instead.
  assert.equal(widen(IFD, IFD + HEADER_TAIL, NaN), null);
  assert.equal(widen(IFD, IFD + HEADER_TAIL, Number('nope')), null);
});

test('honors an explicit pad', () => {
  const end = IFD + HEADER_TAIL;
  assert.deepEqual(widen(IFD, end, end + 10, 64), { start: IFD, end: end + 74 });
});
