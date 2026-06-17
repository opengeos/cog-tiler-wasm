//! A small set of built-in colormaps.
//!
//! Each colormap is defined by a handful of RGB anchor stops that are linearly
//! interpolated. This keeps the wasm module tiny while covering the common
//! single-band rendering cases (DEMs, indices, continuous rasters). Pass a
//! normalized value `t` in `[0, 1]`; out-of-range values are clamped.

type Stop = (f64, [u8; 3]);

const GRAY: &[Stop] = &[(0.0, [0, 0, 0]), (1.0, [255, 255, 255])];

// Perceptually-uniform viridis, sampled at 9 anchor stops.
const VIRIDIS: &[Stop] = &[
    (0.000, [68, 1, 84]),
    (0.125, [71, 44, 122]),
    (0.250, [59, 81, 139]),
    (0.375, [44, 113, 142]),
    (0.500, [33, 144, 141]),
    (0.625, [39, 173, 129]),
    (0.750, [92, 200, 99]),
    (0.875, [170, 220, 50]),
    (1.000, [253, 231, 37]),
];

// magma, sampled at 9 anchor stops.
const MAGMA: &[Stop] = &[
    (0.000, [0, 0, 4]),
    (0.125, [28, 16, 68]),
    (0.250, [79, 18, 123]),
    (0.375, [129, 37, 129]),
    (0.500, [181, 54, 122]),
    (0.625, [229, 80, 100]),
    (0.750, [251, 135, 97]),
    (0.875, [254, 194, 135]),
    (1.000, [252, 253, 191]),
];

// A simple elevation-style terrain ramp (blue-green-tan-white).
const TERRAIN: &[Stop] = &[
    (0.00, [44, 84, 169]),
    (0.15, [68, 156, 96]),
    (0.40, [201, 224, 134]),
    (0.65, [191, 153, 107]),
    (0.85, [148, 113, 90]),
    (1.00, [255, 255, 255]),
];

fn stops(name: &str) -> &'static [Stop] {
    match name {
        "viridis" => VIRIDIS,
        "magma" => MAGMA,
        "terrain" => TERRAIN,
        _ => GRAY, // "gray", "grey", "", and unknown names
    }
}

/// Look up the RGB color for normalized value `t` in the named colormap.
pub fn lookup(name: &str, t: f64) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    let table = stops(name);
    let mut prev = table[0];
    for &cur in &table[1..] {
        if t <= cur.0 {
            let span = cur.0 - prev.0;
            let f = if span > 0.0 { (t - prev.0) / span } else { 0.0 };
            return [
                lerp(prev.1[0], cur.1[0], f),
                lerp(prev.1[1], cur.1[1], f),
                lerp(prev.1[2], cur.1[2], f),
            ];
        }
        prev = cur;
    }
    table[table.len() - 1].1
}

fn lerp(a: u8, b: u8, f: f64) -> u8 {
    (a as f64 + (b as f64 - a as f64) * f).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_match_anchor_stops() {
        assert_eq!(lookup("viridis", 0.0), [68, 1, 84]);
        assert_eq!(lookup("viridis", 1.0), [253, 231, 37]);
        assert_eq!(lookup("gray", 0.0), [0, 0, 0]);
        assert_eq!(lookup("gray", 1.0), [255, 255, 255]);
    }

    #[test]
    fn clamps_out_of_range() {
        assert_eq!(lookup("viridis", -5.0), lookup("viridis", 0.0));
        assert_eq!(lookup("viridis", 5.0), lookup("viridis", 1.0));
    }

    #[test]
    fn unknown_name_falls_back_to_gray() {
        assert_eq!(lookup("nope", 0.5), lookup("gray", 0.5));
    }
}
