import { Hono } from 'hono';
import type { WindField, WindPoint } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { readBbox } from '../lib/geo.js';

/**
 * Windfeld über dem Kartenausschnitt aus Open-Meteo (frei, ohne Key).
 *
 * Open-Meteo beantwortet mehrere Koordinaten in einer Anfrage — daraus wird
 * ein gleichmäßiges Gitter über den Ausschnitt gelegt und als Pfeilfeld
 * dargestellt. Kachel-Dienste für Wind gibt es frei nicht, das Gitter ist der
 * praktikable Weg.
 */
export const windRoute = new Hono();

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
/** Gitterweite: reicht für ein lesbares Pfeilfeld, bleibt eine Anfrage. */
const COLS = 8;
const ROWS = 6;

interface OmCurrent {
  latitude?: number;
  longitude?: number;
  current?: {
    time?: string;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    wind_gusts_10m?: number;
  };
}

windRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);

  // Gitterpunkte mittig in ihre Zelle legen, damit der Rand nicht überhängt.
  const lats: number[] = [];
  const lons: number[] = [];
  const dLat = (bbox.north - bbox.south) / ROWS;
  const dLon = (bbox.east - bbox.west) / COLS;
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      lats.push(bbox.south + dLat * (r + 0.5));
      lons.push(bbox.west + dLon * (col + 0.5));
    }
  }

  const key = `wind:${lats[0]!.toFixed(2)}:${lons[0]!.toFixed(2)}:${dLat.toFixed(3)}:${dLon.toFixed(3)}`;
  const cache = cached<WindField>(key, 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'Open-Meteo', true));

  const url =
    `${OPEN_METEO}?latitude=${lats.map((v) => v.toFixed(3)).join(',')}` +
    `&longitude=${lons.map((v) => v.toFixed(3)).join(',')}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh`;
  const body = await fetchJson<OmCurrent[] | OmCurrent>(url, { timeoutMs: 10000 });
  const entries = Array.isArray(body) ? body : [body];

  const points: WindPoint[] = entries
    .filter(
      (e) =>
        typeof e.latitude === 'number' &&
        typeof e.longitude === 'number' &&
        typeof e.current?.wind_speed_10m === 'number' &&
        typeof e.current?.wind_direction_10m === 'number',
    )
    .map((e) => ({
      coordinates: { lat: e.latitude!, lon: e.longitude! },
      speedKmh: Math.round(e.current!.wind_speed_10m!),
      gustKmh: e.current!.wind_gusts_10m != null ? Math.round(e.current!.wind_gusts_10m) : null,
      directionDeg: Math.round(e.current!.wind_direction_10m!),
    }));

  const data: WindField = { points, time: entries[0]?.current?.time ?? null };
  cache.set(data);
  return c.json(envelope(data, 'Open-Meteo'));
});
