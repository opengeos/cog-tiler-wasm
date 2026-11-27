/** Number of histogram buckets exposed through the TiTiler-style statistics API. */
export const HISTOGRAM_BINS = 128;

/** Min/max/mean/std/count/valid_percent/percentiles/histogram for a band buffer. */
export function computeStats(buf, nodata) {
  let min = Infinity, max = -Infinity, sum = 0, sumsq = 0;
  const valid = [];
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (Number.isNaN(v)) continue;
    if (nodata != null && v === nodata) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumsq += v * v;
    valid.push(v);
  }
  const count = valid.length;
  if (count === 0) return { count: 0, valid_percent: 0 };
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sumsq / count - mean * mean));
  valid.sort((a, b) => a - b);
  const pct = (p) => valid[Math.min(count - 1, Math.floor((p / 100) * count))];
  const span = max - min || 1;
  const histogram = new Array(HISTOGRAM_BINS).fill(0);
  for (const v of valid) {
    let bin = Math.floor(((v - min) / span) * HISTOGRAM_BINS);
    if (bin >= HISTOGRAM_BINS) bin = HISTOGRAM_BINS - 1;
    if (bin < 0) bin = 0;
    histogram[bin]++;
  }
  const edges = Array.from(
    { length: HISTOGRAM_BINS + 1 },
    (_, i) => min + (span * i) / HISTOGRAM_BINS,
  );
  return {
    min, max, mean, std, count,
    valid_percent: (count / buf.length) * 100,
    median: pct(50),
    percentile_2: pct(2),
    percentile_98: pct(98),
    histogram: [histogram, edges],
  };
}

/**
 * Plan a sparse set of source windows to sample statistics from when the
 * coarsest level is too large to read whole.
 *
 * A raster with no overviews has only full resolution to offer, and reading
 * all of it to estimate a stretch either decodes the entire file or trips the
 * read-size ceiling. Instead, take a grid of block-aligned windows spread
 * evenly across the image, at most `budget` pixels in total. Aligning each
 * window to the storage blocks means every tile it touches is decoded once
 * and serves every band.
 *
 * @param {number} width - Level width in pixels.
 * @param {number} height - Level height in pixels.
 * @param {number} blockW - Storage tile width (0 or missing for untiled).
 * @param {number} blockH - Storage tile height (0 or missing for untiled).
 * @param {number} budget - Most pixels to sample across all windows.
 * @returns {Array<[number, number, number, number]>} `[x, y, w, h]` windows.
 */
export function sampleWindows(width, height, blockW, blockH, budget) {
  const clampBlock = (b, extent) => Math.max(1, Math.min(extent, Math.max(64, Math.min(1024, b || 256))));
  const bw = clampBlock(blockW, width);
  const bh = clampBlock(blockH, height);
  const cols = Math.max(1, Math.floor(width / bw));
  const rows = Math.max(1, Math.floor(height / bh));
  const k = Math.max(1, Math.floor(budget / (bw * bh)));
  let gx = cols, gy = rows;
  if (cols * rows > k) {
    gx = Math.max(1, Math.min(cols, Math.round(Math.sqrt((k * cols) / rows))));
    gy = Math.max(1, Math.min(rows, Math.floor(k / gx)));
  }
  const windows = [];
  for (let j = 0; j < gy; j++) {
    const y = Math.floor(((j + 0.5) * rows) / gy) * bh;
    for (let i = 0; i < gx; i++) {
      const x = Math.floor(((i + 0.5) * cols) / gx) * bw;
      windows.push([x, y, Math.min(bw, width - x), Math.min(bh, height - y)]);
    }
  }
  return windows;
}

/**
 * The rescale window a render falls back to when the caller passes none.
 *
 * 8-bit data is already display-ready, so its full type range is the honest
 * default; anything else keeps the historical `[0, 1]` (reflectance-style
 * floats). Without this an 8-bit image rendered before its statistics arrive
 * (or when they fail) clamps every pixel to the top of `[0, 1]` and paints
 * solid white.
 *
 * @param {string} dtype - numpy-style dtype, e.g. `"uint8"`.
 * @returns {[number, number]} The default `[min, max]`.
 */
export function defaultRescale(dtype) {
  if (dtype === "uint8") return [0, 255];
  if (dtype === "int8") return [-128, 127];
  return [0, 1];
}
