#!/usr/bin/env node
// Zero-dependency static server for the demo with HTTP Range support, which the
// COG tile streaming requires (the stdlib python http.server does not do Range).
// Serves ./demo on PORT (default 8000).
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "demo");
const port = Number(process.env.PORT) || 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".css": "text/css",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = normalize(join(root, urlPath));
  if (!filePath.startsWith(root)) return res.writeHead(403).end();

  let st;
  try {
    st = await stat(filePath);
  } catch {
    return res.writeHead(404).end("not found");
  }
  if (!st.isFile()) return res.writeHead(404).end("not found");

  const type = TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${st.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    createReadStream(filePath).pipe(res);
  }
});

server.listen(port, () => console.log(`cog-tiler-wasm demo: http://localhost:${port}/`));
