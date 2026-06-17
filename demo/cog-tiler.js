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
import initTiler, { CogTiler } from "./cog_tiler_wasm.js?v=__BUILD__";
import proj4 from "proj4";
import * as GeoTIFF from "geotiff";
import geokeysToProj4 from "geotiff-geokeys-to-proj4";

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

/**
 * Open a COG and return a {@link CogSource} ready to render XYZ tiles.
 * Detects EPSG:3857 (fast path) vs. any other CRS (warp path), and reads the
 * source projection + color table from the GeoTIFF header (whitebox-wasm 0.4.0
 * does not expose them).
 */
export async function openCog(url) {
  await init();
  const range = rangeFetcher(url);
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
  // CogTiler renders an assembled f64 window -> RGBA (rescale + colormap +
  // nodata). render() ignores the CRS, so we build one in both modes.
  const tiler = new CogTiler(
    Float64Array.from(gt),
    levels[0].width,
    levels[0].height,
    3857,
    stream.nodata,
    JSON.stringify(levels),
  );
  const base = { url, range, stream, tiler, levels, gt, nodata: stream.nodata };

  if (stream.epsg === 3857) {
    return new CogSource({
      ...base,
      mode: "3857",
      crsLabel: "EPSG:3857",
      palette: null,
      boundsLonLat: Array.from(stream.bounds_lonlat()),
    });
  }

  // Warp path: read the real source CRS + optional palette from the header.
  const tiff = await GeoTIFF.fromUrl(url);
  const img = await tiff.getImage();
  const srcDef = geokeysToProj4.toProj4(img.getGeoKeys()).proj4;
  if (!srcDef) throw new Error("could not derive source CRS from GeoTIFF geokeys");
  const toSource = proj4("EPSG:3857", srcDef); // forward: mercator -> source
  const toLonLat = proj4(srcDef, "EPSG:4326"); // forward: source -> lon/lat
  const palette = buildPalette(img.fileDirectory.ColorMap);

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
    crsLabel: "warped from " + (srcDef.match(/\+proj=\w+/) || ["custom CRS"])[0],
  });
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

  /** Render an XYZ tile to a 256x256 RGBA `Uint8ClampedArray`, or null if empty. */
  async renderTileRGBA(z, x, y, opts = {}) {
    return this.mode === "warp"
      ? this._warp(z, x, y, opts)
      : this._render3857(z, x, y, opts);
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

  // Fetch (parallel, cached) + decode the source tiles covering a level pixel
  // window and assemble them into a row-major f64 buffer (NaN = no data).
  async _assembleWindow(level, x, y, w, h) {
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
          buf[oy * w + ox] = px[(ry * tw + rx) * bands]; // band 0
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

  // Fast path: source already EPSG:3857, so a tile maps affinely to a window.
  async _render3857(z, x, y, { min = 0, max = 1, colormap = "viridis" } = {}) {
    const win = this.tiler.pixel_window_for_tile(z, x, y);
    if (win.empty) return null;
    const buf = await this._assembleWindow(win.level, win.x, win.y, win.w, win.h);
    return this.tiler.render(buf, win.w, win.h, min, max, colormap, true);
  }

  // Warp path: reproject a Web Mercator tile from the source CRS on the fly.
  // A coarse grid of mercator->source samples (proj4) is bilinearly interpolated
  // per output pixel, then nearest-sampled from the source window (correct for
  // categorical data). Paletted sources use the color table; others reuse the
  // Rust colormap (render resamples 256->256, ~identity).
  async _warp(z, x, y, { min = 0, max = 1, colormap = "viridis" } = {}) {
    const tb = tileBounds3857(z, x, y);
    const nx = new Float64Array((NG + 1) * (NG + 1));
    const ny = new Float64Array((NG + 1) * (NG + 1));
    let sminx = Infinity, sminy = Infinity, smaxx = -Infinity, smaxy = -Infinity, any = false;
    for (let gy = 0; gy <= NG; gy++) {
      const my = tb[3] - (gy / NG) * (tb[3] - tb[1]);
      for (let gx = 0; gx <= NG; gx++) {
        const mx = tb[0] + (gx / NG) * (tb[2] - tb[0]);
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

    const level = this._chooseLevel((smaxx - sminx) / TILE);
    const lv = this.levels[level];
    const [lpw, lph] = this._levelPixelSize(level);
    const ox = this.gt[0], oy = this.gt[3];
    let c0 = Math.floor((sminx - ox) / lpw), c1 = Math.ceil((smaxx - ox) / lpw);
    let r0 = Math.floor((oy - smaxy) / lph), r1 = Math.ceil((oy - sminy) / lph);
    c0 = Math.max(0, Math.min(c0, lv.width)); c1 = Math.max(0, Math.min(c1, lv.width));
    r0 = Math.max(0, Math.min(r0, lv.height)); r1 = Math.max(0, Math.min(r1, lv.height));
    const ww = c1 - c0, hh = r1 - r0;
    if (ww <= 0 || hh <= 0) return null;
    const buf = await this._assembleWindow(level, c0, r0, ww, hh);

    const pal = this.palette;
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    const grid = pal ? null : new Float64Array(TILE * TILE).fill(NaN);
    for (let py = 0; py < TILE; py++) {
      const fy = (py / TILE) * NG, gy0 = Math.min(NG - 1, Math.floor(fy)), ty = fy - gy0;
      for (let px = 0; px < TILE; px++) {
        const fx = (px / TILE) * NG, gx0 = Math.min(NG - 1, Math.floor(fx)), tx = fx - gx0;
        const i00 = gy0 * (NG + 1) + gx0;
        const sx = bilin(nx[i00], nx[i00 + 1], nx[i00 + NG + 1], nx[i00 + NG + 2], tx, ty);
        const sy = bilin(ny[i00], ny[i00 + 1], ny[i00 + NG + 1], ny[i00 + NG + 2], tx, ty);
        if (!isFinite(sx) || !isFinite(sy)) continue;
        const col = Math.floor((sx - ox) / lpw) - c0;
        const row = Math.floor((oy - sy) / lph) - r0;
        if (col < 0 || col >= ww || row < 0 || row >= hh) continue;
        const v = buf[row * ww + col];
        if (!isFinite(v)) continue;
        if (pal) {
          const ci = v & 255;
          if (ci === 0 || (this.nodata != null && v === this.nodata)) continue;
          const o = (py * TILE + px) * 4;
          out[o] = pal[ci * 4]; out[o + 1] = pal[ci * 4 + 1];
          out[o + 2] = pal[ci * 4 + 2]; out[o + 3] = 255;
        } else {
          grid[py * TILE + px] = v;
        }
      }
    }
    if (pal) return out;
    return this.tiler.render(grid, TILE, TILE, min, max, colormap, true);
  }
}

/** Encode a 256x256 RGBA buffer to PNG bytes (browser; uses OffscreenCanvas). */
export async function rgbaToPng(rgba) {
  const img = new ImageData(new Uint8ClampedArray(rgba), TILE, TILE);
  const cv = new OffscreenCanvas(TILE, TILE);
  cv.getContext("2d").putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
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
