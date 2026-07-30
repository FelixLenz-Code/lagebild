import type { Context } from 'hono';
import type { Coords } from '@lagebild/shared';

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
