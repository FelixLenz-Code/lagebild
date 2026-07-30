import { Hono } from 'hono';
import type { AirQuality, AirCategory } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Luftqualität nach European Air Quality Index über Open-Meteo (CAMS-Daten,
 * ohne API-Key, standortgenau).
 * https://open-meteo.com/en/docs/air-quality-api
 */
export const airRoute = new Hono();

function categorize(aqi: number | null): AirCategory | null {
  if (aqi == null) return null;
  if (aqi <= 20) return 'good';
  if (aqi <= 40) return 'fair';
  if (aqi <= 60) return 'moderate';
  if (aqi <= 80) return 'poor';
  if (aqi <= 100) return 'very-poor';
  return 'extremely-poor';
}

interface OmAir {
  current?: {
    time?: string;
    european_aqi?: number;
    pm10?: number;
    pm2_5?: number;
    nitrogen_dioxide?: number;
    ozone?: number;
  };
}

airRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `air:${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}`;
  const cache = cached<AirQuality>(key);
  if (cache.hit) return c.json(envelope(cache.hit, 'Open-Meteo (CAMS)', true));

  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${coords.lat}&longitude=${coords.lon}` +
    `&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone`;
  const d = await fetchJson<OmAir>(url);
  const cur = d.current ?? {};
  const air: AirQuality = {
    aqi: cur.european_aqi ?? null,
    category: categorize(cur.european_aqi ?? null),
    pm10: cur.pm10 ?? null,
    pm25: cur.pm2_5 ?? null,
    no2: cur.nitrogen_dioxide ?? null,
    o3: cur.ozone ?? null,
    measuredAt: cur.time ?? null,
  };

  cache.set(air);
  return c.json(envelope(air, 'Open-Meteo (CAMS)'));
});
