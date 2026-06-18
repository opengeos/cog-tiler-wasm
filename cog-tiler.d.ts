/**
 * cog-tiler-wasm - reusable client-side COG tiling for MapLibre/Leaflet.
 * High-level wrapper over the wasm `CogTiler` + whitebox-wasm `CogStream`.
 */

export interface RenderOptions {
  /** Low end of the rescale range (continuous bands). Default 0. */
  min?: number;
  /** High end of the rescale range (continuous bands). Default 1. */
  max?: number;
  /** Colormap name: "viridis" | "magma" | "terrain" | "gray". Default "viridis". */
  colormap?: string;
}

/** A level descriptor from `CogStream.levels_json()`. */
export interface LevelInfo {
  level: number;
  width: number;
  height: number;
  tile_width: number;
  tile_height: number;
  tiles_x: number;
  tiles_y: number;
  bands: number;
  bits_per_sample: number;
  sample_format: string;
  compression: string;
}

/** An opened COG; renders XYZ tiles in either the 3857 or warp path. */
export declare class CogSource {
  /** "3857" (fast affine path) or "warp" (reprojected on the fly). */
  readonly mode: "3857" | "warp";
  /** Human-readable CRS label, e.g. "EPSG:3857" or "warped from +proj=aea". */
  readonly crsLabel: string;
  /** Overview levels, finest first. */
  readonly levels: LevelInfo[];
  /** WGS84 bounds [minLon, minLat, maxLon, maxLat] for fitBounds. */
  readonly boundsLonLat: number[];
  /** True when the band is paletted (categorical) and rendered via its table. */
  readonly hasPalette: boolean;
  /** Render an XYZ tile to a 256x256 RGBA buffer, or null if empty. (Paletted
   * tiles are a `Uint8ClampedArray`; continuous tiles are the wasm `render()`
   * `Uint8Array`.) */
  renderTileRGBA(
    z: number,
    x: number,
    y: number,
    opts?: RenderOptions,
  ): Promise<Uint8Array | Uint8ClampedArray | null>;
  /** Render an XYZ tile to PNG bytes (empty Uint8Array for a blank tile). */
  renderTilePNG(z: number, x: number, y: number, opts?: RenderOptions): Promise<Uint8Array>;

  // TiTiler-style read API.

  /** Dataset info (bounds, bands, dtype, nodata, overviews, min/maxzoom, ...). */
  info(): Record<string, unknown>;
  /** Dataset info as a GeoJSON Feature (bbox polygon + info properties). */
  infoGeoJSON(): Record<string, unknown>;
  /** Mapbox TileJSON document. */
  tilejson(opts?: {
    tilesUrl?: string;
    minzoom?: number;
    maxzoom?: number;
    scheme?: string;
  }): Record<string, unknown>;
  /** Band value(s) at a WGS84 lon/lat. `bidx` is 1-based; default all bands. */
  point(
    lon: number,
    lat: number,
    opts?: { bidx?: number[] },
  ): Promise<{ coordinates: [number, number]; values: number[]; band_names: string[]; outside?: boolean }>;
  /** Per-band statistics from a decimated overview (≤ `maxSize` px wide). */
  statistics(opts?: { maxSize?: number }): Promise<Record<string, Record<string, unknown>>>;
}

/** Initialize the wasm modules (idempotent). Resolve before `openCog`. */
export declare function init(): Promise<unknown>;

/**
 * Open a COG and return a {@link CogSource} ready to render XYZ tiles. Pass a URL
 * string (read via HTTP range) or in-memory bytes / a Blob / a File for a local
 * raster.
 */
export declare function openCog(source: string | ArrayBuffer | Uint8Array | Blob): Promise<CogSource>;

/** Encode a 256x256 RGBA buffer to PNG bytes (browser; uses OffscreenCanvas). */
export declare function rgbaToPng(rgba: Uint8Array | Uint8ClampedArray): Promise<Uint8Array>;

/** Minimal shape of the maplibre-gl module needed to register a protocol. */
export interface MapLibreLike {
  addProtocol(
    name: string,
    handler: (params: { url: string }) => Promise<{ data: Uint8Array }>,
  ): void;
}

/**
 * Register a MapLibre custom protocol (e.g. `cog://{z}/{x}/{y}`). `resolve()` is
 * called per tile and returns the active source + render settings.
 */
export declare function registerCogProtocol(
  maplibregl: MapLibreLike,
  name: string,
  resolve: () => { source: CogSource | null; render?: RenderOptions } | null,
): void;
