// A mask-aware LERC decoder for geotiff.js.
//
// geotiff.js decodes LERC tiles (TIFF compression 34887, all three GDAL
// `LERC` / `LERC_DEFLATE` / `LERC_ZSTD` modes) but discards the LERC validity
// mask, so every pixel GDAL wrote as nodata comes back as 0 and paints as data.
// This decoder re-applies the mask: masked pixels become the dataset's
// GDAL_NODATA value, or NaN for floating-point samples with no declared nodata,
// which is how the rest of cog-tiler represents "no value". Integer rasters
// without a declared nodata keep 0 (GDAL does the same on read).
//
// The decoder is registered lazily via geotiff's `addDecoder`, replacing the
// built-in one. It needs the `lerc`, `pako`, and `zstddec` packages that
// geotiff.js itself depends on; when they cannot be resolved (an unusual
// install layout) registration is skipped and the built-in decoder stays in
// place, so LERC still renders, only without the mask.

/** TIFF compression code for LERC. */
export const LERC_COMPRESSION = 34887;

/** Index into the LercParameters tag (50674). */
const LERC_ADD_COMPRESSION = 1;
const ADD_NONE = 0, ADD_DEFLATE = 1, ADD_ZSTD = 2;

/**
 * The value masked-out LERC pixels are filled with. `nodataTag` is the raw
 * GDAL_NODATA string (may be undefined); `pixels` the decoded typed array.
 * Returns `undefined` when no fill can be represented (an integer raster with
 * no declared nodata, or a nodata outside the type's range).
 */
export function lercMaskFillValue(nodataTag, pixels) {
  const isFloat = pixels instanceof Float32Array || pixels instanceof Float64Array;
  if (nodataTag != null && String(nodataTag).trim() !== "") {
    const v = Number(String(nodataTag).trim());
    if (Number.isNaN(v)) return isFloat ? NaN : undefined;
    if (!isFloat) {
      // Typed arrays wrap out-of-range integers silently; only fill when the
      // declared nodata round-trips through the array's element type.
      const probe = new pixels.constructor(1);
      probe[0] = v;
      if (probe[0] !== v) return undefined;
    }
    return v;
  }
  return isFloat ? NaN : undefined;
}

/**
 * Write `fill` into every masked-out pixel of `pixels` in place. `mask` is
 * lerc's `Uint8Array(width * height)` (1 = valid) or null when every pixel is
 * valid; `dims` is the number of interleaved values per pixel.
 */
export function applyLercMask(pixels, mask, dims, fill) {
  if (!mask || fill === undefined) return pixels;
  const n = mask.length;
  if (dims <= 1) {
    for (let i = 0; i < n; i++) if (mask[i] === 0) pixels[i] = fill;
    return pixels;
  }
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 0) continue;
    const base = i * dims;
    for (let d = 0; d < dims; d++) pixels[base + d] = fill;
  }
  return pixels;
}

let registration = null;
let lercWasmUrl = null;

/**
 * Tell the decoder where lerc's `lerc-wasm.wasm` is served from. lerc locates
 * it with `new URL("lerc-wasm.wasm", import.meta.url)`, which bundlers that
 * hash assets or pre-bundle dependencies do not always rewrite (Vite serves
 * index.html for the stale path and the wasm compile fails). Hosts can pass
 * the URL their bundler resolves for the asset, e.g. Vite's
 * `import lercWasmUrl from "lerc/lerc-wasm.wasm?url"`. Call it before the
 * first LERC COG is opened; `null` restores lerc's own resolution.
 */
export function configureLercDecoder({ wasmUrl } = {}) {
  lercWasmUrl = wasmUrl == null ? null : String(wasmUrl);
}

/** The lerc `load()` options for the configured wasm location. */
export function lercLoadOptions() {
  return lercWasmUrl ? { locateFile: () => lercWasmUrl } : {};
}

/**
 * Register the mask-aware LERC decoder with geotiff.js (idempotent). Resolves
 * `true` when registered, `false` when the codec packages could not be loaded
 * and geotiff's built-in decoder is left in place.
 */
export function registerMaskedLercDecoder() {
  registration ??= (async () => {
    let geotiff, Lerc, pako, zstddec;
    try {
      [geotiff, Lerc, pako, zstddec] = await Promise.all([
        import("geotiff"),
        import("lerc"),
        import("pako"),
        import("zstddec"),
      ]);
    } catch (e) {
      console.warn("[cog-tiler] LERC mask support unavailable; masked pixels decode as 0:", e);
      return false;
    }
    const { BaseDecoder, addDecoder } = geotiff;
    if (typeof addDecoder !== "function" || typeof BaseDecoder !== "function") return false;
    const lerc = Lerc.default ?? Lerc;
    const inflate = pako.inflate ?? pako.default?.inflate;
    const ZSTDDecoder = zstddec.ZSTDDecoder ?? zstddec.default?.ZSTDDecoder;
    if (typeof lerc.decode !== "function" || typeof inflate !== "function" || !ZSTDDecoder) return false;
    const zstd = new ZSTDDecoder();
    let ready = null;
    const init = () => (ready ??= Promise.all([lerc.load?.(lercLoadOptions()), zstd.init()]));

    class MaskedLercDecoder extends BaseDecoder {
      async decodeBlock(buffer) {
        await init();
        const { LercParameters, planarConfiguration, nodata } = this.parameters;
        const add = LercParameters?.[LERC_ADD_COMPRESSION] ?? ADD_NONE;
        let bytes = new Uint8Array(buffer);
        if (add === ADD_DEFLATE) bytes = inflate(bytes);
        else if (add === ADD_ZSTD) bytes = zstd.decode(bytes);
        else if (add !== ADD_NONE) {
          throw new Error(`Unsupported LERC additional compression method identifier: ${add}`);
        }
        const result = lerc.decode(bytes, { returnPixelInterleavedDims: planarConfiguration === 1 });
        const pixels = result.pixels[0];
        const dims = planarConfiguration === 1 ? Math.max(1, result.dimCount ?? 1) : 1;
        const fill = lercMaskFillValue(nodata, pixels);
        if (result.validPixelCount === 0) {
          // A tile with no valid pixel carries no mask at all; lerc hands back
          // zeros for it, so fill the whole block rather than trust the mask.
          if (fill !== undefined) pixels.fill(fill);
        } else {
          applyLercMask(pixels, result.mask, dims, fill);
        }
        return pixels.buffer;
      }
    }

    const readTag = async (fd, name) =>
      fd.hasTag?.(name) === false ? undefined : fd.loadValue ? await fd.loadValue(name) : fd[name];
    addDecoder(
      LERC_COMPRESSION,
      () => Promise.resolve(MaskedLercDecoder),
      async (fd) => {
        const tiled = !(await readTag(fd, "StripOffsets"));
        return {
          tileWidth: await readTag(fd, tiled ? "TileWidth" : "ImageWidth"),
          tileHeight: tiled
            ? await readTag(fd, "TileLength")
            : (await readTag(fd, "RowsPerStrip")) || (await readTag(fd, "ImageLength")),
          planarConfiguration: await readTag(fd, "PlanarConfiguration"),
          bitsPerSample: await readTag(fd, "BitsPerSample"),
          predictor: (await readTag(fd, "Predictor")) || 1,
          LercParameters: await readTag(fd, "LercParameters"),
          nodata: await readTag(fd, "GDAL_NODATA"),
        };
      },
      false, // decode on the main thread: workers would not see this registration
    );
    return true;
  })();
  return registration;
}
