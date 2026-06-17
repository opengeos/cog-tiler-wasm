//! Web Mercator (EPSG:3857) slippy-map math.
//!
//! These are the standard XYZ tile relations used by Leaflet, MapLibre, and
//! TiTiler. All values are in EPSG:3857 meters unless noted.

/// Half the circumference of the Web Mercator world, in meters
/// (`pi * 6378137`). The projected world spans `[-ORIGIN_SHIFT, +ORIGIN_SHIFT]`
/// on both axes.
pub const ORIGIN_SHIFT: f64 = 20037508.342789244;

/// Side length of a slippy-map tile in pixels.
pub const TILE_SIZE: u32 = 256;

/// Projected resolution (meters per pixel) of a 256 px tile at zoom `z`.
pub fn resolution(z: u32) -> f64 {
    (2.0 * ORIGIN_SHIFT) / (TILE_SIZE as f64 * (1u64 << z) as f64)
}

/// EPSG:3857 bounds of the XYZ tile `z/x/y` as `[min_x, min_y, max_x, max_y]`.
///
/// Uses the standard XYZ convention where `y` increases southward (row 0 is the
/// north edge), matching MapLibre/Leaflet and TiTiler.
pub fn tile_bounds(z: u32, x: u32, y: u32) -> [f64; 4] {
    let n = (1u64 << z) as f64;
    let span = (2.0 * ORIGIN_SHIFT) / n;
    let min_x = -ORIGIN_SHIFT + (x as f64) * span;
    let max_x = -ORIGIN_SHIFT + (x as f64 + 1.0) * span;
    let max_y = ORIGIN_SHIFT - (y as f64) * span;
    let min_y = ORIGIN_SHIFT - (y as f64 + 1.0) * span;
    [min_x, min_y, max_x, max_y]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn z0_covers_the_world() {
        let [min_x, min_y, max_x, max_y] = tile_bounds(0, 0, 0);
        assert!((min_x + ORIGIN_SHIFT).abs() < 1e-6);
        assert!((max_x - ORIGIN_SHIFT).abs() < 1e-6);
        assert!((min_y + ORIGIN_SHIFT).abs() < 1e-6);
        assert!((max_y - ORIGIN_SHIFT).abs() < 1e-6);
    }

    #[test]
    fn xyz_y_increases_southward() {
        // At z1, the top row (y=0) is the northern half.
        let north = tile_bounds(1, 0, 0);
        let south = tile_bounds(1, 0, 1);
        assert!(north[3] > south[3]); // north max_y is higher
        assert!((north[1] - south[3]).abs() < 1e-6); // they meet at the equator (0)
        assert!(north[1].abs() < 1e-6);
    }

    #[test]
    fn resolution_halves_each_zoom() {
        assert!((resolution(0) - resolution(1) * 2.0).abs() < 1e-9);
    }
}
