import { Hono } from 'hono';
import type { WaterLevel, Coords } from '@lagebild/shared';
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
