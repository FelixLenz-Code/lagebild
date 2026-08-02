import { Hono } from 'hono';
import type { TransitDeparture, TransitStopPoint, TransitTrip, TransitTripStop } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { distanceKm } from '../lib/distance.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';
import {
  MODE_DE,
  MOTIS_BASE,
  decodePolyline,
  stopKind,
  tidyDepartures,
  toDeparture,
  type MotisStopTime,
} from '../lib/motis.js';

/** Ein Ort im Laufweg (Start, Zwischenhalt oder Ziel). */
interface MotisPlace {
  name?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  cancelled?: boolean;
}

interface MotisLeg {
  mode?: string;
  from?: MotisPlace;
  to?: MotisPlace;
  intermediateStops?: MotisPlace[];
  headsign?: string;
  displayName?: string;
  routeShortName?: string;
  routeLongName?: string;
  tripShortName?: string;
  legGeometry?: { points?: string; precision?: number };
}

/**
 * Haltestellen für die Kartenebene — aus den **Fahrplandaten** von
 * transitous.org (MOTIS), nicht aus OpenStreetMap. Das ist der entscheidende
 * Unterschied: Hier steht nur, was tatsächlich bedient wird; stillgelegte
 * Bahnhöfe tauchen gar nicht erst auf.
 *
 *   GET /api/stops?bbox=west,süd,ost,nord   → Haltestellen im Ausschnitt
 *   GET /api/stops/departures?id=…          → nächste Abfahrten eines Halts
 */
export const stopsRoute = new Hono();

/** Größere Ausschnitte liefern Tausende Punkte — die Ebene ist zoom-begrenzt. */
const MAX_SPAN_DEG = 0.9;
const MAX_STOPS = 900;

interface MotisStop {
  name?: string;
  stopId?: string;
  lat?: number;
  lon?: number;
  modes?: string[];
}

stopsRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  if (bbox.east - bbox.west > MAX_SPAN_DEG || bbox.north - bbox.south > MAX_SPAN_DEG) {
    return c.json(envelope([] as TransitStopPoint[], 'transitous.org'));
  }

  const key = `stops:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
  const cache = cached<TransitStopPoint[]>(key, 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  try {
    const raw = await fetchJson<MotisStop[]>(
      `${MOTIS_BASE}/map/stops?min=${bbox.south},${bbox.west}&max=${bbox.north},${bbox.east}`,
      { timeoutMs: 9000 },
    );
    // Steige derselben Haltestelle (Richtungen) liegen als eigene Einträge vor.
    // Erst nach Namen bündeln, dann innerhalb eines Namens räumlich gruppieren
    // (bis 150 m) — sonst liegen die Symbole übereinander und die Abfahrten
    // zeigen nur eine Richtung. Reines Runden reicht nicht: zwei Steige können
    // beliebig dicht an einer Rundungsgrenze liegen.
    const byName = new Map<string, TransitStopPoint[]>();
    for (const s of raw) {
      if (!s.stopId || s.lat == null || s.lon == null) continue;
      const name = s.name ?? 'Haltestelle';
      const list = byName.get(name.toLowerCase()) ?? [];
      const near = list.find((p) => distanceKm(p, { lat: s.lat!, lon: s.lon! }) < 0.15);
      if (near) {
        if (near.ids.length < 6) near.ids.push(s.stopId);
        // Bahn schlägt Bus, wenn an einer Stelle beides hält.
        if (near.kind !== 'rail' && stopKind(s.modes) === 'rail') near.kind = 'rail';
        continue;
      }
      list.push({ ids: [s.stopId], name, lat: s.lat, lon: s.lon, kind: stopKind(s.modes) });
      byName.set(name.toLowerCase(), list);
    }
    const data = [...byName.values()].flat().slice(0, MAX_STOPS);

    // Fahrplandaten stellen den Ort voran („Bremen Fürther Straße"). Ist das im
    // Ausschnitt fast überall derselbe Ort, wird er für die Kartenbeschriftung
    // weggelassen — sonst überdecken sich die Namen gegenseitig.
    const firstWords = new Map<string, number>();
    for (const s of data) {
      const word = s.name.split(/[\s,]+/)[0] ?? '';
      if (word.length > 2) firstWords.set(word, (firstWords.get(word) ?? 0) + 1);
    }
    const [town, count] = [...firstWords.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (town && count >= data.length * 0.6) {
      for (const s of data) {
        if (!s.name.startsWith(town)) continue;
        const rest = s.name.slice(town.length).replace(/^[\s,]+/, '');
        if (rest.length > 2) s.shortName = rest;
      }
    }
    cache.set(data);
    return c.json(envelope(data, 'transitous.org'));
  } catch {
    return c.json(envelope([] as TransitStopPoint[], 'transitous.org'));
  }
});

stopsRoute.get('/departures', async (c) => {
  // Mehrere Steige derselben Haltestelle kommen kommagetrennt.
  const ids = (c.req.query('id') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!ids.length) return c.json({ error: 'id erforderlich' }, 400);

  const key = `stop-dep:${ids.join(',')}`;
  const cache = cached<TransitDeparture[]>(key, 45);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  try {
    const lists = await mapPool(ids, 4, async (id) => {
      try {
        const dep = await fetchJson<{ stopTimes?: MotisStopTime[] }>(
          `${MOTIS_BASE}/stoptimes?stopId=${encodeURIComponent(id)}&n=15`,
          { timeoutMs: 9000 },
        );
        return (dep.stopTimes ?? []).map(toDeparture);
      } catch {
        return [] as TransitDeparture[];
      }
    });
    const data = tidyDepartures(lists.flat(), 12).slice(0, 25);
    cache.set(data);
    return c.json(envelope(data, 'transitous.org'));
  } catch {
    return c.json(envelope([] as TransitDeparture[], 'transitous.org'));
  }
});

/**
 * Laufweg einer Fahrt: alle Halte von Start bis Ziel mit Zeiten. Damit lässt
 * sich zu einer Abfahrt zeigen, wo der Bus oder Zug danach noch hält.
 */
stopsRoute.get('/trip', async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!id) return c.json({ error: 'id erforderlich' }, 400);

  const key = `trip:${id}`;
  const cache = cached<TransitTrip | null>(key, 60);
  if (cache.hit !== undefined && cache.hit !== null) return c.json(envelope(cache.hit, 'transitous.org', true));

  try {
    const raw = await fetchJson<{ legs?: MotisLeg[] }>(
      `${MOTIS_BASE}/trip?tripId=${encodeURIComponent(id)}`,
      { timeoutMs: 9000 },
    );
    const leg = (raw.legs ?? []).find((l) => l.mode && l.mode !== 'WALK');
    if (!leg) return c.json(envelope(null, 'transitous.org'));

    const toStop = (p: MotisPlace, arrival: boolean): TransitTripStop => {
      const planned = (arrival ? p.scheduledArrival : p.scheduledDeparture) ?? null;
      const actual = (arrival ? p.arrival : p.departure) ?? planned;
      return {
        name: p.name ?? '',
        lat: p.lat ?? 0,
        lon: p.lon ?? 0,
        when: actual,
        plannedWhen: planned,
        delayMin:
          planned && actual
            ? Math.round((new Date(actual).getTime() - new Date(planned).getTime()) / 60000)
            : null,
        cancelled: Boolean(p.cancelled),
      };
    };

    const trip: TransitTrip = {
      line: leg.displayName || leg.routeShortName || leg.tripShortName || MODE_DE[leg.mode ?? ''] || '?',
      product: MODE_DE[leg.mode ?? ''] ?? null,
      direction: leg.headsign || leg.routeLongName || '',
      stops: [
        toStop(leg.from ?? {}, false),
        ...(leg.intermediateStops ?? []).map((p) => toStop(p, false)),
        toStop(leg.to ?? {}, true),
      ].filter((s) => s.name),
      // Der Linienzug bringt die Fahrt auf die Karte. MOTIS schickt die
      // Genauigkeit der Kodierung mit — sie ist nicht überall gleich.
      geometry: leg.legGeometry?.points
        ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 7)
        : [],
    };
    cache.set(trip);
    return c.json(envelope(trip, 'transitous.org'));
  } catch {
    return c.json(envelope(null, 'transitous.org'));
  }
});
