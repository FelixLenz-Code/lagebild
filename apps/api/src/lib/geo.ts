import type { Context } from 'hono';
import type { Coords } from '@lagebild/shared';

/** Rechteckiger Kartenausschnitt (WGS84). */
export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Liest und validiert `lat`/`lon` aus der Query. Gibt bei ungültigen Werten
 * `null` zurück, sodass die Route mit HTTP 400 antworten kann.
 */
export function readCoords(c: Context): Coords | null {
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Liest `bbox=west,south,east,north` aus der Query. */
export function readBbox(c: Context): Bbox | null {
  const raw = c.req.query('bbox');
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west > east || south > north) return null;
  return { west, south, east, north };
}

/** Liegt ein Punkt innerhalb des Ausschnitts? */
export function inBbox(c: Coords, b: Bbox): boolean {
  return c.lon >= b.west && c.lon <= b.east && c.lat >= b.south && c.lat <= b.north;
}

export function bboxCenter(b: Bbox): Coords {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}
