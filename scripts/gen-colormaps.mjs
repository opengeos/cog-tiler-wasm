#!/usr/bin/env node
/**
 * Generates `crates/cog-tiler-wasm/src/colormap.rs` from the colormap sprite.
 *
 * The sprite (`scripts/data/colormaps.png`, a 256xN RGBA strip with one row per
 * colormap) is the same asset the deck.gl GPU renderer samples, so generating
 * from it is what makes a named colormap look identical on both renderers
 * instead of merely similar. Hand-picked anchor stops drift: the previous
 * 9-stop `viridis` was off by up to 19/255 on a channel.
 *
 * Each row is reduced to the fewest anchor stops whose linear interpolation
 * reproduces all 256 entries within {@link TOLERANCE} per channel, which keeps
 * the wasm small (a full 256-entry table per ramp would add ~82 KB; the reduced
 * stops add ~7 KB) while staying visually exact. Smooth ramps collapse to a
 * handful of stops; step ramps (`tab20c`) and oscillating ones (`flag`,
 * `prism`) keep as many as they need, so their edges survive rather than being
 * smeared into gradients.
 *
 * Run `npm run gen:colormaps` after changing the sprite. The generated file is
 * committed, so a normal build never needs this script (and the repo keeps its
 * zero-dependency devDeps: the PNG is decoded here with only `node:zlib`).
 *
 * Sprite provenance: @developmentseed/deck.gl-raster (MIT, (c) 2025 Development
 * Seed); the ramps themselves originate from matplotlib and cmocean.
 */

import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPRITE = join(HERE, 'data', 'colormaps.png');
const INDEX = join(HERE, 'data', 'colormaps-index.json');
const OUT = join(HERE, '..', 'crates', 'cog-tiler-wasm', 'src', 'colormap.rs');

/** Maximum per-channel deviation an interpolated stop list may have, in 0-255.
 * At 2 the difference is imperceptible; raising it saves very little (the total
 * only drops from ~1750 stops to ~1500 at 4). */
const TOLERANCE = 2;

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG into `{ width, height, pixels }`.
 *
 * Deliberately minimal — just enough for the vendored sprite — so the repo does
 * not take an image-decoding dependency. Anything other than the sprite's exact
 * format is rejected rather than silently mis-decoded.
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [bitDepth, colorType, , , interlace] = [
    buf[24],
    buf[25],
    buf[26],
    buf[27],
    buf[28],
  ];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); ` +
        'this decoder handles 8-bit RGBA, non-interlaced only',
    );
  }

  // Concatenate every IDAT chunk, then inflate.
  const idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len; // length + type + data + crc
  }
  const raw = inflateSync(Buffer.concat(idat));

  // Undo the per-scanline filters (PNG spec 9.2). bpp = 4 for RGBA8.
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prior ? prior[i] : 0;
      const c = prior && i >= bpp ? prior[i - bpp] : 0;
      let value = line[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          // Paeth predictor.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      out[i] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

/**
 * The fewest anchor indices whose piecewise-linear interpolation reproduces
 * `row` within {@link TOLERANCE}.
 *
 * Greedy with a binary search for each stop's reach: from the current anchor,
 * find the furthest index still interpolating within tolerance, emit it, and
 * continue from there. Not provably minimal, but within a stop or two of it and
 * fast enough to run on every regeneration.
 */
function reduceStops(row) {
  const fits = (from, to) => {
    const span = to - from;
    for (let i = from; i <= to; i++) {
      const f = span === 0 ? 0 : (i - from) / span;
      for (let c = 0; c < 3; c++) {
        const lerp = row[from][c] + (row[to][c] - row[from][c]) * f;
        if (Math.abs(lerp - row[i][c]) > TOLERANCE) return false;
      }
    }
    return true;
  };

  const stops = [0];
  let i = 0;
  while (i < row.length - 1) {
    let lo = i + 1;
    let hi = row.length - 1;
    let best = i + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fits(i, mid)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    stops.push(best);
    i = best;
  }
  return stops;
}

const { width, height, pixels } = decodePng(readFileSync(SPRITE));
const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const names = Object.keys(index).sort();
if (names.length !== height) {
  throw new Error(`index lists ${names.length} colormaps but sprite has ${height} rows`);
}

/** Evaluates a stop list the way the generated Rust `lookup` does, so the
 * self-check below measures what will actually ship rather than re-deriving the
 * interpolation a second, subtly different way. */
function evalStops(stops, t) {
  const clamped = Math.min(Math.max(t, 0), 1);
  let prev = stops[0];
  for (const cur of stops.slice(1)) {
    if (clamped <= cur[0] / 255) {
      const lo = prev[0] / 255;
      const span = cur[0] / 255 - lo;
      const f = span > 0 ? (clamped - lo) / span : 0;
      return [0, 1, 2].map((c) =>
        Math.round(prev[1][c] + (cur[1][c] - prev[1][c]) * f),
      );
    }
    prev = cur;
  }
  return stops[stops.length - 1][1];
}

const ramps = names.map((name) => {
  const y = index[name];
  const row = [];
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    row.push([pixels[o], pixels[o + 1], pixels[o + 2]]);
  }
  const stops = reduceStops(row).map((i) => [i, row[i]]);

  // Verify the reduction against every sprite entry before emitting it. A
  // silently lossy ramp would be near-impossible to spot by eye in 107 of them.
  let worst = 0;
  for (let i = 0; i < row.length; i++) {
    const got = evalStops(stops, i / 255);
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(got[c] - row[i][c]));
    }
  }
  if (worst > TOLERANCE) {
    throw new Error(
      `${name}: reduced stops deviate by ${worst}/255, over the ${TOLERANCE} tolerance`,
    );
  }
  return { name, stops, worst, row };
});

const totalStops = ramps.reduce((n, r) => n + r.stops.length, 0);
const maxError = ramps.reduce((m, r) => Math.max(m, r.worst), 0);

/** Golden samples: exact sprite values a few ramps must reproduce, so the Rust
 * test suite catches a regression even though it cannot read the sprite. */
const GOLDEN = ['viridis', 'terrain', 'tab20c', 'flag', 'rdbu'].filter((n) =>
  names.includes(n),
);
const goldenAsserts = GOLDEN.flatMap((name) => {
  const { row } = ramps.find((r) => r.name === name);
  return [0, 64, 128, 192, 255].map((i) => {
    const [r, g, b] = row[i];
    return `        assert_close(lookup("${name}", ${(i / 255).toFixed(6)}), [${r}, ${g}, ${b}]);`;
  });
}).join('\n');

const body = ramps
  .map(({ name, stops }) => {
    const ident = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const entries = stops
      .map(([pos, [r, g, b]]) => `(${pos}, [${r}, ${g}, ${b}])`)
      .join(', ');
    return `/// \`${name}\`, ${stops.length} anchor stops.\nconst ${ident}: &[Stop] = &[${entries}];`;
  })
  .join('\n\n');

const table = ramps
  .map(({ name }) => {
    const ident = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return `    ("${name}", ${ident}),`;
  })
  .join('\n');

const out = `//! Built-in colormaps, generated from the colormap sprite.
//!
//! DO NOT EDIT BY HAND. Regenerate with \`npm run gen:colormaps\`, which reads
//! \`scripts/data/colormaps.png\` (the same sprite the deck.gl GPU renderer
//! samples, so a named colormap matches on both) and reduces each 256-entry row
//! to the fewest anchor stops that reproduce it within ${TOLERANCE}/255 per channel.
//!
//! Positions are the sprite's own 0-255 index; \`lookup\` normalizes them. Pass a
//! normalized value \`t\` in \`[0, 1]\`; out-of-range values are clamped, and an
//! unknown name falls back to \`gray\`.
//!
//! ${ramps.length} colormaps, ${totalStops} stops total.

/// One anchor: the sprite index it was sampled at, and its RGB.
type Stop = (u8, [u8; 3]);

${body}

/// Every built-in colormap, sorted by name so \`stops\` can binary-search.
const RAMPS: &[(&str, &[Stop])] = &[
${table}
];

fn stops(name: &str) -> &'static [Stop] {
    match RAMPS.binary_search_by(|(n, _)| (*n).cmp(name)) {
        Ok(i) => RAMPS[i].1,
        // "grey", "", and unknown names.
        Err(_) => GRAY,
    }
}

/// Names of all built-in colormaps, sorted.
pub const NAMES: &[&str] = &[
${ramps.map(({ name }) => `    "${name}",`).join('\n')}
];

/// Look up the RGB color for normalized value \`t\` in the named colormap.
pub fn lookup(name: &str, t: f64) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    let table = stops(name);
    let mut prev = table[0];
    for &cur in &table[1..] {
        if t <= f64::from(cur.0) / 255.0 {
            let lo = f64::from(prev.0) / 255.0;
            let hi = f64::from(cur.0) / 255.0;
            let span = hi - lo;
            let f = if span > 0.0 { (t - lo) / span } else { 0.0 };
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
    (f64::from(a) + (f64::from(b) - f64::from(a)) * f).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_match_anchor_stops() {
        assert_eq!(lookup("viridis", 0.0), [68, 1, 84]);
        // The sprite is the source of truth, and its final viridis entry is
        // [253, 231, 36] -- one off matplotlib's canonical [253, 231, 37],
        // which is what the previous hand-written stops used. Matching the
        // sprite is the point: it is what the GPU renderer samples.
        assert_eq!(lookup("viridis", 1.0), [253, 231, 36]);
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

    #[test]
    fn names_are_sorted_and_resolvable() {
        // stops() binary-searches RAMPS, so the order is load-bearing.
        let mut sorted = NAMES.to_vec();
        sorted.sort_unstable();
        assert_eq!(NAMES, sorted.as_slice());
        assert_eq!(NAMES.len(), RAMPS.len());
        // Every listed name must be found by the search rather than falling
        // through to the default. Identity is checked via the search itself,
        // not by comparing table pointers: ramps with identical data (gray and
        // gist_gray are byte-for-byte equal in the sprite) are deduplicated by
        // the compiler, so a pointer comparison would report a false failure.
        for name in NAMES {
            assert!(
                RAMPS.binary_search_by(|(n, _)| (*n).cmp(name)).is_ok(),
                "{name} did not resolve"
            );
        }
        assert!(RAMPS
            .binary_search_by(|(n, _)| (*n).cmp("definitely-not-a-colormap"))
            .is_err());
    }

    #[test]
    fn covers_the_whole_sprite() {
        assert_eq!(NAMES.len(), ${ramps.length});
    }

    /// Asserts within the generator's tolerance: the stops approximate the
    /// sprite rather than storing it entry for entry.
    fn assert_close(got: [u8; 3], want: [u8; 3]) {
        for c in 0..3 {
            let delta = i16::from(got[c]) - i16::from(want[c]);
            assert!(
                delta.abs() <= ${TOLERANCE},
                "got {got:?} want {want:?} (channel {c} off by {delta})"
            );
        }
    }

    #[test]
    fn reproduces_sprite_values() {
        // Golden samples taken straight from the sprite, covering a smooth ramp,
        // a diverging one, a stepped qualitative one, and an oscillating one.
${goldenAsserts}
    }
}
`;

writeFileSync(OUT, out);

// Emit through rustfmt so regenerating leaves the tree `cargo fmt --check`
// clean. Without this the long stop literals get reflowed on the next fmt run
// and the generated file shows up as a spurious diff.
const fmt = spawnSync('rustfmt', ['--edition', '2021', OUT], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
if (fmt.error?.code === 'ENOENT') {
  console.error('warning: rustfmt not found; run `cargo fmt` before committing');
} else if (fmt.status !== 0) {
  throw new Error(`rustfmt failed: ${fmt.stderr?.toString().trim()}`);
}

console.error(
  `wrote ${OUT} with ${ramps.length} colormaps, ${totalStops} stops ` +
    `(max error ${maxError}/255, tolerance ${TOLERANCE})`,
);
