/**
 * Pure resampling helpers, kept dependency-free so they can be unit-tested
 * without loading the wasm/geotiff stack that `cog-tiler.js` pulls in.
 */

// Bilinear sample of a row-major window at fractional (fc,fr). Returns NaN when
// the cell center is outside the window so out-of-raster pixels stay transparent
// (no edge smear); falls back to nearest at the window edge / next to nodata.
//
// `nodata` is the declared sentinel, when the dataset has one. It must be tested
// here rather than only on the result: interpolating across the boundary blends
// the sentinel into the value, and the product matches neither the sentinel nor
// NaN, so a caller's `v === nodata` check cannot recognize it. With a large
// negative sentinel (-9999 is the GDAL convention) the blend lands far below the
// rescale window, clamps to its low end, and paints a ring of the colormap's
// first color around every nodata boundary -- e.g. a blue border along a swath
// edge under `jet`. Treating a sentinel neighbor exactly like a NaN one keeps
// the boundary pixel at its own valid value instead.
export function sampleWindowBilinear(buf, w, h, fc, fr, nodata) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  if (c0 < 0 || c0 >= w || r0 < 0 || r0 >= h) return NaN;
  const c1 = Math.min(c0 + 1, w - 1), r1 = Math.min(r0 + 1, h - 1);
  // `nodata` is undefined when the dataset declares none; `v === undefined` is
  // false for every numeric sample, so the test costs nothing in that case.
  const isVoid = (v) => Number.isNaN(v) || v === nodata;
  const v00 = buf[r0 * w + c0];
  if (isVoid(v00)) return NaN;
  const v10 = buf[r0 * w + c1], v01 = buf[r1 * w + c0], v11 = buf[r1 * w + c1];
  if (isVoid(v10) || isVoid(v01) || isVoid(v11)) return v00; // edge/nodata
  const tx = fc - c0, ty = fr - r0;
  const top = v00 + (v10 - v00) * tx, bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}
