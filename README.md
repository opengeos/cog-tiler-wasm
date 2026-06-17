# cog-tiler-wasm

[![CI](https://github.com/opengeos/cog-tiler-wasm/actions/workflows/ci.yml/badge.svg)](https://github.com/opengeos/cog-tiler-wasm/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://opengeos.github.io/cog-tiler-wasm/)

**Serverless, TiTiler-style XYZ tiling of Cloud Optimized GeoTIFFs, in
WebAssembly.** No backend, no GDAL, no PROJ - the map fetches COG byte ranges
directly and synthesizes `z/x/y` tiles client-side.

**[Live demo](https://opengeos.github.io/cog-tiler-wasm/)** - loads a sample
EPSG:3857 COG over HTTP range requests and renders it on a MapLibre map, all in
the browser. Paste any CORS- and range-enabled 3857 COG URL to try your own.

This crate is the **tiling brain**. It does the slippy-map math (tile -> source
pixel window), picks the right COG overview level, and renders a decoded window
into an RGBA tile (rescale + colormap + nodata alpha). It deliberately does
**not** parse COGs or do network I/O - that is delegated to
[`whitebox-wasm`](https://github.com/opengeos/whitebox-wasm)'s `CogStream`,
which already implements a pure-Rust codec stack (Deflate/LZW/JPEG/WebP/…) and
HTTP range streaming. The two compose into a complete tiler:

```
  CogStream (whitebox-wasm)               CogTiler (this crate)
  ─────────────────────────               ─────────────────────
  geo_transform(), levels_json()   ──▶     new(gt, w, h, epsg, nodata, levels)
                                           pixel_window_for_tile(z,x,y) ─▶ {level,x,y,w,h}
  tiles_for_window(level,x,y,w,h)  ◀──     (JS fetches byte ranges, decodes tiles)
  decode_tile_f64(...)             ──▶     render(window, w, h, min, max, cmap) ─▶ RGBA
```

The result is a TiTiler-class viewer with **zero hosting cost**: wire it to a
MapLibre custom protocol and the browser does everything.

## Why this is feasible without a server

A dynamic tile server (TiTiler = FastAPI + rio-tiler + GDAL) does five things:
read a COG by HTTP **range request**, decode the relevant internal tiles,
resample to the requested XYZ tile, apply rescale/colormap/nodata, and encode.
Every one of those has a pure-Rust, WASM-clean implementation today - the two
historically hard parts (a C-free codec stack and CRS handling) are already
solved in `whitebox-wasm`. This crate adds the thin layer on top: mercator
addressing, overview selection, resampling, and rendering.

## Status

**v1 (this scaffold):** EPSG:3857 sources, single-band rendering, built-in
colormaps, MapLibre demo. The crate builds to `wasm32-unknown-unknown` and ships
a `wasm-pack` web package.

See [Roadmap](#roadmap) for warping, multi-band, and edge/WASI serving.

## Build

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build crates/cog-tiler-wasm --release --target web --out-dir pkg
```

### Run the demo locally

The demo imports the wasm package as `./cog_tiler_wasm.js`, so build it into the
`demo/` folder and serve that folder (any static server with HTTP range support
works; the bundled sample is same-origin so no CORS is needed):

```bash
wasm-pack build crates/cog-tiler-wasm --release --target web --out-dir ../../demo
cp examples/sample-3857-cog.tif demo/
python3 -m http.server -d demo 8000   # then open http://localhost:8000/
```

The published [GitHub Pages demo](https://opengeos.github.io/cog-tiler-wasm/) is
built the same way by `.github/workflows/pages.yml`.

## Usage (reusable module)

[`cog-tiler.js`](demo/cog-tiler.js) is the downstream-facing module. It wraps the
wasm tiler + `whitebox-wasm` and handles EPSG:3857 sources, on-the-fly **warping**
of any projected/4326 COG to Web Mercator, and **paletted (categorical)**
rendering - so apps import it instead of copying the demo. It must sit next to the
built wasm package (`cog_tiler_wasm.js` + `_bg.wasm`).

Peer dependencies (provide via your bundler, or an import map for a no-build page):
`whitebox-wasm`, `proj4`, `geotiff`, `geotiff-geokeys-to-proj4`.

```js
import maplibregl from "maplibre-gl";
import { init, openCog, registerCogProtocol } from "./cog-tiler.js";

await init(); // load the wasm modules once

let source = null;
// The protocol resolves the active source + render settings per tile.
registerCogProtocol(maplibregl, "cog", () => ({
  source,
  render: { min: 0, max: 3000, colormap: "viridis" }, // ignored for paletted COGs
}));

source = await openCog(url); // EPSG:3857 fast path, or warped if projected/4326
map.addSource("cog", { type: "raster", tiles: ["cog://{z}/{x}/{y}"], tileSize: 256 });
map.addLayer({ id: "cog", type: "raster", source: "cog" });

// source.crsLabel, source.levels, source.hasPalette, source.boundsLonLat
// and source.renderTileRGBA(z, x, y, render) / renderTilePNG(...) are also exposed.
```

For a no-build page, map the peer deps with an import map (see
[`demo/index.html`](demo/index.html)):

```html
<script type="importmap">
  { "imports": {
    "whitebox-wasm": "https://esm.sh/whitebox-wasm@0.4.0",
    "proj4": "https://esm.sh/proj4@2.20.9",
    "geotiff": "https://esm.sh/geotiff@2.1.3",
    "geotiff-geokeys-to-proj4": "https://esm.sh/geotiff-geokeys-to-proj4@2024.4.13"
  } }
</script>
```

### Low-level Rust API

The wasm crate (`CogTiler`) is the 3857 tiling brain underneath `cog-tiler.js`:
`pixel_window_for_tile(z, x, y)` maps a tile to a source-pixel window/overview,
and `render(window, w, h, min, max, colormap, nodata_alpha)` rasterizes an
assembled f64 window to RGBA. See [`demo/cog-tiler.js`](demo/cog-tiler.js) for the
window-assembly and warp loops built on top.

A runnable MapLibre example (custom `cog://` protocol) is in
[`demo/index.html`](demo/index.html).

## API

`version()`, `tile_bounds_3857(z, x, y) -> [minx,miny,maxx,maxy]`.

**`new CogTiler(geo_transform, width, height, epsg, nodata, levels_json)`**
- `geo_transform` - 6-element GDAL affine of the full-res raster (`Float64Array`)
- `width`/`height` - full-resolution pixel dimensions
- `epsg` - source CRS; must be `3857` in v1
- `nodata` - optional nodata value (`undefined`/`NaN` = none)
- `levels_json` - JSON array of level descriptors, finest level first; only
  `width`/`height` are read (extra `whitebox-wasm` fields are ignored)

Properties: `epsg`, `num_levels`.

**`pixel_window_for_tile(z, x, y)`** -> `{ level, x, y, w, h, level_width, level_height, empty }`
The overview level and pixel window covering the tile. `empty` is true when the
tile lies outside the raster.

**`render(pixels, win_w, win_h, min, max, colormap, nodata_alpha)`** -> `Uint8Array`
A `256*256*4` RGBA tile. `pixels` is the decoded row-major `f64` window;
`colormap` is `"viridis" | "magma" | "terrain" | "gray"`. Empty windows render
fully transparent.

## Roadmap

- **Warping** non-3857 sources (resample with per-pixel coordinate transform,
  using `whitebox-wasm`'s pure-Rust projection engine for the point transform).
- **Multi-band / RGB** rendering and band-math expressions.
- **More colormaps** and discrete/classified styling.
- **Render in Rust vs JS** - benchmark and move hot paths into wasm.
- **Edge / WASI serving** - run the same module as a serverless XYZ endpoint
  near the data, not only in the browser.
- **STAC / mosaics** - multi-asset orchestration.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option.
