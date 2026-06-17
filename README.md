# cog-tiler-wasm

[![CI](https://github.com/opengeos/cog-tiler-wasm/actions/workflows/ci.yml/badge.svg)](https://github.com/opengeos/cog-tiler-wasm/actions/workflows/ci.yml)

**Serverless, TiTiler-style XYZ tiling of Cloud Optimized GeoTIFFs, in
WebAssembly.** No backend, no GDAL, no PROJ - the map fetches COG byte ranges
directly and synthesizes `z/x/y` tiles client-side.

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

## Usage

```js
import initTiler, { CogTiler } from "cog-tiler-wasm";
import initWhitebox, { CogStream } from "whitebox-wasm";
await Promise.all([initTiler(), initWhitebox()]);

const range = (a, b) =>
  fetch(url, { headers: { Range: `bytes=${a}-${b}` } })
    .then((r) => r.arrayBuffer())
    .then((b) => new Uint8Array(b));

// 1. Open the COG header with whitebox-wasm's streamer.
const stream = new CogStream(await range(0, 65535));
const levels = JSON.parse(stream.levels_json()); // [{width,height}, ...] finest first

// 2. Build the tiler from the COG metadata.
const tiler = new CogTiler(
  Float64Array.from(stream.geo_transform()),
  levels[0].width,
  levels[0].height,
  stream.epsg, // must be 3857 in v1
  Number.isNaN(stream.nodata) ? undefined : stream.nodata,
  JSON.stringify(levels),
);

// 3. Per XYZ tile: window -> fetch+decode -> render.
const win = tiler.pixel_window_for_tile(z, x, y);
// (use stream.tiles_for_window / decode_tile_f64 to assemble a w*h Float64Array)
const rgba = tiler.render(window, win.w, win.h, 0, 3000, "viridis", true);
```

A runnable MapLibre example (custom `cog://` protocol) is in
[`demo/index.html`](demo/index.html).

## API

`version()`, `tile_bounds_3857(z, x, y) -> [minx,miny,maxx,maxy]`.

**`new CogTiler(geo_transform, width, height, epsg, nodata, levels_json)`**
- `geo_transform` - 6-element GDAL affine of the full-res raster (`Float64Array`)
- `width`/`height` - full-resolution pixel dimensions
- `epsg` - source CRS; must be `3857` in v1
- `nodata` - optional nodata value (`undefined`/`NaN` = none)
- `levels_json` - JSON array of `{width,height}`, finest level first

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
