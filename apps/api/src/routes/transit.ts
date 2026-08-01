import { Hono } from 'hono';
import type { TransitStop, TransitDeparture } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { distanceKm } from '../lib/distance.js';
import { mapPool } from '../lib/pool.js';
import { MOTIS_BASE, tidyDepartures, toDeparture, type MotisStopTime } from '../lib/motis.js';

/**
 * Bahn/ÖPNV: nächste Halte und ihre Abfahrten mit Echtzeit.
 *
 * Quelle ist **transitous.org** (MOTIS-API, frei und ohne Schlüssel). Das
 * Projekt bündelt die offiziellen Fahrplandaten der Verbünde (in Deutschland
 * DELFI) samt Echtzeit-Meldungen — es deckt also nicht nur die Bahn ab,
 * sondern auch Bus, Tram und U-Bahn.
 *
 * Vorgänger war `v6.db.transport.rest` (HAFAS); diese Instanz antwortet
 * dauerhaft mit 503 und ist damit unbrauchbar geworden.
 *
 * Zwei Aufrufe je Abfrage:
 *   GET /reverse-geocode?place=lat,lon&type=STOP   → Halte in der Nähe
 *   GET /stoptimes?stopId=…&n=…                    → Abfahrten eines Halts
 */
export const transitRoute = new Hono();

const BASE = MOTIS_BASE;
/** So viele Halte werden ausgewertet (jeder kostet eine Abfrage). */
const STOPS = 3;
/** Abfahrten je Halt. */
const DEPARTURES = 8;
/** Weiter als das voraus interessiert im Lagebild nicht (Stunden). */
const HORIZON_H = 12;

interface GeoEntry {
  type?: string;
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
}

transitRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `transit:${coords.lat.toFixed(3)}:${coords.lon.toFixed(3)}`;
  const cache = cached<TransitStop[]>(key, 60);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  try {
    const nearby = await fetchJson<GeoEntry[]>(
      `${BASE}/reverse-geocode?place=${coords.lat},${coords.lon}&type=STOP`,
      { timeoutMs: 9000 },
    );
    const stops = nearby
      .filter((s) => s.type === 'STOP' && s.id && s.lat != null && s.lon != null)
      .map((s) => ({ ...s, km: distanceKm(coords, { lat: s.lat!, lon: s.lon! }) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, STOPS);

    const result = await mapPool(stops, 3, async (s) => {
      let departures: TransitDeparture[] = [];
      try {
        const dep = await fetchJson<{ stopTimes?: MotisStopTime[] }>(
          `${BASE}/stoptimes?stopId=${encodeURIComponent(s.id!)}&n=${DEPARTURES}`,
          { timeoutMs: 9000 },
        );
        departures = tidyDepartures((dep.stopTimes ?? []).map(toDeparture), HORIZON_H);
      } catch {
        /* einzelner Halt ohne Abfahrten → leer lassen */
      }
      return {
        id: s.id!,
        name: s.name ?? 'Halt',
        distanceM: Math.round(s.km * 1000),
        coordinates: { lat: s.lat!, lon: s.lon! },
        departures,
      } satisfies TransitStop;
    });

    cache.set(result);
    return c.json(envelope(result, 'transitous.org'));
  } catch {
    // Quelle nicht erreichbar → leere Liste statt Fehler.
    return c.json(envelope([] as TransitStop[], 'transitous.org'));
  }
});
