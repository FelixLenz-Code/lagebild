import { Hono } from 'hono';
import type { TrafficIncident } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';
import { distanceKm } from '../lib/distance.js';

/**
 * Verkehrsmeldungen der offiziellen Autobahn-API (bund.dev). Die API kennt
 * keine Standort-Suche, daher aggregieren wir die Warnungen aller Autobahnen
 * einmalig (gecacht) und filtern anschließend nach Nähe zum Standort.
 * https://autobahn.api.bund.dev/
 */
export const trafficRoute = new Hono();

const BASE = 'https://verkehr.autobahn.de/o/autobahn';

interface RawWarning {
  identifier?: string;
  title?: string;
  subtitle?: string;
  description?: string[];
  isBlocked?: string;
  abnormalTrafficType?: string;
  startTimestamp?: string;
  coordinate?: { lat?: string; long?: string };
}

async function loadRoads(): Promise<string[]> {
  const cache = cached<string[]>('autobahn:roads', 86_400);
  if (cache.hit) return cache.hit;
  const body = await fetchJson<{ roads?: string[] }>(`${BASE}/`);
  const roads = (body.roads ?? []).map((r) => r.trim()).filter(Boolean);
  return cache.set(roads);
}

function toIncident(road: string, w: RawWarning): TrafficIncident | null {
  const lat = Number(w.coordinate?.lat);
  const lon = Number(w.coordinate?.long);
  const kind: TrafficIncident['kind'] =
    w.isBlocked === 'true'
      ? 'closure'
      : /QUEUING|JAM|STATIONARY/i.test(w.abnormalTrafficType ?? '')
        ? 'jam'
        : 'warning';
  return {
    id: w.identifier ?? `${road}-${lat}-${lon}`,
    road,
    kind,
    title: [w.title, w.subtitle?.trim()].filter(Boolean).join(' · ') || road,
    description: (w.description ?? []).filter(Boolean).join(' ') || undefined,
    coordinates: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    startsAt: w.startTimestamp ?? null,
  };
}

async function loadAllWarnings(): Promise<TrafficIncident[]> {
  const cache = cached<TrafficIncident[]>('autobahn:warnings', 300);
  if (cache.hit) return cache.hit;
  const roads = await loadRoads();
  const perRoad = await mapPool(roads, 8, async (road) => {
    try {
      const body = await fetchJson<{ warning?: RawWarning[] }>(
        `${BASE}/${encodeURIComponent(road)}/services/warning`,
        { timeoutMs: 6000 },
      );
      return (body.warning ?? [])
        .map((w) => toIncident(road, w))
        .filter((x): x is TrafficIncident => x !== null);
    } catch {
      return [];
    }
  });
  return cache.set(perRoad.flat());
}

trafficRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);
  const radiusKm = Math.min(Number(c.req.query('radiusKm') ?? 50) || 50, 200);

  const all = await loadAllWarnings();
  const near = all
    .filter((i) => i.coordinates)
    .map((i) => ({ i, d: distanceKm(coords, i.coordinates!) }))
    .filter((x) => x.d <= radiusKm)
    .sort((a, b) => a.d - b.d)
    .slice(0, 30)
    .map((x) => x.i);

  return c.json(envelope(near, 'Autobahn GmbH (bund.dev)'));
});
