import { Hono } from 'hono';
import type { WaterLevel, WaterLevelHistory, WaterLevelPoint, Coords } from '@lagebild/shared';
import { readCoords, readBbox, inBbox, bboxCenter } from '../lib/geo.js';
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
  uuid?: string;
  shortname?: string;
  longname?: string;
  longitude?: number;
  latitude?: number;
  water?: { longname?: string; shortname?: string };
  timeseries?: RawTimeseries[];
}

const PO_BASE = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json';
function stationsUrl(center: Coords, radiusKm: number): string {
  return (
    `${PO_BASE}?latitude=${center.lat}&longitude=${center.lon}&radius=${radiusKm}` +
    `&includeTimeseries=true&includeCurrentMeasurement=true`
  );
}

function toLevel(s: RawStation): WaterLevel {
  // Zeitreihe "W" = Wasserstand (in cm)
  const w = (s.timeseries ?? []).find((t) => t.shortname === 'W');
  return {
    id: s.uuid,
    station: s.shortname ?? s.longname ?? 'Pegel',
    water: s.water?.longname ?? s.water?.shortname ?? '',
    levelCm: w?.currentMeasurement?.value ?? null,
    trend: null,
    measuredAt: w?.currentMeasurement?.timestamp ?? null,
    coordinates: { lat: s.latitude as number, lon: s.longitude as number },
  };
}

const hasCoords = (s: RawStation) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude);

pegelRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  const coords = readCoords(c);
  if (!bbox && !coords) return c.json({ error: 'bbox oder lat/lon erforderlich' }, 400);

  // Kartenausschnitt: Mittelpunkt + Radius (halbe Diagonale) abfragen, dann filtern.
  if (bbox) {
    const center = bboxCenter(bbox);
    const radiusKm = Math.min(Math.max(distanceKm(center, { lat: bbox.north, lon: bbox.east }), 5), 320);
    const key = `pegel:bbox:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
    const cache = cached<WaterLevel[]>(key);
    if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

    const stations = await fetchJson<RawStation[]>(stationsUrl(center, radiusKm), { timeoutMs: 12000 });
    const levels = stations
      .filter(hasCoords)
      .map(toLevel)
      .filter((l) => inBbox(l.coordinates!, bbox))
      .sort((a, b) => distanceKm(center, a.coordinates!) - distanceKm(center, b.coordinates!))
      .slice(0, 150);
    cache.set(levels);
    return c.json(envelope(levels, 'PEGELONLINE (WSV)'));
  }

  // Fallback: Umkreis um einen Punkt.
  const radiusKm = Math.min(Number(c.req.query('radiusKm') ?? 40) || 40, 150);
  const key = `pegel:${coords!.lat.toFixed(2)}:${coords!.lon.toFixed(2)}:${radiusKm}`;
  const cache = cached<WaterLevel[]>(key);
  if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

  const stations = await fetchJson<RawStation[]>(stationsUrl(coords!, radiusKm));
  const levels = stations
    .filter(hasCoords)
    .map(toLevel)
    .sort((a, b) => distanceKm(coords!, a.coordinates!) - distanceKm(coords!, b.coordinates!))
    .slice(0, 8);
  cache.set(levels);
  return c.json(envelope(levels, 'PEGELONLINE (WSV)'));
});

/**
 * Verlauf einer Messstelle. PEGELONLINE liefert Minutenwerte (7 Tage sind über
 * 10.000 Punkte) — hier wird auf gut 120 Stützpunkte ausgedünnt, das reicht für
 * die Kurve im Popup und hält die Antwort klein.
 */
pegelRoute.get('/history', async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!/^[0-9a-f-]{20,40}$/i.test(id)) return c.json({ error: 'id erforderlich' }, 400);
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 3) || 3, 1), 14);

  const key = `pegel-hist:${id}:${days}`;
  const cache = cached<WaterLevelHistory>(key, 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

  const raw = await fetchJson<{ timestamp?: string; value?: number }[]>(
    `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${encodeURIComponent(id)}/W/measurements.json?start=P${days}D`,
    { timeoutMs: 15000 },
  );
  const all = raw.filter((m) => m.timestamp && Number.isFinite(m.value)) as { timestamp: string; value: number }[];
  if (!all.length) {
    return c.json(envelope({ points: [], minCm: 0, maxCm: 0, change3hCm: null, trend: null }, 'PEGELONLINE (WSV)'));
  }

  const step = Math.max(1, Math.ceil(all.length / 120));
  const points: WaterLevelPoint[] = [];
  for (let i = 0; i < all.length; i += step) points.push({ t: all[i]!.timestamp, v: all[i]!.value });
  // Der letzte Messwert soll immer dabei sein — er steht im Popup als Zahl.
  const last = all[all.length - 1]!;
  if (points[points.length - 1]?.t !== last.timestamp) points.push({ t: last.timestamp, v: last.value });

  const values = all.map((m) => m.value);
  // Vergleichswert von vor drei Stunden für den Trend.
  const threeHoursAgo = new Date(last.timestamp).getTime() - 3 * 3600_000;
  const past = all.find((m) => new Date(m.timestamp).getTime() >= threeHoursAgo);
  const change = past ? Math.round(last.value - past.value) : null;

  const history: WaterLevelHistory = {
    points,
    minCm: Math.min(...values),
    maxCm: Math.max(...values),
    change3hCm: change,
    trend: change == null ? null : change > 2 ? 'rising' : change < -2 ? 'falling' : 'steady',
  };
  cache.set(history);
  return c.json(envelope(history, 'PEGELONLINE (WSV)'));
});
