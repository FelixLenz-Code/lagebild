import { Hono } from 'hono';
import type {
  ApiEnvelope,
  WeatherNow,
  WeatherCondition,
  WeatherForecast,
  WeatherForecastStep,
  WeatherDay,
} from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

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

/**
 * Gefühlte Temperatur (Australian Apparent Temperature): berücksichtigt
 * Luftfeuchte und Wind, gilt sowohl bei Hitze als auch bei Kälte.
 */
function apparentTempC(
  tempC: number | null | undefined,
  humidityPct: number | null | undefined,
  windKmh: number | null | undefined,
): number | null {
  if (tempC == null || humidityPct == null) return null;
  const vapourPressure = (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  const windMs = ((windKmh ?? 0) * 1000) / 3600;
  return Math.round((tempC + 0.33 * vapourPressure - 0.7 * windMs - 4) * 10) / 10;
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
    feelsLikeC: apparentTempC(w.temperature, w.relative_humidity, w.wind_speed),
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

// --- Vorhersage ---------------------------------------------------------

interface BrightSkyHour {
  timestamp: string;
  temperature?: number | null;
  precipitation?: number | null;
  precipitation_probability?: number | null;
  wind_speed?: number | null;
  wind_gust_speed?: number | null;
  condition?: string | null;
  icon?: string | null;
}

/** Je „schwerer" das Wetter, desto höher — bestimmt das prägende Tageswetter. */
const CONDITION_RANK: Record<string, number> = {
  'clear-day': 0,
  'clear-night': 0,
  dry: 1,
  'partly-cloudy-day': 2,
  'partly-cloudy-night': 2,
  cloudy: 3,
  fog: 4,
  rain: 5,
  sleet: 6,
  snow: 7,
  hail: 8,
  thunderstorm: 9,
};

const YMD = (iso: string) => iso.slice(0, 10);
const HOUR = (iso: string) => Number(iso.slice(11, 13));

function num(values: (number | null | undefined)[], pick: (a: number, b: number) => number): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number');
  return nums.length ? nums.reduce((a, b) => pick(a, b)) : null;
}

/** Häufigstes Symbol einer Stundenliste (prägt das Tagesbild bei trockenem Wetter). */
function commonIcon(hours: BrightSkyHour[]): string | null {
  const counts = new Map<string, number>();
  for (const h of hours) if (h.icon) counts.set(h.icon, (counts.get(h.icon) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [icon, n] of counts) if (n > bestN) [best, bestN] = [icon, n];
  return best;
}

function toStep(h: BrightSkyHour): WeatherForecastStep {
  return {
    time: h.timestamp,
    tempC: h.temperature ?? null,
    condition: (h.condition as WeatherCondition) ?? null,
    icon: h.icon ?? null,
    precipitationProbabilityPct: h.precipitation_probability ?? null,
    precipitationMm: h.precipitation ?? null,
    windKmh: h.wind_speed ?? null,
    windGustKmh: h.wind_gust_speed ?? null,
  };
}

/** Fasst die Stundenwerte eines Kalendertages zusammen. */
function toDay(date: string, hours: BrightSkyHour[]): WeatherDay {
  // Prägendes Wetter aus den Tagstunden (nachts ist „klar" wenig aussagekräftig).
  const daytime = hours.filter((h) => HOUR(h.timestamp) >= 6 && HOUR(h.timestamp) <= 20);
  const relevant = daytime.length ? daytime : hours;
  const rank = (h: BrightSkyHour) => CONDITION_RANK[h.condition ?? ''] ?? -1;
  // Eine einzelne Nebel- oder Schauerstunde soll den Tag nicht umdeuten:
  // gewertet wird das schwerste Wetter, das mindestens zwei Stunden anhält.
  const hoursPerCondition = new Map<string, number>();
  for (const h of relevant) {
    const key = h.condition ?? '';
    hoursPerCondition.set(key, (hoursPerCondition.get(key) ?? 0) + 1);
  }
  const lasting = relevant.filter((h) => (hoursPerCondition.get(h.condition ?? '') ?? 0) >= 2);
  const worst = (lasting.length ? lasting : relevant).reduce((a, b) => (rank(b) > rank(a) ? b : a));
  // Bei Niederschlag passt das Symbol der schwersten Stunde, sonst das häufigste.
  const wet = (CONDITION_RANK[worst.condition ?? ''] ?? 0) >= CONDITION_RANK.rain!;
  const icon = (wet ? worst.icon : commonIcon(relevant)) ?? worst.icon ?? null;
  const sumPrecip = hours
    .map((h) => h.precipitation)
    .filter((v): v is number => typeof v === 'number')
    .reduce((a, b) => a + b, 0);
  return {
    date,
    tempMinC: num(hours.map((h) => h.temperature), Math.min),
    tempMaxC: num(hours.map((h) => h.temperature), Math.max),
    condition: (worst.condition as WeatherCondition) ?? null,
    icon,
    precipitationProbabilityPct: num(hours.map((h) => h.precipitation_probability), Math.max),
    precipitationMm: Math.round(sumPrecip * 10) / 10,
    windKmh: num(hours.map((h) => h.wind_speed), Math.max),
    windGustKmh: num(hours.map((h) => h.wind_gust_speed), Math.max),
  };
}

/**
 * 7-Tage-Vorhersage (stündlich + tagesweise) aus Bright Sky. Die Zeitstempel
 * kommen bereits in deutscher Ortszeit, damit die Tagesgrenzen stimmen.
 */
weatherRoute.get('/forecast', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `forecast:${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}`;
  const cache = cached<WeatherForecast>(key, 900);
  if (cache.hit) return c.json(envelope(cache.hit, 'Bright Sky (DWD)', true));

  const from = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const url =
    `${BRIGHT_SKY}/weather?lat=${coords.lat}&lon=${coords.lon}` +
    `&date=${from}&last_date=${to}&tz=Europe/Berlin`;
  const body = await fetchJson<{ weather?: BrightSkyHour[] }>(url, { timeoutMs: 12000 });
  const hours = (body.weather ?? []).filter((h) => typeof h.timestamp === 'string');

  // Stundenverlauf: ab der laufenden Stunde, 48 Stunden voraus.
  const cutoff = Date.now() - 3600_000;
  const hourly = hours.filter((h) => new Date(h.timestamp).getTime() >= cutoff).slice(0, 48).map(toStep);

  // Tagesübersicht: nur Tage mit brauchbarer Abdeckung (heute darf angebrochen sein).
  const byDay = new Map<string, BrightSkyHour[]>();
  for (const h of hours) {
    const d = YMD(h.timestamp);
    const list = byDay.get(d);
    if (list) list.push(h);
    else byDay.set(d, [h]);
  }
  const today = YMD(hours[0]?.timestamp ?? new Date().toISOString());
  const daily = [...byDay.entries()]
    .filter(([date, hs]) => date >= today && (date === today || hs.length >= 12))
    .slice(0, 7)
    .map(([date, hs]) => toDay(date, hs));

  const data: WeatherForecast = { hourly, daily };
  cache.set(data);
  return c.json(envelope(data, 'Bright Sky (DWD)'));
});
