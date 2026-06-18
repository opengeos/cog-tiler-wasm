//! # cog-tiler-wasm
//!
//! Serverless, TiTiler-style XYZ tiling of Cloud Optimized GeoTIFFs in
//! WebAssembly. This crate is the **tiling brain**: it maps a slippy-map tile
//! (`z/x/y`) to the source-pixel window that covers it, picks the right COG
//! overview level, and renders a decoded window to an RGBA tile (rescale +
//! colormap + nodata alpha).
//!
//! It deliberately does **not** parse COGs or do HTTP. The COG header parsing,
//! HTTP range streaming, and per-tile decoding are delegated to
//! [`whitebox-wasm`](https://github.com/opengeos/whitebox-wasm)'s `CogStream`,
//! which already implements a pure-Rust codec stack and remote range reads.
//! `cog-tiler-wasm` composes with it:
//!
//! ```text
//!   CogStream (whitebox-wasm)            CogTiler (this crate)
//!   ------------------------             ---------------------
//!   geo_transform(), levels_json()  -->  new(...)
//!                                        pixel_window_for_tile(z,x,y) --> {level,x,y,w,h}
//!   tiles_for_window(level,x,y,w,h) <--  (JS fetches byte ranges, decodes)
//!   decode_tile_f64(...)            -->  render(window, w, h, ...) --> RGBA
//! ```
//!
//! ## v1 scope
//!
//! This v1 assumes the source COG is already in **EPSG:3857 (Web Mercator)**.
//! Reprojection/warping of non-3857 sources is intentionally out of scope (see
//! the README roadmap); `pixel_window_for_tile` returns an error for other CRSs.
//! The window-to-tile resampling is a per-tile affine approximation, which is
//! accurate to sub-pixel within a single 256 px tile.

mod colormap;
mod mercator;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

pub use mercator::{resolution, tile_bounds, ORIGIN_SHIFT, TILE_SIZE};

/// Crate version (from `Cargo.toml`).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// EPSG:3857 bounds `[min_x, min_y, max_x, max_y]` of an XYZ tile.
#[wasm_bindgen]
pub fn tile_bounds_3857(z: u32, x: u32, y: u32) -> Vec<f64> {
    tile_bounds(z, x, y).to_vec()
}

/// Names of the built-in colormaps (JSON array string).
#[wasm_bindgen]
pub fn colormap_names() -> String {
    serde_json::to_string(colormap::NAMES).unwrap_or_else(|_| "[]".to_string())
}

/// Colormap a single-band `w*h` grid to RGBA at 1:1 (no resampling), for any
/// output size. `NaN` (and the nodata value when `nodata_alpha`) become
/// transparent. Pairs with the JS warp loop, which samples a grid at the output
/// resolution; `render` (which always outputs 256x256) is the tile-only variant.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn colorize(
    pixels: Vec<f64>,
    width: u32,
    height: u32,
    min: f64,
    max: f64,
    colormap: &str,
    nodata: Option<f64>,
    nodata_alpha: bool,
) -> Vec<u8> {
    let n = (width as usize) * (height as usize);
    let mut out = vec![0u8; n * 4];
    let range = max - min;
    let inv = if range != 0.0 { 1.0 / range } else { 0.0 };
    let nd = nodata.filter(|v| !v.is_nan());
    for (chunk, &v) in out.chunks_exact_mut(4).zip(pixels.iter()) {
        let is_nd = matches!(nd, Some(x) if v == x || (v - x).abs() <= f64::EPSILON);
        if v.is_nan() || (is_nd && nodata_alpha) {
            continue; // transparent
        }
        let t = ((v - min) * inv).clamp(0.0, 1.0);
        let [r, g, b] = colormap::lookup(colormap, t);
        chunk[0] = r;
        chunk[1] = g;
        chunk[2] = b;
        chunk[3] = 255;
    }
    out
}

/// Pixel dimensions of one COG overview level (level 0 = full resolution).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct LevelDim {
    pub width: u32,
    pub height: u32,
}

/// The source-pixel window (within a chosen overview level) that covers a tile.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PixelWindow {
    /// Overview level index (0 = full resolution).
    pub level: usize,
    /// Left column of the window, in that level's pixel space.
    pub x: u32,
    /// Top row of the window, in that level's pixel space.
    pub y: u32,
    /// Window width in pixels.
    pub w: u32,
    /// Window height in pixels.
    pub h: u32,
    /// Full width of the chosen level (for clamping/debugging).
    pub level_width: u32,
    /// Full height of the chosen level.
    pub level_height: u32,
    /// True when the tile falls entirely outside the raster (`w == 0 || h == 0`).
    pub empty: bool,
}

/// Tiling engine for a single COG.
#[wasm_bindgen]
pub struct CogTiler {
    // GDAL-style affine geo-transform of the FULL-RESOLUTION raster:
    // [origin_x, pixel_w, 0, origin_y, 0, pixel_h(negative)].
    gt: [f64; 6],
    width: u32,
    height: u32,
    epsg: u32,
    nodata: Option<f64>,
    levels: Vec<LevelDim>,
}

#[wasm_bindgen]
impl CogTiler {
    /// Build a tiler from COG metadata (all of which `CogStream` exposes).
    ///
    /// * `geo_transform` - 6-element GDAL affine transform of the full-res raster.
    /// * `width` / `height` - full-resolution pixel dimensions.
    /// * `epsg` - source CRS code; must be `3857` in v1.
    /// * `nodata` - optional nodata value (pass `NaN`/`undefined` for none).
    /// * `levels_json` - JSON array of `{ "width", "height" }`, finest first,
    ///   e.g. `[{"width":8192,"height":8192},{"width":4096,"height":4096}]`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        geo_transform: Vec<f64>,
        width: u32,
        height: u32,
        epsg: u32,
        nodata: Option<f64>,
        levels_json: &str,
    ) -> Result<CogTiler, JsValue> {
        if geo_transform.len() != 6 {
            return Err(JsValue::from_str("geo_transform must have 6 elements"));
        }
        let mut gt = [0.0f64; 6];
        gt.copy_from_slice(&geo_transform);

        let mut levels: Vec<LevelDim> = serde_json::from_str(levels_json)
            .map_err(|e| JsValue::from_str(&format!("invalid levels_json: {e}")))?;
        if levels.is_empty() {
            // Fall back to a single full-resolution level.
            levels.push(LevelDim { width, height });
        }
        let nodata = nodata.filter(|v| !v.is_nan());

        Ok(CogTiler {
            gt,
            width,
            height,
            epsg,
            nodata,
            levels,
        })
    }

    /// Source CRS EPSG code.
    #[wasm_bindgen(getter)]
    pub fn epsg(&self) -> u32 {
        self.epsg
    }

    /// Number of overview levels (including full resolution).
    #[wasm_bindgen(getter)]
    pub fn num_levels(&self) -> usize {
        self.levels.len()
    }

    /// Map an XYZ tile to the overview level and pixel window that cover it.
    ///
    /// Returns a [`PixelWindow`] (as a JS object). When the tile lies outside
    /// the raster, `empty` is `true` and `w == h == 0`. Errors if the source is
    /// not EPSG:3857 (v1 limitation).
    pub fn pixel_window_for_tile(&self, z: u32, x: u32, y: u32) -> Result<JsValue, JsValue> {
        if self.epsg != 3857 {
            return Err(JsValue::from_str(
                "v1 supports EPSG:3857 sources only; reproject the COG to 3857",
            ));
        }
        let win = self.window(z, x, y);
        serde_wasm_bindgen::to_value(&win).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Render a decoded source window into a 256x256 RGBA tile.
    ///
    /// * `pixels` - row-major `f64` window of size `win_w * win_h`, as returned
    ///   by assembling `CogStream.decode_tile_f64` outputs over the window from
    ///   [`Self::pixel_window_for_tile`].
    /// * `min` / `max` - rescale range mapped to the colormap's `[0, 1]`.
    /// * `colormap` - `"viridis"`, `"magma"`, `"terrain"`, or `"gray"`.
    /// * `nodata_alpha` - when `true`, nodata pixels become fully transparent.
    ///
    /// Returns `256 * 256 * 4` bytes (RGBA). An empty window (`win_w == 0`)
    /// yields a fully transparent tile.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        pixels: Vec<f64>,
        win_w: u32,
        win_h: u32,
        min: f64,
        max: f64,
        colormap: &str,
        nodata_alpha: bool,
    ) -> Vec<u8> {
        let out_size = (TILE_SIZE * TILE_SIZE * 4) as usize;
        let mut out = vec![0u8; out_size];
        if win_w == 0 || win_h == 0 || pixels.is_empty() {
            return out; // fully transparent
        }
        let range = max - min;
        let inv_range = if range != 0.0 { 1.0 / range } else { 0.0 };
        let ts = TILE_SIZE as f64;

        for ty in 0..TILE_SIZE {
            // Map output row center to source window row (affine, edge-aligned).
            let sy = ((ty as f64 + 0.5) / ts) * win_h as f64 - 0.5;
            for tx in 0..TILE_SIZE {
                let sx = ((tx as f64 + 0.5) / ts) * win_w as f64 - 0.5;
                let v = sample_bilinear(&pixels, win_w, win_h, sx, sy);

                let idx = ((ty * TILE_SIZE + tx) * 4) as usize;
                let is_nodata = match self.nodata {
                    Some(nd) => v == nd || (v - nd).abs() <= f64::EPSILON,
                    None => false,
                };
                if v.is_nan() || (is_nodata && nodata_alpha) {
                    continue; // leave transparent (alpha 0)
                }
                let t = ((v - min) * inv_range).clamp(0.0, 1.0);
                let [r, g, b] = colormap::lookup(colormap, t);
                out[idx] = r;
                out[idx + 1] = g;
                out[idx + 2] = b;
                out[idx + 3] = 255;
            }
        }
        out
    }
}

impl CogTiler {
    fn window(&self, z: u32, x: u32, y: u32) -> PixelWindow {
        let [min_x, min_y, max_x, max_y] = tile_bounds(z, x, y);
        let tile_res = (max_x - min_x) / TILE_SIZE as f64;

        let level = self.choose_level(tile_res);
        let ld = self.levels[level];

        // Pixel size at this level (full-res pixel size scaled by the downsample).
        let lpw = self.gt[1].abs() * (self.width as f64 / ld.width.max(1) as f64);
        let lph = self.gt[5].abs() * (self.height as f64 / ld.height.max(1) as f64);
        let origin_x = self.gt[0];
        let origin_y = self.gt[3];

        // Mercator -> level pixel coordinates.
        let col_at = |xm: f64| (xm - origin_x) / lpw;
        let row_at = |ym: f64| (origin_y - ym) / lph;

        let c0 = col_at(min_x).floor();
        let c1 = col_at(max_x).ceil();
        let r0 = row_at(max_y).floor(); // north edge -> smaller row
        let r1 = row_at(min_y).ceil();

        let lw = ld.width as f64;
        let lh = ld.height as f64;
        let cx0 = c0.clamp(0.0, lw);
        let cx1 = c1.clamp(0.0, lw);
        let ry0 = r0.clamp(0.0, lh);
        let ry1 = r1.clamp(0.0, lh);

        let w = (cx1 - cx0).max(0.0) as u32;
        let h = (ry1 - ry0).max(0.0) as u32;

        PixelWindow {
            level,
            x: cx0 as u32,
            y: ry0 as u32,
            w,
            h,
            level_width: ld.width,
            level_height: ld.height,
            empty: w == 0 || h == 0,
        }
    }

    /// Pick the overview whose resolution is the coarsest that is still at least
    /// as fine as the requested tile resolution (avoids upsampling/blur). Falls
    /// back to the finest level when the tile is finer than the full raster.
    fn choose_level(&self, tile_res: f64) -> usize {
        let base_res = self.gt[1].abs();
        let mut best: Option<(usize, f64)> = None;
        let mut finest: (usize, f64) = (0, f64::INFINITY);
        for (i, l) in self.levels.iter().enumerate() {
            let res = base_res * (self.width as f64 / l.width.max(1) as f64);
            if res < finest.1 {
                finest = (i, res);
            }
            if res <= tile_res {
                match best {
                    Some((_, br)) if res <= br => {}
                    _ => best = Some((i, res)),
                }
            }
        }
        best.unwrap_or(finest).0
    }
}

/// Bilinear sample of a row-major `f64` grid, clamping at the edges. Returns
/// `NaN` if any contributing sample is `NaN` so nodata/edges stay transparent.
fn sample_bilinear(data: &[f64], w: u32, h: u32, x: f64, y: f64) -> f64 {
    let w = w as i64;
    let h = h as i64;
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;

    let at = |cx: i64, cy: i64| -> f64 {
        let cx = cx.clamp(0, w - 1);
        let cy = cy.clamp(0, h - 1);
        data[(cy * w + cx) as usize]
    };
    let v00 = at(x0, y0);
    let v10 = at(x0 + 1, y0);
    let v01 = at(x0, y0 + 1);
    let v11 = at(x0 + 1, y0 + 1);
    if v00.is_nan() || v10.is_nan() || v01.is_nan() || v11.is_nan() {
        return f64::NAN;
    }
    let top = v00 + (v10 - v00) * fx;
    let bot = v01 + (v11 - v01) * fx;
    top + (bot - top) * fy
}
