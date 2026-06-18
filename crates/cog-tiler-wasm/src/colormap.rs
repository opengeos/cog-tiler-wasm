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

// plasma, 9 anchor stops.
const PLASMA: &[Stop] = &[
    (0.000, [13, 8, 135]),
    (0.125, [75, 3, 161]),
    (0.250, [125, 3, 168]),
    (0.375, [168, 34, 150]),
    (0.500, [203, 70, 121]),
    (0.625, [229, 107, 93]),
    (0.750, [248, 148, 65]),
    (0.875, [253, 195, 40]),
    (1.000, [240, 249, 33]),
];

// inferno, 9 anchor stops.
const INFERNO: &[Stop] = &[
    (0.000, [0, 0, 4]),
    (0.125, [31, 12, 72]),
    (0.250, [85, 15, 109]),
    (0.375, [136, 34, 106]),
    (0.500, [186, 54, 85]),
    (0.625, [227, 89, 51]),
    (0.750, [249, 140, 10]),
    (0.875, [249, 201, 50]),
    (1.000, [252, 255, 164]),
];

// cividis, 9 anchor stops.
const CIVIDIS: &[Stop] = &[
    (0.000, [0, 32, 76]),
    (0.125, [0, 42, 102]),
    (0.250, [45, 63, 98]),
    (0.375, [78, 85, 99]),
    (0.500, [109, 108, 99]),
    (0.625, [143, 133, 92]),
    (0.750, [180, 159, 79]),
    (0.875, [220, 187, 58]),
    (1.000, [255, 234, 70]),
];

// turbo, 9 anchor stops.
const TURBO: &[Stop] = &[
    (0.000, [48, 18, 59]),
    (0.125, [70, 107, 227]),
    (0.250, [40, 177, 228]),
    (0.375, [42, 224, 160]),
    (0.500, [140, 254, 77]),
    (0.625, [213, 234, 47]),
    (0.750, [252, 168, 49]),
    (0.875, [231, 84, 17]),
    (1.000, [122, 4, 3]),
];

// Sequential single-hue ramps.
const BLUES: &[Stop] = &[
    (0.00, [247, 251, 255]),
    (0.25, [198, 219, 239]),
    (0.50, [107, 174, 214]),
    (0.75, [33, 113, 181]),
    (1.00, [8, 48, 107]),
];
const GREENS: &[Stop] = &[
    (0.00, [247, 252, 245]),
    (0.25, [199, 233, 192]),
    (0.50, [116, 196, 118]),
    (0.75, [35, 139, 69]),
    (1.00, [0, 68, 27]),
];
const REDS: &[Stop] = &[
    (0.00, [255, 245, 240]),
    (0.25, [252, 187, 161]),
    (0.50, [251, 106, 74]),
    (0.75, [203, 24, 29]),
    (1.00, [103, 0, 13]),
];

// Diverging ramps.
const RDYLGN: &[Stop] = &[
    (0.00, [165, 0, 38]),
    (0.25, [244, 109, 67]),
    (0.50, [255, 255, 191]),
    (0.75, [102, 189, 99]),
    (1.00, [0, 104, 55]),
];
const SPECTRAL: &[Stop] = &[
    (0.00, [158, 1, 66]),
    (0.25, [244, 109, 67]),
    (0.50, [255, 255, 191]),
    (0.75, [102, 194, 165]),
    (1.00, [94, 79, 162]),
];

fn stops(name: &str) -> &'static [Stop] {
    match name {
        "viridis" => VIRIDIS,
        "magma" => MAGMA,
        "plasma" => PLASMA,
        "inferno" => INFERNO,
        "cividis" => CIVIDIS,
        "turbo" => TURBO,
        "terrain" => TERRAIN,
        "blues" => BLUES,
        "greens" => GREENS,
        "reds" => REDS,
        "rdylgn" => RDYLGN,
        "spectral" => SPECTRAL,
        _ => GRAY, // "gray", "grey", "", and unknown names
    }
}

/// Names of all built-in colormaps.
pub const NAMES: &[&str] = &[
    "viridis", "magma", "plasma", "inferno", "cividis", "turbo", "terrain", "blues", "greens",
    "reds", "rdylgn", "spectral", "gray",
];

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
