#!/usr/bin/env node
// Copy the reusable module, the sibling modules it imports, and the sample into
// demo/ so the page (which imports ./cog-tiler.js next to ./cog_tiler_wasm.js)
// can be served statically. The wasm is built into demo/ by `build:wasm`.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
for (const f of ["cog-tiler.js", "sampling.js", "header-window.js"]) {
  copyFileSync(join(root, f), join(root, "demo", f));
}
copyFileSync(join(root, "examples", "sample-3857-cog.tif"), join(root, "demo", "sample-3857-cog.tif"));
console.log("assembled demo/ (cog-tiler.js + its sibling modules + sample-3857-cog.tif)");
