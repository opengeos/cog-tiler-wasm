#!/usr/bin/env node
// Assemble the publishable npm package from the wasm-pack output:
//   1. copy the reusable JS module + its types into the pkg dir, and
//   2. patch pkg/package.json so the high-level module is the main entry,
//      with `exports`, `types`, peer deps, and the wasm available at "./wasm".
//
// Usage: node scripts/prepare-pkg.mjs [pkgDir]
// Honors PKG_VERSION to override the package version (set from the release tag).

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = process.argv[2] || join(root, "crates/cog-tiler-wasm/pkg");

copyFileSync(join(root, "cog-tiler.js"), join(pkgDir, "cog-tiler.js"));
copyFileSync(join(root, "cog-tiler.d.ts"), join(pkgDir, "cog-tiler.d.ts"));
copyFileSync(join(root, "README.md"), join(pkgDir, "README.md"));
copyFileSync(join(root, "LICENSE"), join(pkgDir, "LICENSE"));

const pkgPath = join(pkgDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

if (process.env.PKG_VERSION) pkg.version = process.env.PKG_VERSION;

// High-level module is the main entry; the raw wasm tiler is a subpath.
pkg.main = "cog-tiler.js";
pkg.module = "cog-tiler.js";
pkg.types = "cog-tiler.d.ts";
pkg.exports = {
  ".": { types: "./cog-tiler.d.ts", default: "./cog-tiler.js" },
  "./wasm": { types: "./cog_tiler_wasm.d.ts", default: "./cog_tiler_wasm.js" },
};
pkg.files = Array.from(
  new Set([...(pkg.files || []), "cog-tiler.js", "cog-tiler.d.ts", "README.md", "LICENSE"]),
);

// The high-level module needs these at runtime; consumers provide them.
// geotiff accepts v2 or v3: only the stable high-level API (fromUrl,
// fromBlob, fromArrayBuffer, getImage, getGeoKeys, readRasters) is used, which
// is unchanged across the v3 major, so the range must not block v3 consumers.
pkg.peerDependencies = {
  "whitebox-wasm": "^0.4.0",
  proj4: "^2.15.0",
  geotiff: "^2.1.0 || ^3.0.0",
  "geotiff-geokeys-to-proj4": "^2024.4.13",
};
pkg.keywords = [
  "cog", "geotiff", "tiler", "webassembly", "wasm",
  "maplibre", "xyz", "web-mercator", "titiler", "raster",
];
pkg.homepage = "https://opengeos.github.io/cog-tiler-wasm/";

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`prepared ${pkgPath} (version ${pkg.version})`);
