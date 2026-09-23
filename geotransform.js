/**
 * Geotransform helpers for cog-tiler.js. Kept in their own module (like
 * sampling.js) so they can be unit tested without the wasm build.
 */

/** Reverses a row-major buffer's rows in place (north <-> south). */
export function flipRows(buf, w, h) {
  const scratch = buf.slice(0, w);
  for (let top = 0, bottom = h - 1; top < bottom; top++, bottom--) {
    scratch.set(buf.subarray(top * w, top * w + w));
    buf.copyWithin(top * w, bottom * w, bottom * w + w);
    buf.set(scratch, bottom * w);
  }
  return buf;
}

/**
 * A GDAL geotransform (`[x0, px_w, rot, y0, rot, px_h]`) from geotiff.js tags,
 * or null when the file has no affine georeferencing. whitebox-wasm's header
 * parser only understands ModelPixelScale + ModelTiepoint, so a file
 * georeferenced by ModelTransformation alone (e.g. the AlphaEarth embedding
 * COGs) comes back with an empty transform. The matrix is read raw rather than
 * through `getResolution()`, which reports north-up signs and would hide a
 * bottom-up raster.
 */
export function geoTransformFromTags(transformation, tiepoint, pixelScale) {
  if (transformation && transformation.length >= 8) {
    return [transformation[3], transformation[0], transformation[1], transformation[7], transformation[4], transformation[5]];
  }
  if (tiepoint && tiepoint.length >= 6 && pixelScale && pixelScale.length >= 2) {
    return [
      tiepoint[3] - tiepoint[0] * pixelScale[0], pixelScale[0], 0,
      tiepoint[4] + tiepoint[1] * pixelScale[1], 0, -pixelScale[1],
    ];
  }
  return null;
}

/**
 * Normalizes a geotransform to north-up. A bottom-up raster (positive pixel
 * height: row 0 is the southern edge) is described by the equivalent north-up
 * transform plus `flipY`, so every window/point calculation can keep assuming
 * row 0 is north; reads then mirror the row range and flip the rows back (see
 * {@link CogSource#_assembleWindow}). Rotated transforms are rejected.
 */
export function normalizeGeoTransform(gt, height) {
  if (!Array.isArray(gt) && !ArrayBuffer.isView(gt)) throw new Error("missing geotransform");
  const t = Array.from(gt);
  if (t.length !== 6 || !t.every(Number.isFinite)) {
    throw new Error("the GeoTIFF has no affine georeferencing");
  }
  if (t[2] !== 0 || t[4] !== 0) throw new Error("rotated GeoTIFFs are not supported");
  if (t[5] > 0) return { gt: [t[0], t[1], 0, t[3] + height * t[5], 0, -t[5]], flipY: true };
  return { gt: t, flipY: false };
}
