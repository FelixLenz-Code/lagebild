import { Hono } from 'hono';
import type { AprsStation, AprsWeather } from '@lagebild/shared';
import { config } from '../config.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Amateurfunk-Positionen (APRS) von aprs.fi.
 *
 * Die API beantwortet ausdrücklich nur Abfragen konkreter Rufzeichen — keine
 * Umkreis- oder Wildcard-Suche. Das Frontend führt deshalb eine Beobachtungs-
 * liste, die hier gebündelt abgefragt wird (max. 20 Ziele pro Anfrage).
 *
 * Nutzungsbedingungen (https://aprs.fi/page/api), an die sich diese Route hält:
 * eigener API-Key je Nutzer, sprechender User-Agent, Abruf nur auf Anforderung
 * (kein Vorab-Sammeln), kurzes Caching erwünscht, Rückzug per Backoff bei
 * Fehlern. Die Quellenangabe mit Rücklink leistet das Frontend.
 */
export const aprsRoute = new Hono();

const MAX_TARGETS = 20;
/** aprs.fi bittet darum, nicht öfter als nötig zu fragen. */
const CACHE_SECONDS = 45;

interface AprsEntry {
  name?: string;
  showname?: string;
  type?: string;
  class?: string;
  time?: string;
  lasttime?: string;
  lat?: string;
  lng?: string;
  course?: string;
  speed?: string;
  altitude?: string;
  symbol?: string;
  comment?: string;
  status?: string;
  path?: string;
}
interface AprsWxEntry {
  name?: string;
  time?: string;
  temp?: string;
  pressure?: string;
  humidity?: string;
  wind_direction?: string;
  wind_speed?: string;
  wind_gust?: string;
  rain_1h?: string;
}
interface AprsResponse<T> {
  result?: string;
  description?: string;
  found?: number;
  entries?: T[];
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (v: string | undefined): string | null => {
  const n = num(v);
  return n == null ? null : new Date(n * 1000).toISOString();
};

const KIND_BY_TYPE: Record<string, AprsStation['kind']> = {
  l: 'station',
  o: 'object',
  i: 'item',
  w: 'weather',
  a: 'ais',
};

/** m/s → km/h (aprs.fi meldet Windwerte in m/s, Fahrzeugtempo in km/h). */
const msToKmh = (v: number | null): number | null => (v == null ? null : Math.round(v * 3.6 * 10) / 10);

// aprs.fi bittet um exponentielles Zurückfahren, wenn Anfragen scheitern.
let failures = 0;
let retryAfter = 0;
/** Wird gesetzt, wenn der Key abgelehnt wurde — dann bleibt die Ebene aus. */
let authFailed = false;

/** Steuert den Karten-Chip: nur mit Key und funktionierendem Zugang. */
export function aprsUsable(): boolean {
  return Boolean(config.aprsKey) && !authFailed;
}

function noteFailure(): void {
  failures += 1;
  retryAfter = Date.now() + Math.min(2 ** failures, 300) * 1000;
}

async function query<T>(params: Record<string, string>): Promise<AprsResponse<T>> {
  const url = `${config.aprsUrl}?${new URLSearchParams({ ...params, apikey: config.aprsKey, format: 'json' })}`;
  const body = await fetchJson<AprsResponse<T>>(url, { timeoutMs: 6000 });
  if (body.result !== 'ok') {
    if (/api key|authentication/i.test(body.description ?? '')) authFailed = true;
    throw new Error(body.description ?? 'aprs.fi-Abfrage fehlgeschlagen');
  }
  return body;
}

aprsRoute.get('/', async (c) => {
  const targets = [
    ...new Set(
      (c.req.query('targets') ?? '')
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_TARGETS);

  if (!aprsUsable()) return c.json(envelope([] as AprsStation[], 'aprs.fi (kein Key)'));
  if (targets.length === 0) return c.json(envelope([] as AprsStation[], 'aprs.fi'));

  const key = `aprs:${targets.slice().sort().join(',')}`;
  const cache = cached<AprsStation[]>(key, CACHE_SECONDS);
  if (cache.hit) return c.json(envelope(cache.hit, 'aprs.fi', true));
  if (Date.now() < retryAfter) return c.json(envelope([] as AprsStation[], 'aprs.fi (Pause nach Fehler)'));

  let entries: AprsEntry[];
  try {
    entries = (await query<AprsEntry>({ name: targets.join(','), what: 'loc' })).entries ?? [];
    failures = 0;
  } catch (err) {
    noteFailure();
    return c.json({ error: err instanceof Error ? err.message : 'aprs.fi nicht erreichbar' }, 502);
  }

  const stations: AprsStation[] = entries
    .filter((e) => e.name && num(e.lat) != null && num(e.lng) != null)
    .map((e) => ({
      name: e.name!,
      showname: e.showname ?? null,
      kind: KIND_BY_TYPE[e.type ?? ''] ?? 'other',
      coordinates: { lat: num(e.lat)!, lon: num(e.lng)! },
      courseDeg: num(e.course),
      speedKmh: num(e.speed),
      altitudeM: num(e.altitude),
      symbol: e.symbol ?? null,
      comment: e.comment ?? null,
      status: e.status ?? null,
      path: e.path ?? null,
      lastHeard: iso(e.lasttime) ?? iso(e.time) ?? new Date().toISOString(),
      weather: null,
    }));

  // Wetterwerte gibt es nur für Wetterstationen — dafür eine zweite Abfrage.
  const wxTargets = stations.filter((s) => s.kind === 'weather').map((s) => s.name);
  if (wxTargets.length > 0) {
    try {
      const wx = (await query<AprsWxEntry>({ name: wxTargets.join(','), what: 'wx' })).entries ?? [];
      const byName = new Map(wx.map((w) => [w.name?.toUpperCase(), w]));
      for (const station of stations) {
        const w = byName.get(station.name.toUpperCase());
        if (!w) continue;
        const weather: AprsWeather = {
          tempC: num(w.temp),
          humidityPct: num(w.humidity),
          pressureHpa: num(w.pressure),
          windDirDeg: num(w.wind_direction),
          windKmh: msToKmh(num(w.wind_speed)),
          windGustKmh: msToKmh(num(w.wind_gust)),
          rain1hMm: num(w.rain_1h),
          reportedAt: iso(w.time),
        };
        station.weather = weather;
      }
    } catch {
      // Ohne Wetterwerte ist die Position immer noch nützlich.
    }
  }

  cache.set(stations);
  return c.json(envelope(stations, 'aprs.fi'));
});
