import { Hono } from 'hono';
import type { TransitStop, TransitDeparture } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';

/**
 * Bahn/ÖPNV: nächste Halte + Abfahrten mit Echtzeit-Verspätung und Störungen
 * über die freie DB-REST-API (HAFAS). Basis-URL per Env konfigurierbar, damit
 * bei Ausfall der öffentlichen Instanz eine eigene genutzt werden kann.
 * https://v6.db.transport.rest/
 */
export const transitRoute = new Hono();

const BASE = process.env.TRANSPORT_BASE ?? 'https://v6.db.transport.rest';

interface NearbyStop {
  id?: string;
  name?: string;
  distance?: number;
  location?: { latitude?: number; longitude?: number };
}
interface RawDeparture {
  direction?: string;
  when?: string | null;
  plannedWhen?: string | null;
  delay?: number | null;
  platform?: string | null;
  cancelled?: boolean;
  line?: { name?: string; product?: string };
  remarks?: { type?: string; text?: string }[];
}

function toDeparture(x: RawDeparture): TransitDeparture {
  return {
    line: x.line?.name ?? '?',
    product: x.line?.product ?? null,
    direction: x.direction ?? '',
    when: x.when ?? null,
    plannedWhen: x.plannedWhen ?? null,
    delayMin: x.delay != null ? Math.round(x.delay / 60) : null,
    platform: x.platform ?? null,
    cancelled: Boolean(x.cancelled),
    remark: (x.remarks ?? []).find((r) => r.type === 'warning' || r.type === 'status')?.text || undefined,
  };
}

transitRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `transit:${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}`;
  const cache = cached<TransitStop[]>(key, 60);
  if (cache.hit) return c.json(envelope(cache.hit, 'DB (transport.rest)', true));

  try {
    const nearby = await fetchJson<NearbyStop[]>(
      `${BASE}/locations/nearby?latitude=${coords.lat}&longitude=${coords.lon}&results=5&stops=true`,
      { timeoutMs: 8000 },
    );
    const stops = nearby.filter((s) => s.id).slice(0, 3);

    const result = await mapPool(stops, 3, async (s) => {
      let departures: TransitDeparture[] = [];
      try {
        const dep = await fetchJson<{ departures?: RawDeparture[] }>(
          `${BASE}/stops/${encodeURIComponent(s.id!)}/departures?duration=60&results=6`,
          { timeoutMs: 8000 },
        );
        departures = (dep.departures ?? []).map(toDeparture);
      } catch {
        /* einzelner Halt ohne Abfahrten → leer lassen */
      }
      const loc = s.location;
      return {
        id: s.id!,
        name: s.name ?? 'Halt',
        distanceM: s.distance ?? null,
        coordinates:
          loc?.latitude != null && loc?.longitude != null ? { lat: loc.latitude, lon: loc.longitude } : null,
        departures,
      } satisfies TransitStop;
    });

    cache.set(result);
    return c.json(envelope(result, 'DB (transport.rest)'));
  } catch {
    // Öffentliche Instanz nicht erreichbar → leere Liste statt Fehler.
    return c.json(envelope([] as TransitStop[], 'DB (transport.rest)'));
  }
});
