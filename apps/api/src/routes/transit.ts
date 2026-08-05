import { Hono } from 'hono';
import type {
  TransitStop,
  TransitDeparture,
  TransitItinerary,
  TransitLeg,
  TransitLegPlace,
  TransitTripStop,
} from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { distanceKm } from '../lib/distance.js';
import { mapPool } from '../lib/pool.js';
import {
  MODE_DE,
  MOTIS_BASE,
  decodePolyline,
  tidyDepartures,
  toDeparture,
  type MotisStopTime,
} from '../lib/motis.js';

/** Ort in einer MOTIS-Verbindung. */
interface PlanPlace {
  name?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  /** Steig laut Echtzeitlage bzw. laut Fahrplan (MOTIS liefert beides). */
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
}
interface PlanLeg {
  mode?: string;
  from?: PlanPlace;
  to?: PlanPlace;
  duration?: number;
  distance?: number;
  startTime?: string;
  endTime?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  headsign?: string;
  displayName?: string;
  routeShortName?: string;
  routeLongName?: string;
  tripShortName?: string;
  cancelled?: boolean;
  intermediateStops?: PlanPlace[];
  legGeometry?: { points?: string; precision?: number };
}
interface MotisItinerary {
  duration?: number;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  legs?: PlanLeg[];
}

const minutesBetween = (planned: string | null, actual: string | null): number | null =>
  planned && actual ? Math.round((new Date(actual).getTime() - new Date(planned).getTime()) / 60000) : null;

function toTripStop(p: PlanPlace): TransitTripStop {
  const planned = p.scheduledArrival ?? p.scheduledDeparture ?? null;
  const actual = p.arrival ?? p.departure ?? planned;
  return {
    name: p.name ?? '',
    lat: p.lat ?? 0,
    lon: p.lon ?? 0,
    when: actual,
    plannedWhen: planned,
    delayMin: minutesBetween(planned, actual),
    cancelled: Boolean(p.cancelled),
    track: p.track ?? p.scheduledTrack ?? null,
  };
}

/** MOTIS nennt die Enden der Reise „START"/„END" — das ist kein Ortsname. */
const placeName = (name: string | undefined): string =>
  !name || name === 'START' || name === 'END' ? '' : name;

/** Ein Abschnittsende mit Steig. Ohne Halt (Straßenrand) bleibt er leer. */
function toLegPlace(p: PlanPlace | undefined): TransitLegPlace {
  return {
    name: placeName(p?.name),
    lat: p?.lat ?? 0,
    lon: p?.lon ?? 0,
    track: p?.track ?? p?.scheduledTrack ?? null,
    plannedTrack: p?.scheduledTrack ?? null,
  };
}

function toLeg(l: PlanLeg): TransitLeg {
  const walk = !l.mode || l.mode === 'WALK';
  const plannedDep = l.scheduledStartTime ?? l.startTime ?? null;
  const plannedArr = l.scheduledEndTime ?? l.endTime ?? null;
  return {
    mode: l.mode ?? 'WALK',
    product: walk ? null : (MODE_DE[l.mode ?? ''] ?? null),
    line: walk ? null : l.displayName || l.routeShortName || l.tripShortName || null,
    headsign: l.headsign ?? l.routeLongName ?? null,
    from: toLegPlace(l.from),
    to: toLegPlace(l.to),
    departure: l.startTime ?? null,
    plannedDeparture: plannedDep,
    arrival: l.endTime ?? null,
    plannedArrival: plannedArr,
    delayMin: minutesBetween(plannedDep, l.startTime ?? null),
    durationS: l.duration ?? 0,
    distanceM: l.distance != null ? Math.round(l.distance) : null,
    cancelled: Boolean(l.cancelled),
    intermediateStops: (l.intermediateStops ?? []).map(toTripStop),
    geometry: l.legGeometry?.points
      ? decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 7)
      : [],
  };
}

function toItinerary(it: MotisItinerary): TransitItinerary {
  return {
    startTime: it.startTime ?? '',
    endTime: it.endTime ?? '',
    durationS: it.duration ?? 0,
    transfers: it.transfers ?? 0,
    legs: (it.legs ?? []).map(toLeg),
  };
}

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

/**
 * ÖPNV-Verbindungen von A nach B (transitous.org / MOTIS `/plan`).
 *
 * Anders als Auto, Rad und Fuß braucht das **eine Verbindung**: Fahrpläne und
 * Echtzeit liegen nicht im Gerät. Ohne Netz bleibt die Auswahl leer.
 */
transitRoute.get('/plan', async (c) => {
  const from = (c.req.query('from') ?? '').trim();
  const to = (c.req.query('to') ?? '').trim();
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(from) || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(to)) {
    return c.json({ error: 'from und to als lat,lon erforderlich' }, 400);
  }
  const time = (c.req.query('time') ?? '').trim();
  const arriveBy = c.req.query('arriveBy') === '1';

  const key = `plan:${from}:${to}:${time}:${arriveBy}`;
  const cache = cached<TransitItinerary[]>(key, 60);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  const params = new URLSearchParams({
    fromPlace: from,
    toPlace: to,
    numItineraries: '3',
    arriveBy: arriveBy ? 'true' : 'false',
  });
  if (time) params.set('time', time);

  try {
    const raw = await fetchJson<{ itineraries?: MotisItinerary[] }>(
      `${MOTIS_BASE}/plan?${params.toString()}`,
      { timeoutMs: 12000 },
    );
    const data = (raw.itineraries ?? []).map(toItinerary);
    cache.set(data);
    return c.json(envelope(data, 'transitous.org'));
  } catch {
    return c.json(envelope([] as TransitItinerary[], 'transitous.org'));
  }
});
