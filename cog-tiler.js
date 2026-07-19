/**
 * cog-tiler-wasm - reusable, client-side COG tiling for MapLibre/Leaflet.
 *
 * Wraps whitebox-wasm (`CogStream`: pure-Rust COG decode + HTTP range reads) and
 * this repo's `CogTiler` (Web Mercator math + rescale/colormap render) into a
 * tiler that:
 *   - serves EPSG:3857 COGs directly (fast affine path), and
 *   - warps any other projected / EPSG:4326 COG to Web Mercator on the fly,
 *     rendering paletted (categorical) bands through their color table.
 *
 * Dependencies are bare module specifiers - provide them through your bundler
 * (as peer dependencies) or an import map:
 *   whitebox-wasm, proj4, geotiff, geotiff-geokeys-to-proj4
 * The wasm package (`cog_tiler_wasm.js` + `_bg.wasm`) must sit next to this file.
 *
 * Usage:
 *   import { init, openCog, registerCogProtocol } from "./cog-tiler.js";
 *   await init();
 *   const src = await openCog(url);
 *   registerCogProtocol(maplibregl, "cog", () => ({ source: src, render: { min, max, colormap } }));
 *   map.addSource("cog", { type: "raster", tiles: ["cog://{z}/{x}/{y}"], tileSize: 256 });
 */
import initWhitebox, { CogStream } from "whitebox-wasm";
import initTiler, { colorize, colormap_names } from "./cog_tiler_wasm.js";
import proj4 from "proj4";
import * as GeoTIFF from "geotiff";
import geokeysToProj4 from "geotiff-geokeys-to-proj4";
import { sampleWindowBilinear } from "./sampling.js";

const OS = 20037508.342789244; // Web Mercator half-extent (m)
const TILE = 256; // output tile size (px)
const NG = 16; // warp grid cells per axis
const MAX_CACHED_TILES = 256; // ~0.5 MB each at 256x256 f64

proj4.defs(
  "EPSG:3857",
  "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs",
);

let _ready = null;
/** Initialize the wasm modules (idempotent). Resolve this before `openCog`. */
export function init() {
  if (!_ready) _ready = Promise.all([initWhitebox(), initTiler()]);
  return _ready;
}

/** EPSG:3857 bounds [minx,miny,maxx,maxy] of an XYZ tile. */
function tileBounds3857(z, x, y) {
  const span = (2 * OS) / 2 ** z;
  return [-OS + x * span, OS - (y + 1) * span, -OS + (x + 1) * span, OS - y * span];
}

const rangeFetcher = (url) => (a, b) =>
  fetch(url, { headers: { Range: `bytes=${a}-${b}` } })
    .then((r) => r.arrayBuffer())
    .then((b) => new Uint8Array(b));

/** Map a level descriptor's sample format + bit depth to a numpy-style dtype. */
function dtypeOf(lv) {
  const b = lv.bits_per_sample;
  const f = (lv.sample_format || "").toLowerCase();
  if (f.includes("float") || f.includes("ieee")) return "float" + b;
  if (f === "uint" || f.includes("unsigned")) return "uint" + b;
  if (f === "int" || f.includes("signed")) return "int" + b;
  return (f || "uint") + b;
}

/** Min/max/mean/std/count/valid_percent/percentiles/histogram for a band buffer. */
function computeStats(buf, nodata) {
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
  const bins = 10, span = max - min || 1, hist = new Array(bins).fill(0);
  for (const v of valid) {
    let k = Math.floor(((v - min) / span) * bins);
    if (k >= bins) k = bins - 1;
    if (k < 0) k = 0;
    hist[k]++;
  }
  const edges = Array.from({ length: bins + 1 }, (_, i) => min + (span * i) / bins);
  return {
    min, max, mean, std, count,
    valid_percent: (count / buf.length) * 100,
    median: pct(50),
    percentile_2: pct(2),
    percentile_98: pct(98),
    histogram: [hist, edges],
  };
}

/** Transfer curve for a rescaled value in 0..1: stretch then gamma (mirrors the
 *  Rust `transfer`; reversal is colormap-only so it's not applied to RGB). */
function transferCurve(t, stretch, gamma) {
  if (stretch === "sqrt") t = Math.sqrt(t);
  else if (stretch === "log") t = Math.log(1 + 99 * t) / Math.log(100);
  if (Math.abs(gamma - 1) > 1e-9) t = Math.pow(t, 1 / Math.max(gamma, 1e-4));
  return t;
}

/** Normalize render rescale options to a list of [min,max] pairs (per band). */
function rescaleList(opts) {
  if (Array.isArray(opts.rescale) && opts.rescale.length) {
    return Array.isArray(opts.rescale[0]) ? opts.rescale : [opts.rescale];
  }
  return [[opts.min ?? 0, opts.max ?? 1]];
}

/** WGS84 [w,s,e,n] -> EPSG:3857 [minx,miny,maxx,maxy]. */
function mercExtentFromLonLat([w, s, e, n]) {
  const t = proj4("EPSG:4326", "EPSG:3857");
  const [minx, miny] = t.forward([w, s]);
  const [maxx, maxy] = t.forward([e, n]);
  return [minx, miny, maxx, maxy];
}

/** Output [w,h] honoring explicit width/height, else fitting `maxSize` to aspect.
 *  width/height/maxSize are user inputs, so validate them as positive integers
 *  before they reach typed-array / canvas constructors. */
function fitSize(extW, extH, maxSize, width, height) {
  const posInt = (v, name) => {
    if (v == null) return undefined;
    const n = Math.floor(v);
    if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  const w = posInt(width, "width"), h = posInt(height, "height"), max = posInt(maxSize, "maxSize") ?? 1024;
  const ar = extW / extH || 1;
  if (w && h) return [w, h];
  if (w) return [w, Math.max(1, Math.round(w / ar))];
  if (h) return [Math.max(1, Math.round(h * ar)), h];
  return ar >= 1
    ? [max, Math.max(1, Math.round(max / ar))]
    : [Math.max(1, Math.round(max * ar)), max];
}

/**
 * Read a TIFF tag from a geotiff.js image across major versions. geotiff v2
 * exposes tags as direct `fileDirectory` properties; v3 defers them behind
 * `fileDirectory.loadValue()` (large arrays such as ColorMap are not actualized
 * eagerly), so a direct property read returns undefined there. Returns the tag
 * value, or undefined when the tag is absent.
 */
async function readTiffTag(img, name) {
  const fd = img.fileDirectory;
  if (fd && fd[name] !== undefined) return fd[name]; // geotiff v2
  if (typeof fd?.loadValue === "function") {
    // geotiff v3: skip the load when the tag is absent so loadValue doesn't throw.
    if (typeof fd.hasTag === "function" && !fd.hasTag(name)) return undefined;
    return fd.loadValue(name);
  }
  return undefined;
}

// Root keyword of a projected WKT (OGC `PROJCS`/`PROJCRS`, including the ESRI PE
// string flavour ArcGIS writes). Matching the keyword lets us slice off any
// `ESRI PE String = ` prefix.
const PROJECTED_WKT_ROOT = /\b(?:PROJCS|PROJCRS)\s*\[/i;

/** Pull a projected WKT/ESRI-PE-string definition out of a GeoTIFF citation geo
 * key, if one is present. Returns the WKT from the `PROJCS`/`PROJCRS` keyword
 * onward, or `null`. */
function projectedWktFromGeoKeys(geoKeys) {
  for (const citation of [geoKeys.PCSCitationGeoKey, geoKeys.GTCitationGeoKey]) {
    if (typeof citation !== "string") continue;
    const match = PROJECTED_WKT_ROOT.exec(citation);
    if (match) return citation.slice(match.index);
  }
  return null;
}

/**
 * Resolve the source CRS as a proj4 definition (a `+proj=...` string or a WKT).
 *
 * `geotiff-geokeys-to-proj4` builds the def from the numeric geo keys, but for a
 * projection it cannot express (no `ProjCoordTransGeoKey`, e.g. ESRI world
 * projections such as Mollweide/54009 written only as an `ESRI PE String`) it
 * silently falls back to the bare geographic CRS (`+proj=longlat`, `isGCS`).
 * That would place a projected raster at lon/lat where its metre coordinates
 * are, so it never draws. When the keys carry a projected WKT, prefer it; proj4
 * parses the ESRI/OGC WKT directly.
 */
function sourceCrsDef(geoKeys) {
  const result = geokeysToProj4.toProj4(geoKeys);
  if (result.isGCS) {
    const wkt = projectedWktFromGeoKeys(geoKeys);
    if (wkt) return wkt;
  }
  return result.proj4;
}

/** Build a 256-entry RGBA palette from a TIFF ColorMap (16-bit R,G,B blocks). */
function buildPalette(colorMap) {
  if (!colorMap) return null;
  const n = colorMap.length / 3;
  const pal = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256 && i < n; i++) {
    pal[i * 4] = colorMap[i] >> 8;
    pal[i * 4 + 1] = colorMap[n + i] >> 8;
    pal[i * 4 + 2] = colorMap[2 * n + i] >> 8;
    pal[i * 4 + 3] = 255;
  }
  return pal;
}

function bilin(v00, v10, v01, v11, tx, ty) {
  if (!isFinite(v00) || !isFinite(v10) || !isFinite(v01) || !isFinite(v11)) {
    return isFinite(v00) ? v00 : NaN; // near projection edges
  }
  const top = v00 + (v10 - v00) * tx, bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

// Build a byte reader from a URL string, a Blob/File, or an in-memory source
// (ArrayBuffer, Uint8Array). `range(a,b)` yields bytes [a..b]; `openTiff()`
// returns a geotiff.js GeoTIFF for reading the CRS / color table from the header.
async function makeReader(source) {
  if (typeof source === "string") {
    return { label: source, range: rangeFetcher(source), openTiff: () => GeoTIFF.fromUrl(source) };
  }
  // Blob / File: read on demand via ranged slices, mirroring the URL path.
  // Slurping the whole file (blob.arrayBuffer()) throws NotReadableError in
  // Chromium for multi-GB rasters (e.g. the 7 GB GEBCO GeoTIFF) — and only the
  // header prefix and the requested tiles are ever needed.
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return {
      label: source.name || "(local file)",
      range: async (a, b) => new Uint8Array(await source.slice(a, b + 1).arrayBuffer()),
      openTiff: () => GeoTIFF.fromBlob(source),
    };
  }
  let bytes;
  if (source instanceof Uint8Array) bytes = source;
  else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (source && typeof source.arrayBuffer === "function") {
    bytes = new Uint8Array(await source.arrayBuffer()); // exotic Blob-likes
  } else {
    throw new Error("openCog: expected a URL string, ArrayBuffer, Uint8Array, or Blob");
  }
  // Reuse the underlying buffer when the view spans it exactly; only copy for a
  // partial view (avoids duplicating a large raster in memory).
  const ab =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    label: source.name || "(local file)",
    range: (a, b) => Promise.resolve(bytes.subarray(a, Math.min(b + 1, bytes.length))),
    openTiff: () => GeoTIFF.fromArrayBuffer(ab),
  };
}

/**
 * Open a COG and return a {@link CogSource} ready to render XYZ tiles. `source`
 * is a URL string (read via HTTP range), a Blob / File (read via ranged slices,
 * so multi-GB local rasters never load whole), or in-memory bytes. Detects
 * EPSG:3857 (fast path) vs. any other CRS (warp path), reading the source
 * projection + color table from the GeoTIFF header (which whitebox-wasm 0.4.0
 * does not expose).
 */
export async function openCog(source) {
  await init();
  const { range, openTiff, label } = await makeReader(source);
  // Parse the COG header; grow the prefix and retry for large COGs whose IFDs
  // exceed 64 KB (many overviews / huge tile-offset arrays).
  let stream;
  for (let len = 65536; ; len *= 8) {
    try {
      stream = new CogStream(await range(0, len - 1));
      break;
    } catch (e) {
      if (len >= 1 << 25) throw e; // give up past ~32 MB
    }
  }
  const gt = stream.geo_transform(); // [x0, px_w, rot, y0, rot, px_h]
  const levels = JSON.parse(stream.levels_json());
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error("levels_json() returned no levels");
  }
  // Open the GeoTIFF with geotiff.js when we need the CRS (non-3857) or to check
  // the planar config (multi-band). whitebox-wasm's streaming decoder is
  // chunky-only, so planar (INTERLEAVE=BAND) multi-band COGs are read per-band
  // through geotiff.js instead (see _assembleWindow / point).
  const multiBand = levels[0].bands > 1;
  let tiff = null, img = null, planar = false;
  if (stream.epsg !== 3857 || multiBand) {
    tiff = await openTiff();
    img = await tiff.getImage();
    planar = multiBand && (await readTiffTag(img, "PlanarConfiguration")) === 2;
  }
  const base = { url: label, range, stream, levels, gt, nodata: stream.nodata, tiff, planar };

  if (stream.epsg === 3857) {
    return new CogSource({
      ...base,
      mode: "3857",
      crsLabel: "EPSG:3857",
      palette: null,
      toSource: { forward: (c) => c }, // identity: mercator meters == source meters
      boundsLonLat: Array.from(stream.bounds_lonlat()),
    });
  }

  // Warp path: read the real source CRS + optional palette from the header.
  const srcDef = sourceCrsDef(img.getGeoKeys());
  if (!srcDef) throw new Error("could not derive source CRS from GeoTIFF geokeys");
  const toSource = proj4("EPSG:3857", srcDef); // forward: mercator -> source
  const toLonLat = proj4(srcDef, "EPSG:4326"); // forward: source -> lon/lat
  const palette = buildPalette(await readTiffTag(img, "ColorMap"));

  // fitBounds bounds: transform the source corners to lon/lat.
  const fw = levels[0].width, fh = levels[0].height;
  const corners = [
    [gt[0], gt[3]],
    [gt[0] + fw * gt[1], gt[3]],
    [gt[0], gt[3] + fh * gt[5]],
    [gt[0] + fw * gt[1], gt[3] + fh * gt[5]],
  ].map((c) => toLonLat.forward(c));
  const lons = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);

  return new CogSource({
    ...base,
    mode: "warp",
    toSource,
    palette,
    boundsLonLat: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    crsLabel: "warped from " + crsLabelForDef(srcDef),
  });
}

/** A short label for a proj4 def: the `+proj=...` token, or the WKT's CRS name,
 * falling back to "custom CRS". */
function crsLabelForDef(srcDef) {
  const projTag = srcDef.match(/\+proj=\w+/);
  if (projTag) return projTag[0];
  const wktName = srcDef.match(/\b(?:PROJCS|PROJCRS)\s*\[\s*"([^"]+)"/i);
  if (wktName) return wktName[1];
  return "custom CRS";
}

/** A single opened COG. Renders XYZ tiles via {@link CogSource#renderTileRGBA}. */
export class CogSource {
  constructor(fields) {
    Object.assign(this, fields);
    // Decoded source tiles keyed by "level/col/row"; caching the decode lets
    // panning/zooming reuse overlapping tiles instead of re-fetching/decoding.
    this.tileCache = new Map();
  }

  /** True when the band is paletted (categorical) and rendered via its table. */
  get hasPalette() {
    return !!this.palette;
  }

  /** Render an XYZ tile to a 256x256 RGBA buffer, or null if empty. */
  async renderTileRGBA(z, x, y, opts = {}) {
    return this._renderExtent(tileBounds3857(z, x, y), TILE, TILE, opts);
  }

  /** Render an XYZ tile to PNG bytes (empty `Uint8Array` for a blank tile). */
  async renderTilePNG(z, x, y, opts = {}) {
    const rgba = await this.renderTileRGBA(z, x, y, opts);
    return rgba ? rgbaToPng(rgba) : new Uint8Array();
  }

  // --- internals ------------------------------------------------------------

  _getTile(level, t) {
    const key = level + "/" + t.col + "/" + t.row;
    let p = this.tileCache.get(key);
    if (!p) {
      p = this.range(t.offset, t.offset + t.length - 1)
        .then((bytes) => this.stream.decode_tile_f64(level, bytes))
        .catch((err) => {
          this.tileCache.delete(key); // don't cache failures; allow retry
          throw err;
        });
      this.tileCache.set(key, p);
      if (this.tileCache.size > MAX_CACHED_TILES) {
        this.tileCache.delete(this.tileCache.keys().next().value); // evict oldest
      }
    }
    return p;
  }

  /** geotiff.js image for an overview level (cached). Used for planar reads. */
  _tiffImage(level) {
    if (!this._imgs) this._imgs = new Map();
    let p = this._imgs.get(level);
    if (!p) {
      p = this.tiff.getImage(level);
      this._imgs.set(level, p);
    }
    return p;
  }

  // Fetch + decode band `band` (0-based) over a level pixel window into a
  // row-major buffer. Chunky COGs go through whitebox (cached, NaN for gaps);
  // planar (INTERLEAVE=BAND) COGs are read per-band via geotiff.js, which
  // whitebox's chunky-only streaming decoder can't address.
  async _assembleWindow(level, x, y, w, h, band = 0) {
    if (this.planar) {
      const img = await this._tiffImage(level);
      const rasters = await img.readRasters({ window: [x, y, x + w, y + h], samples: [band] });
      return rasters[0]; // typed array, length w*h, row-major
    }
    const lv = this.levels[level];
    const tiles = JSON.parse(this.stream.tiles_for_window(level, x, y, w, h));
    const decoded = await Promise.all(tiles.map((t) => this._getTile(level, t)));
    const buf = new Float64Array(w * h).fill(NaN);
    const tw = lv.tile_width, th = lv.tile_height, bands = lv.bands;
    tiles.forEach((t, i) => {
      const px = decoded[i];
      const tx0 = t.col * tw, ty0 = t.row * th;
      for (let ry = 0; ry < th; ry++) {
        const oy = ty0 + ry - y;
        if (oy < 0 || oy >= h) continue;
        for (let rx = 0; rx < tw; rx++) {
          const ox = tx0 + rx - x;
          if (ox < 0 || ox >= w) continue;
          buf[oy * w + ox] = px[(ry * tw + rx) * bands + band];
        }
      }
    });
    return buf;
  }

  // Choose the overview whose source resolution is the coarsest still finer than
  // `srcRes` (m/px), avoiding upsampling; finest level otherwise.
  _chooseLevel(srcRes) {
    const baseRes = Math.abs(this.gt[1]), fw = this.levels[0].width;
    let best = -1, bestRes = 0, finest = 0, finestRes = Infinity;
    this.levels.forEach((lv, i) => {
      const res = baseRes * (fw / lv.width);
      if (res < finestRes) { finestRes = res; finest = i; }
      if (res <= srcRes && res > bestRes) { best = i; bestRes = res; }
    });
    return best >= 0 ? best : finest;
  }

  _levelPixelSize(level) {
    const lv = this.levels[level], L0 = this.levels[0];
    return [
      Math.abs(this.gt[1]) * (L0.width / lv.width),
      Math.abs(this.gt[5]) * (L0.height / lv.height),
    ];
  }

  // Render a Web Mercator extent (3857 [minx,miny,maxx,maxy]) to an outW x outH
  // RGBA buffer. A coarse grid of mercator->source samples (the proj4 transform,
  // or identity for EPSG:3857) is bilinearly interpolated per output pixel to a
  // source location, then sampled from the source window. Bands: 1 (paletted via
  // the color table, else single-band colormap) or >=3 (RGB composite, per-band
  // rescale). Out-of-raster pixels stay transparent. Powers tiles, preview, bbox.
  async _renderExtent(merc, outW, outH, opts = {}) {
    const [minx, miny, maxx, maxy] = merc;
    const l0 = this.levels[0];
    const wanted = opts.bidx && opts.bidx.length ? opts.bidx : this.palette ? [1] : l0.bands >= 3 ? [1, 2, 3] : [1];
    const bands0 = wanted.map((b) => b - 1).filter((b) => b >= 0 && b < l0.bands);
    if (!bands0.length) bands0.push(0);
    const rgb = bands0.length >= 3;
    const rescales = rescaleList(opts);
    const colormap = opts.colormap || "viridis";
    const nodata = opts.nodata != null ? opts.nodata : this.nodata;
    const ndSet = nodata != null && !Number.isNaN(nodata);
    // Transfer-curve params (parity with maplibre-gl-raster's shader pipeline).
    // Normalize gamma/opacity here so the JS (RGB) and Rust (single-band) paths
    // apply identical curves for the same options (e.g. gamma 0 -> clamped, not skipped).
    const stretch = opts.stretch || "linear";
    const gamma = Number.isFinite(+opts.gamma) ? Math.max(+opts.gamma, 1e-4) : 1;
    const reversed = !!opts.reversed;
    const opacity = Number.isFinite(+opts.opacity) ? Math.max(0, Math.min(1, +opts.opacity)) : 1;
    const alpha = Math.round(opacity * 255);

    // Gridded mercator -> source samples, and the source-coord bbox they span.
    const nx = new Float64Array((NG + 1) * (NG + 1));
    const ny = new Float64Array((NG + 1) * (NG + 1));
    let sminx = Infinity, sminy = Infinity, smaxx = -Infinity, smaxy = -Infinity, any = false;
    for (let gy = 0; gy <= NG; gy++) {
      const my = maxy - (gy / NG) * (maxy - miny);
      for (let gx = 0; gx <= NG; gx++) {
        const mx = minx + (gx / NG) * (maxx - minx);
        let s;
        try { s = this.toSource.forward([mx, my]); } catch { s = [NaN, NaN]; }
        const i = gy * (NG + 1) + gx;
        nx[i] = s[0]; ny[i] = s[1];
        if (isFinite(s[0]) && isFinite(s[1])) {
          any = true;
          if (s[0] < sminx) sminx = s[0];
          if (s[0] > smaxx) smaxx = s[0];
          if (s[1] < sminy) sminy = s[1];
          if (s[1] > smaxy) smaxy = s[1];
        }
      }
    }
    if (!any) return null;

    const level = this._chooseLevel((smaxx - sminx) / outW);
    const lv = this.levels[level];
    const [lpw, lph] = this._levelPixelSize(level);
    const ox = this.gt[0], oy = this.gt[3];
    let c0 = Math.floor((sminx - ox) / lpw), c1 = Math.ceil((smaxx - ox) / lpw);
    let r0 = Math.floor((oy - smaxy) / lph), r1 = Math.ceil((oy - sminy) / lph);
    c0 = Math.max(0, Math.min(c0, lv.width)); c1 = Math.max(0, Math.min(c1, lv.width));
    r0 = Math.max(0, Math.min(r0, lv.height)); r1 = Math.max(0, Math.min(r1, lv.height));
    const ww = c1 - c0, hh = r1 - r0;
    if (ww <= 0 || hh <= 0) return null;

    // Assemble the needed band window(s): 1 (palette/colormap) or 3 (RGB).
    const used = rgb ? bands0.slice(0, 3) : [bands0[0]];
    const bufs = await Promise.all(used.map((b) => this._assembleWindow(level, c0, r0, ww, hh, b)));
    const pal = this.palette;

    const out = new Uint8ClampedArray(outW * outH * 4);
    const grid = !pal && !rgb ? new Float64Array(outW * outH).fill(NaN) : null;
    for (let py = 0; py < outH; py++) {
      const fy = (py / outH) * NG, gy0 = Math.min(NG - 1, Math.floor(fy)), ty = fy - gy0;
      for (let px = 0; px < outW; px++) {
        const fx = (px / outW) * NG, gx0 = Math.min(NG - 1, Math.floor(fx)), tx = fx - gx0;
        const i00 = gy0 * (NG + 1) + gx0;
        const sx = bilin(nx[i00], nx[i00 + 1], nx[i00 + NG + 1], nx[i00 + NG + 2], tx, ty);
        const sy = bilin(ny[i00], ny[i00 + 1], ny[i00 + NG + 1], ny[i00 + NG + 2], tx, ty);
        if (!isFinite(sx) || !isFinite(sy)) continue;
        const fcol = (sx - ox) / lpw - c0;
        const frow = (oy - sy) / lph - r0;
        const o = (py * outW + px) * 4;
        if (pal) {
          // Categorical: nearest-neighbor + color table.
          const col = Math.floor(fcol), row = Math.floor(frow);
          if (col < 0 || col >= ww || row < 0 || row >= hh) continue;
          const v = bufs[0][row * ww + col];
          if (!isFinite(v)) continue;
          const ci = v & 255;
          // Transparency: the declared nodata when present, else the GDAL
          // paletted convention that index 0 is the background/no-data class.
          if (ndSet ? v === nodata : ci === 0) continue;
          out[o] = pal[ci * 4]; out[o + 1] = pal[ci * 4 + 1];
          out[o + 2] = pal[ci * 4 + 2]; out[o + 3] = alpha;
        } else if (rgb) {
          // RGB composite: bilinear-sample each band, rescale -> curve -> gamma.
          let ok = true;
          for (let k = 0; k < 3; k++) {
            const v = sampleWindowBilinear(bufs[k], ww, hh, fcol, frow, ndSet ? nodata : undefined);
            if (!isFinite(v) || (ndSet && v === nodata)) { ok = false; break; }
            const [mn, mx] = rescales[k] || rescales[0];
            const t = transferCurve(Math.max(0, Math.min(1, (v - mn) / ((mx - mn) || 1))), stretch, gamma);
            out[o + k] = Math.round(t * 255);
          }
          if (ok) out[o + 3] = alpha;
          else { out[o] = out[o + 1] = out[o + 2] = 0; }
        } else {
          // Continuous single band: bilinear; colormap applied below.
          const v = sampleWindowBilinear(bufs[0], ww, hh, fcol, frow, ndSet ? nodata : undefined);
          if (!isFinite(v) || (ndSet && v === nodata)) continue;
          grid[py * outW + px] = v;
        }
      }
    }
    if (pal || rgb) return out;
    const [mn, mx] = rescales[0];
    // colorize returns a Uint8Array; expose a Uint8ClampedArray (zero-copy view,
    // matching the palette/RGB branches and the RenderedImage type) so callers
    // can pass it straight to ImageData.
    const c = colorize(
      grid, outW, outH, mn, mx, colormap, ndSet ? nodata : undefined, true,
      stretch, gamma, reversed, opacity,
    );
    return new Uint8ClampedArray(c.buffer, c.byteOffset, c.length);
  }

  // --- TiTiler-style read API ----------------------------------------------

  /** XYZ zoom whose tile resolution matches the full-res pixel size. */
  _maxzoom() {
    const res = Math.abs(this.gt[1]);
    return Math.max(0, Math.min(24, Math.round(Math.log2((2 * OS) / (TILE * res)))));
  }

  /** XYZ zoom whose tile resolution matches the coarsest overview. */
  _minzoom() {
    const c = this.levels[this.levels.length - 1];
    const res = Math.abs(this.gt[1]) * (this.levels[0].width / c.width);
    return Math.max(0, Math.min(24, Math.round(Math.log2((2 * OS) / (TILE * res)))));
  }

  /** Dataset info (≈ TiTiler `/cog/info`). */
  info() {
    const l0 = this.levels[0];
    const b = this.boundsLonLat;
    return {
      bounds: b, // WGS84 [minlon, minlat, maxlon, maxlat]
      crs: this.crsLabel,
      width: l0.width,
      height: l0.height,
      count: l0.bands,
      dtype: dtypeOf(l0),
      nodata: this.nodata == null || Number.isNaN(this.nodata) ? null : this.nodata,
      colorinterp: this.palette ? ["palette"] : null,
      overviews: this.levels.length - 1,
      tile_size: [l0.tile_width, l0.tile_height],
      minzoom: this._minzoom(),
      maxzoom: this._maxzoom(),
      band_descriptions: Array.from({ length: l0.bands }, (_, i) => `b${i + 1}`),
      compression: l0.compression,
    };
  }

  /** Dataset info as a GeoJSON Feature (≈ TiTiler `/cog/info.geojson`). */
  infoGeoJSON() {
    const [w, s, e, n] = this.boundsLonLat;
    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
      properties: this.info(),
    };
  }

  /** Mapbox TileJSON document (≈ TiTiler `/cog/tilejson.json`). */
  tilejson({ tilesUrl = "cog://{z}/{x}/{y}", minzoom, maxzoom, scheme = "xyz" } = {}) {
    const b = this.boundsLonLat;
    const mn = minzoom ?? this._minzoom();
    return {
      tilejson: "2.2.0",
      version: "1.0.0",
      scheme,
      tiles: [tilesUrl],
      minzoom: mn,
      maxzoom: maxzoom ?? this._maxzoom(),
      bounds: b,
      center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, mn],
    };
  }

  /** Band value(s) at a WGS84 lon/lat (≈ TiTiler `/cog/point/{lon},{lat}`). */
  async point(lon, lat, { bidx } = {}) {
    const [mx, my] = proj4("EPSG:4326", "EPSG:3857").forward([lon, lat]);
    const [sx, sy] = this.toSource.forward([mx, my]); // source CRS coords
    const l0 = this.levels[0];
    const col = Math.floor((sx - this.gt[0]) / Math.abs(this.gt[1]));
    const row = Math.floor((this.gt[3] - sy) / Math.abs(this.gt[5]));
    if (col < 0 || col >= l0.width || row < 0 || row >= l0.height) {
      return { coordinates: [lon, lat], values: [], band_names: [], outside: true };
    }
    const bands = bidx ? bidx.map((b) => b - 1) : Array.from({ length: l0.bands }, (_, i) => i);
    let values;
    if (this.planar) {
      // Planar: whitebox can't address bands 1..n; read the pixel via geotiff.js.
      const img = await this._tiffImage(0);
      const r = await img.readRasters({ window: [col, row, col + 1, row + 1], samples: bands });
      values = r.map((b) => b[0]);
    } else {
      const tcol = Math.floor(col / l0.tile_width), trow = Math.floor(row / l0.tile_height);
      const [off, len] = Array.from(this.stream.tile_range(0, tcol, trow));
      const px = await this._getTile(0, { col: tcol, row: trow, offset: off, length: len });
      const base = ((row % l0.tile_height) * l0.tile_width + (col % l0.tile_width)) * l0.bands;
      values = bands.map((b) => px[base + b]);
    }
    return {
      coordinates: [lon, lat],
      values,
      band_names: bands.map((b) => `b${b + 1}`),
    };
  }

  /** Per-band statistics (≈ TiTiler `/cog/statistics`), from a decimated
   *  overview (the largest one whose width is ≤ `maxSize`). */
  async statistics({ maxSize = 1024 } = {}) {
    let level = this.levels.length - 1;
    for (let i = 0; i < this.levels.length; i++) {
      if (this.levels[i].width <= maxSize) { level = i; break; }
    }
    const lv = this.levels[level];
    const nodata = this.nodata == null || Number.isNaN(this.nodata) ? null : this.nodata;
    const out = {};
    for (let b = 0; b < lv.bands; b++) {
      const buf = await this._assembleWindow(level, 0, 0, lv.width, lv.height, b);
      out[`b${b + 1}`] = computeStats(buf, nodata);
    }
    return out;
  }

  /** Render a preview of the whole dataset (≈ TiTiler `/cog/preview`).
   *  Returns `{ width, height, rgba }`. `opts` accepts the render params
   *  (`bidx`, `min`/`max`/`rescale`, `colormap`, `nodata`) plus `maxSize` /
   *  `width` / `height`. */
  async preview({ maxSize = 1024, width, height, ...render } = {}) {
    const merc = mercExtentFromLonLat(this.boundsLonLat);
    const [w, h] = fitSize(merc[2] - merc[0], merc[3] - merc[1], maxSize, width, height);
    const rgba = (await this._renderExtent(merc, w, h, render)) || new Uint8ClampedArray(w * h * 4);
    return { width: w, height: h, rgba };
  }

  /** Render a WGS84 bbox region (≈ TiTiler `/cog/bbox`). `bbox` is
   *  [minLon, minLat, maxLon, maxLat]. Returns `{ width, height, rgba }`. */
  async bbox(bbox, { maxSize = 1024, width, height, ...render } = {}) {
    const merc = mercExtentFromLonLat(bbox);
    const [w, h] = fitSize(merc[2] - merc[0], merc[3] - merc[1], maxSize, width, height);
    const rgba = (await this._renderExtent(merc, w, h, render)) || new Uint8ClampedArray(w * h * 4);
    return { width: w, height: h, rgba };
  }

  /** Like {@link preview}, encoded as PNG bytes. */
  async previewPNG(opts = {}) {
    const { width, height, rgba } = await this.preview(opts);
    return rgbaToPng(rgba, width, height);
  }

  /** Like {@link bbox}, encoded as PNG bytes. */
  async bboxPNG(bbox, opts = {}) {
    const r = await this.bbox(bbox, opts);
    return rgbaToPng(r.rgba, r.width, r.height);
  }
}

/** Encode a `w`x`h` RGBA buffer to PNG bytes (browser; uses OffscreenCanvas). */
export async function rgbaToPng(rgba, w = TILE, h = TILE) {
  const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
  const cv = new OffscreenCanvas(w, h);
  cv.getContext("2d").putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Names of the built-in colormaps (for single-band rendering). */
export function colormaps() {
  return JSON.parse(colormap_names());
}

/**
 * Register a MapLibre custom protocol (e.g. `cog://{z}/{x}/{y}`).
 * `resolve()` is called per tile and returns `{ source, render }`, where
 * `source` is a {@link CogSource} and `render` is `{ min, max, colormap }`.
 */
export function registerCogProtocol(maplibregl, name, resolve) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // literal protocol name
  const re = new RegExp(`${escaped}://(\\d+)/(\\d+)/(\\d+)`);
  maplibregl.addProtocol(name, async (params) => {
    const ctx = resolve();
    if (!ctx || !ctx.source) return { data: new Uint8Array() };
    const m = params.url.match(re);
    if (!m) return { data: new Uint8Array() };
    const [z, x, y] = m.slice(1).map(Number);
    try {
      return { data: await ctx.source.renderTilePNG(z, x, y, ctx.render || {}) };
    } catch (e) {
      console.error(name, "tile", z, x, y, e);
      return { data: new Uint8Array() };
    }
  });
}
