#!/usr/bin/env node
// Copy the reusable module + sample into demo/ so the page (which imports
// ./cog-tiler.js next to ./cog_tiler_wasm.js) can be served statically. The wasm
// is built into demo/ by the `build:wasm` script.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
copyFileSync(join(root, "cog-tiler.js"), join(root, "demo", "cog-tiler.js"));
copyFileSync(join(root, "examples", "sample-3857-cog.tif"), join(root, "demo", "sample-3857-cog.tif"));
console.log("assembled demo/ (cog-tiler.js + sample-3857-cog.tif)");
