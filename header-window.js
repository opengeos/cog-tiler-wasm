/**
 * Byte-window arithmetic for reading a TIFF header out of a file you are only
 * range-reading.
 *
 * A Cloud Optimized GeoTIFF keeps every IFD at the front of the file, so a small
 * front prefix has the whole header. A **plain** GeoTIFF -- what GDAL and
 * libtiff write unless asked for a COG -- puts the directory *after* the pixel
 * data, so the header has to be read from a second window further in, and that
 * window sometimes has to grow before it covers every tag array.
 */

/** First read of a file: enough for a typical COG's whole IFD chain. */
export const HEADER_PREFIX = 65536;
/** Stop growing a front-of-file prefix past this; the directory is elsewhere. */
export const MAX_HEADER_PREFIX = 1 << 25;
/** First slice taken around a directory that sits past the prefix. */
export const HEADER_TAIL = 1 << 20;
/** Widest window worth pulling back for a header. */
export const MAX_HEADER_TAIL = 1 << 27;

/**
 * Widen the byte window `[start, end)` so it covers `want`, the offset a header
 * parse said it still needed. Tag arrays usually follow the IFD, but one written
 * before it puts the offset behind the window, so this grows in whichever
 * direction the miss lies.
 *
 * Returns `null` when `want` is not a usable offset or already falls inside the
 * window. Inside means the bytes were handed over and the parse failed for some
 * other reason, or the file simply ended there -- either way a wider fetch
 * cannot help, and retrying would only spin.
 *
 * @param {number} start Inclusive first byte of the current window.
 * @param {number} end Exclusive last byte of the current window.
 * @param {number} want Offset the parser asked for.
 * @param {number} [pad] Extra bytes to take beyond `want`.
 * @returns {{start: number, end: number} | null}
 */
export function widenHeaderWindow(start, end, want, pad = HEADER_TAIL) {
  if (!Number.isFinite(want)) return null;
  if (want < start) return { start: Math.max(0, want - pad), end };
  if (want >= end) return { start, end: want + pad };
  return null;
}
