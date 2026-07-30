import { Hono } from 'hono';
import type { ApiEnvelope, WeatherNow, WeatherCondition } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';

/**
 * Wetter aus der Bright-Sky-API (offizielle DWD-Daten, ohne API-Key).
 * https://brightsky.dev/docs/
 */
export const weatherRoute = new Hono();

const BRIGHT_SKY = 'https://api.brightsky.dev';

interface BrightSkyCurrent {
  weather?: {
    timestamp?: string;
    temperature?: number | null;
    wind_speed?: number | null;
    wind_gust_speed?: number | null;
    wind_direction?: number | null;
    relative_humidity?: number | null;
    precipitation_10?: number | null;
    pressure_msl?: number | null;
    condition?: string | null;
    icon?: string | null;
  };
}

function toEnvelope(now: WeatherNow): ApiEnvelope<WeatherNow> {
  return { data: now, source: 'Bright Sky (DWD)', fetchedAt: new Date().toISOString() };
}

weatherRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `weather:${coords.lat.toFixed(3)}:${coords.lon.toFixed(3)}`;
  const cache = cached<WeatherNow>(key);
  if (cache.hit) return c.json({ ...toEnvelope(cache.hit), stale: false });

  const url = `${BRIGHT_SKY}/current_weather?lat=${coords.lat}&lon=${coords.lon}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return c.json({ error: `Bright Sky ${res.status}` }, 502);

  const body = (await res.json()) as BrightSkyCurrent;
  const w = body.weather ?? {};
  const now: WeatherNow = {
    tempC: w.temperature ?? null,
    feelsLikeC: null,
    condition: (w.condition as WeatherCondition) ?? null,
    icon: w.icon ?? null,
    windKmh: w.wind_speed ?? null,
    windGustKmh: w.wind_gust_speed ?? null,
    windDirDeg: w.wind_direction ?? null,
    humidityPct: w.relative_humidity ?? null,
    precipitationMm: w.precipitation_10 ?? null,
    pressureHpa: w.pressure_msl ?? null,
    observedAt: w.timestamp ?? null,
  };
  cache.set(now);
  return c.json(toEnvelope(now));
});
