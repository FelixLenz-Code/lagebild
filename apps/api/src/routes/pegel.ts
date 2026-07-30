import { Hono } from 'hono';
import type { WaterLevel } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { distanceKm } from '../lib/distance.js';

/**
 * Pegelstände aus PEGELONLINE (WSV) — nächstgelegene Messstellen inkl.
 * aktuellem Wert und Trend.
 * https://www.pegelonline.wsv.de/webservices/rest-api/v2/
 */
export const pegelRoute = new Hono();

interface RawTimeseries {
  shortname?: string;
  unit?: string;
  currentMeasurement?: { value?: number; timestamp?: string };
}

interface RawStation {
  shortname?: string;
  longname?: string;
  longitude?: number;
  latitude?: number;
  water?: { longname?: string; shortname?: string };
  timeseries?: RawTimeseries[];
}

pegelRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);
  const radiusKm = Math.min(Number(c.req.query('radiusKm') ?? 40) || 40, 150);

  const key = `pegel:${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}:${radiusKm}`;
  const cache = cached<WaterLevel[]>(key);
  if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

  const url =
    `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json` +
    `?latitude=${coords.lat}&longitude=${coords.lon}&radius=${radiusKm}` +
    `&includeTimeseries=true&includeCurrentMeasurement=true`;
  const stations = await fetchJson<RawStation[]>(url);

  const levels: WaterLevel[] = stations
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => {
      const c2 = { lat: s.latitude as number, lon: s.longitude as number };
      // Zeitreihe "W" = Wasserstand (in cm)
      const w = (s.timeseries ?? []).find((t) => t.shortname === 'W');
      return {
        level: {
          station: s.shortname ?? s.longname ?? 'Pegel',
          water: s.water?.longname ?? s.water?.shortname ?? '',
          levelCm: w?.currentMeasurement?.value ?? null,
          trend: null,
          measuredAt: w?.currentMeasurement?.timestamp ?? null,
          coordinates: c2,
        } satisfies WaterLevel,
        d: distanceKm(coords, c2),
      };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map((x) => x.level);

  cache.set(levels);
  return c.json(envelope(levels, 'PEGELONLINE (WSV)'));
});
