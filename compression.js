// TIFF compression support for the two decoders cog-tiler can read tiles with.
//
// whitebox-wasm reports a COG's compression as the Debug rendering of its Rust
// enum: a bare variant name for the codecs it knows about ("Deflate", "Jpeg",
// "JpegXl", ...) and `Other(<tiff code>)` for everything else, including LERC
// (34887) and ZSTD (50000). geotiff.js decodes those two (and the classic
// codecs) but not WebP/JPEG-XL, so the two decoders complement each other.
// This module is dependency-free so it can be unit-tested under Node.

/** TIFF compression tag values (`Compression`, tag 259). */
const TIFF_CODE = {
  None: 1,
  Huffman: 2,
  Lzw: 5,
  OldJpeg: 6,
  Jpeg: 7,
  Deflate: 8,
  PackBits: 32773,
  WebP: 50001,
  JpegXl: 50002,
};

/** Codecs whitebox-wasm's streaming decoder decompresses (by variant name). */
const WASM_VARIANTS = new Set(["None", "Lzw", "Deflate", "PackBits", "OldJpeg", "Jpeg", "WebP", "JpegXl"]);

/**
 * Codecs geotiff.js decodes (by TIFF code), per its compression registry.
 * LERC (34887) is registered in every supported geotiff major; direct ZSTD
 * (50000) only from 3.0.0 (2.x pulls `zstddec` in solely for LERC_ZSTD), so
 * callers pass `directZstd: false` when the installed geotiff is 2.x.
 */
const GEOTIFF_CODES = new Set([1, 5, 6, 7, 8, 32946, 32773, 34887, 50000, 50001]);
const ZSTD_CODE = 50000;

/** Human-readable names for TIFF compression codes seen in the wild. */
const CODE_NAMES = new Map([
  [1, "None"],
  [2, "CCITT Huffman"],
  [3, "CCITT T.4"],
  [4, "CCITT T.6"],
  [5, "LZW"],
  [6, "JPEG (old-style)"],
  [7, "JPEG"],
  [8, "Deflate"],
  [32773, "PackBits"],
  [32946, "Deflate"],
  [33003, "JPEG 2000 (Aperio YCbCr)"],
  [33005, "JPEG 2000 (Aperio RGB)"],
  [34661, "JBIG"],
  [34712, "JPEG 2000"],
  [34887, "LERC"],
  [34925, "LZMA"],
  [50000, "ZSTD"],
  [50001, "WebP"],
  [50002, "JPEG-XL"],
  [52546, "JPEG-XL (DNG 1.7 code)"],
]);

/**
 * Parse whitebox-wasm's compression string into `{ code, name }`.
 * `code` is the TIFF tag value (or null when the string is unrecognized) and
 * `name` a human-readable codec label.
 */
export function parseCompression(compression) {
  const s = String(compression ?? "").trim();
  const other = s.match(/^Other\((\d+)\)$/);
  if (other) {
    const code = Number(other[1]);
    return { code, name: CODE_NAMES.get(code) ?? `TIFF compression ${code}` };
  }
  if (Object.prototype.hasOwnProperty.call(TIFF_CODE, s)) {
    const code = TIFF_CODE[s];
    return { code, name: CODE_NAMES.get(code) ?? s };
  }
  return { code: null, name: s || "unknown" };
}

/**
 * Which decoder can read tiles in this compression: `"wasm"` (whitebox-wasm,
 * the default streaming path), `"geotiff"` (geotiff.js, used for codecs the
 * wasm decoder lacks such as LERC and ZSTD), or `null` when neither can.
 * `directZstd` says whether the installed geotiff.js registers TIFF code
 * 50000 (3.x does, 2.x does not).
 */
export function compressionDecoder(compression, { directZstd = true } = {}) {
  const s = String(compression ?? "").trim();
  if (WASM_VARIANTS.has(s)) return "wasm";
  const { code } = parseCompression(s);
  if (code === ZSTD_CODE && !directZstd) return null;
  if (code !== null && GEOTIFF_CODES.has(code)) return "geotiff";
  return null;
}

/** The error message `openCog` rejects with for a codec no decoder handles. */
export function unsupportedCompressionMessage(compression, { directZstd = true } = {}) {
  const { code, name } = parseCompression(compression);
  const label = code === null || !CODE_NAMES.has(code) ? name : `${name} (TIFF compression ${code})`;
  if (code === ZSTD_CODE && !directZstd) {
    return `Unsupported compression: ${label}. Decoding ZSTD tiles needs geotiff.js 3.x; this app ships an older geotiff.js.`;
  }
  return `Unsupported compression: ${label}. This COG cannot be decoded in the browser; re-encode it with DEFLATE, ZSTD, LERC, LZW, or WebP.`;
}
