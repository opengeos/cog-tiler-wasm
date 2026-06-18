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

```bash
npm run dev   # builds the wasm, assembles demo/, serves http://localhost:8000/
```

`npm run dev` builds the wasm into `demo/`, copies in `cog-tiler.js` + the sample,
and starts a zero-dependency static server with **HTTP range support** (which the
tile streaming needs - the stdlib `python -m http.server` does not do ranges).
Set `PORT` to change the port. No `npm install` is required (the dev scripts use
only Node built-ins; the demo loads its peer deps from a CDN via an import map).

The published [GitHub Pages demo](https://opengeos.github.io/cog-tiler-wasm/) is
built the same way by `.github/workflows/pages.yml`.

## Usage (reusable module)

[`cog-tiler.js`](cog-tiler.js) is the package's main entry. It wraps the wasm
tiler + `whitebox-wasm` and handles EPSG:3857 sources, on-the-fly **warping** of
any projected/4326 COG to Web Mercator, and **paletted (categorical)** rendering -
so apps import it instead of copying the demo.

It ships **inside the npm package** (`main`/`module` -> `cog-tiler.js`); the raw
wasm tiler is also available at the `cog-tiler-wasm/wasm` subpath. Install it
alongside its peer dependencies:

```bash
npm install cog-tiler-wasm whitebox-wasm proj4 geotiff geotiff-geokeys-to-proj4 maplibre-gl
```

```js
import maplibregl from "maplibre-gl";
import { init, openCog, registerCogProtocol } from "cog-tiler-wasm";

await init(); // load the wasm modules once

let source = null;
// The protocol resolves the active source + render settings per tile.
registerCogProtocol(maplibregl, "cog", () => ({
  source,
  render: { min: 0, max: 3000, colormap: "viridis" }, // ignored for paletted COGs
}));

source = await openCog(url); // EPSG:3857 fast path, or warped if projected/4326
// openCog also accepts a local raster: a File (e.g. from <input type=file>),
// Blob, ArrayBuffer, or Uint8Array - read in memory, no server needed.
map.addSource("cog", { type: "raster", tiles: ["cog://{z}/{x}/{y}"], tileSize: 256 });
map.addLayer({ id: "cog", type: "raster", source: "cog" });

// source.crsLabel, source.levels, source.hasPalette, source.boundsLonLat
// and source.renderTileRGBA(z, x, y, render) / renderTilePNG(...) are also exposed.
```

### TiTiler-style COG API

`CogSource` mirrors the read endpoints of
[TiTiler's COG API](https://developmentseed.org/titiler/endpoints/cog/),
client-side (works on projected/paletted sources too, via the warp path):

```js
src.info();           // /cog/info     -> bounds, count, dtype, nodata, overviews, min/maxzoom, ...
src.infoGeoJSON();    // /cog/info.geojson -> GeoJSON Feature (bbox polygon + info)
src.tilejson();       // /cog/tilejson.json -> Mapbox TileJSON document
await src.point(lon, lat);          // /cog/point -> band value(s) at a WGS84 coordinate
await src.statistics({ maxSize });  // /cog/statistics -> per-band min/max/mean/std/
                                    //   count/valid_percent/median/percentiles/histogram
                                    //   (from a decimated overview)
```

Tile/image rendering, band selection (`bidx`/RGB), `preview`, and `bbox`/`part`
are tracked in the [roadmap](#roadmap). Server-only endpoints (`/map.html`,
`WMTSCapabilities.xml`, `/validate`, `/stac`) are out of scope for a client-side
library.

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
assembled f64 window to RGBA. See [`cog-tiler.js`](cog-tiler.js) for the
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

- **TiTiler COG API parity** - done: `info`, `info.geojson`, `tilejson`,
  `point`, `statistics` (see [above](#titiler-style-cog-api)). Next:
  **`bidx`/RGB band selection**, more **colormaps**, and **`preview`** +
  **`bbox`/`part`** image generation; later, band-math **expressions**.
- **Warping** of projected/4326 sources and **paletted/categorical** rendering
  are done in [`cog-tiler.js`](cog-tiler.js) (proj4js + geotiff.js). Next: expose
  the source proj string + color table **upstream in `whitebox-wasm`** (it
  already parses both) to drop the geotiff.js dependency, then move the warp into
  the Rust crate (`proj4rs`).
- **Edge / WASI serving** - run the same module as a serverless XYZ endpoint
  near the data, not only in the browser.
- **STAC / mosaics** - multi-asset orchestration.

## Releasing

The npm package bundles the wasm tiler **and** the `cog-tiler.js` module
(assembled by [`scripts/prepare-pkg.mjs`](scripts/prepare-pkg.mjs)). To cut a
release, push a `vX.Y.Z` tag; [`release.yml`](.github/workflows/release.yml)
builds, assembles, and publishes to npm via Trusted Publishing (OIDC, no token):

```bash
git tag v0.2.0 && git push origin v0.2.0
```

One-time setup: configure the package's Trusted Publisher on npmjs.com (package
-> Settings -> Trusted Publisher) to this repo + `release.yml`.

## License

[MIT](LICENSE) © OpenGeos.
