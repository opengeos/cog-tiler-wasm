/**
 * A host hook to adjust each COG's source CRS definition before it is used to
 * warp tiles: for example to add a datum shift (`+towgs84`) that the EPSG
 * tables in `geotiff-geokeys-to-proj4` leave out, so a raster on the British
 * National Grid lands where the host's other layers put it.
 */

let resolver = null;

/**
 * Set (or, with null, clear) the hook. It receives the proj4 definition
 * (a `+proj=...` string or WKT) and the COG's geo keys, and returns the
 * definition to use; returning nothing keeps the original.
 *
 * Applies to COGs opened after the call.
 *
 * @param {((def: string, geoKeys: Record<string, unknown>) => string | null | undefined) | null} fn
 */
export function setSourceCrsResolver(fn) {
  resolver = typeof fn === "function" ? fn : null;
}

/**
 * The definition to use for a COG: the hook's, when it gives one, else `def`.
 * A hook that throws leaves `def` unchanged.
 *
 * @param {string} def The definition built from the geo keys.
 * @param {Record<string, unknown>} geoKeys The COG's geo keys.
 * @returns {string}
 */
export function applySourceCrsResolver(def, geoKeys) {
  if (!resolver) return def;
  try {
    const adjusted = resolver(def, geoKeys);
    return typeof adjusted === "string" && adjusted.trim() ? adjusted : def;
  } catch {
    return def;
  }
}
