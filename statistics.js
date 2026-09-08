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
