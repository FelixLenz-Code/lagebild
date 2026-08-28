import { Hono } from 'hono';
import type { TransitFind, TransitJourney, TransitTripStop, TransitVehicle } from '@lagebild/shared';
import { readBbox, type Bbox } from '../lib/geo.js';
import { distanceKm } from '../lib/distance.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';
import {
  MODE_DE,
  MOTIS_BASE,
  productOf,
  cumulativeLengths,
  decodePolyline,
  pointAtLength,
  projectOnLine,
  type MotisStopTime,
} from '../lib/motis.js';

/**
 * Fahrzeuge des öffentlichen Verkehrs in Bewegung (transitous.org / MOTIS).
 *
 * `map/trips` liefert **keine Positionen**, sondern die Fahrtabschnitte im
 * Ausschnitt mit Abfahrt, Ankunft und Linienzug. Die Position wird daraus
 * gerechnet: Anteil der verstrichenen Zeit → Punkt auf der Strecke. Genau so
 * arbeiten auch die Live-Karten der Verkehrsverbünde; ohne echte
 * Fahrzeugortung ist es eine Schätzung, aber eine gute.
 *
 * Drei Routen:
 *   GET /api/vehicles?bbox=…        → Kartenebene (alles im Ausschnitt)
 *   GET /api/vehicles/find?q=…      → eine bestimmte Linie suchen
 *   GET /api/vehicles/journey?id=…  → eine Fahrt mit allen Daten verfolgen
 */
export const vehiclesRoute = new Hono();

/** Größere Ausschnitte liefern zu viele Fahrten — die Ebene ist zoom-begrenzt. */
const MAX_SPAN_DEG = 2.5;
const MAX_VEHICLES = 400;
/** Flugzeuge kommen aus dem ADS-B-Netz, nicht aus dem Fahrplan. */
const SKIP_MODES = new Set(['AIRPLANE']);

interface TripSegment {
  trips?: { tripId?: string; routeShortName?: string }[];
  mode?: string;
  from?: { name?: string };
  to?: { name?: string };
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  realTime?: boolean;
  polyline?: string;
}

/**
 * Ein Abschnitt aus `map/trips` in eine Position umrechnen — oder null, wenn
 * er gerade nicht befahren wird.
 */
function segmentVehicle(s: TripSegment, now: number): TransitVehicle | null {
  if (!s.polyline || !s.departure || !s.arrival) return null;
  if (SKIP_MODES.has(s.mode ?? '')) return null;
  const start = Date.parse(s.departure);
  const end = Date.parse(s.arrival);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // Nur Abschnitte, die gerade befahren werden.
  if (now < start || now > end) return null;

  // Achtung: `map/trips` liefert Genauigkeit 5 — anders als die Verbindungen
  // aus `/plan` und `/trip`, die ihre Genauigkeit selbst mitschicken.
  const line = decodePolyline(s.polyline, 5);
  if (line.length < 2) return null;
  const steps = cumulativeLengths(line);
  const at = pointAtLength(line, steps, steps[steps.length - 1]! * ((now - start) / (end - start)));

  const trip = s.trips?.[0];
  const planned = s.scheduledDeparture ? Date.parse(s.scheduledDeparture) : NaN;
  const name = trip?.routeShortName ?? MODE_DE[s.mode ?? ''] ?? '?';
  return {
    id: trip?.tripId ?? `${s.from?.name}-${s.departure}`,
    line: name,
    mode: s.mode ?? 'OTHER',
    product: productOf(s.mode, name),
    lat: at.lat,
    lon: at.lon,
    bearing: at.bearing,
    towards: s.to?.name ?? '',
    delayMin: Number.isFinite(planned) ? Math.round((start - planned) / 60000) : null,
    realTime: Boolean(s.realTime),
  };
}

/**
 * Fahrtabschnitte eines Ausschnitts holen.
 *
 * Der `zoom` ist bei MOTIS **kein Darstellungsdetail, sondern ein Filter**:
 * Bis Zoom 6 kommen nur Fern- und Fernbusfahrten, bis 8 zusätzlich Regional-
 * und U-Bahn, ab 9 auch Bus und Tram. Ein zu großer Ausschnitt wird mit
 * „too many trips" abgelehnt — welcher Ausschnitt noch geht, hängt genau an
 * diesem Zoom. Darauf baut die Suche weiter unten auf.
 */
async function scanSegments(box: Bbox, zoom: number, timeoutMs = 12000): Promise<TripSegment[]> {
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
  const key = `trips:${zoom}:${box.west.toFixed(2)},${box.south.toFixed(2)},${box.east.toFixed(2)},${box.north.toFixed(2)}`;
  const cache = cached<TripSegment[]>(key, 15);
  if (cache.hit) return cache.hit;
  const data = await fetchJson<TripSegment[]>(
    `${MOTIS_BASE}/map/trips?min=${box.south},${box.west}&max=${box.north},${box.east}` +
      `&zoom=${zoom}&startTime=${iso(now - 60_000)}&endTime=${iso(now + 60_000)}`,
    { timeoutMs },
  );
  const list = Array.isArray(data) ? data : [];
  cache.set(list);
  return list;
}

vehiclesRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  if (bbox.east - bbox.west > MAX_SPAN_DEG || bbox.north - bbox.south > MAX_SPAN_DEG) {
    return c.json(envelope([] as TransitVehicle[], 'transitous.org'));
  }

  // Positionen veralten in Sekunden — kurz cachen, aber nicht gar nicht.
  const key = `vehicles:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
  const cache = cached<TransitVehicle[]>(key, 15);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  try {
    const segments = await scanSegments(bbox, 12);
    const now = Date.now();
    const out: TransitVehicle[] = [];
    for (const s of segments) {
      if (out.length >= MAX_VEHICLES) break;
      const v = segmentVehicle(s, now);
      if (!v) continue;
      if (v.lon < bbox.west || v.lon > bbox.east || v.lat < bbox.south || v.lat > bbox.north) continue;
      out.push(v);
    }
    cache.set(out);
    return c.json(envelope(out, 'transitous.org'));
  } catch {
    return c.json(envelope([] as TransitVehicle[], 'transitous.org'));
  }
});

/* ---------- Eine bestimmte Fahrt finden ---------- */

/**
 * Die Suche nach einer Linie hat ein Mengenproblem: Bundesweit fahren zu jeder
 * Zeit sechsstellig viele Busse, und MOTIS lehnt zu große Ausschnitte ab. Der
 * Ausweg ist der Zoom-Filter (siehe `scanSegments`) — er entscheidet, welche
 * Verkehrsmittel überhaupt geliefert werden, und damit, wie groß der
 * Ausschnitt sein darf:
 *
 *   lokal   Zoom 12, ~1,4° — alles, auch Bus und Tram
 *   region  Zoom  8, ~2,8° — Regional- und U-Bahn, ohne Bus
 *   bund    Zoom  6, ganz Deutschland — nur Fernverkehr
 *
 * Welche Stufen abgefragt werden, sagt das Linienkürzel: Ein „ICE 1044" wird
 * bundesweit gesucht, ein „RE 1" in der Region, eine „25" im Umkreis. Findet
 * die erste Stufe nichts, wird die nächste versucht.
 */
const FERN_PREFIX = new Set(['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'TGV', 'FLX', 'THA', 'CNL', 'D']);
const REGIO_PREFIX = new Set(['RE', 'RB', 'S', 'SE', 'IRE', 'MEX', 'RS', 'R', 'FEX', 'TER', 'U']);
/** Ganz Deutschland mit etwas Rand — größer geht bei Zoom 6 nicht mehr gut. */
const BUND_BOX: Bbox = { west: 5.5, south: 47.0, east: 15.6, north: 55.4 };

type Tier = 'lokal' | 'region' | 'bund';

/**
 * Linienbezeichner vereinheitlichen: „RE 1" und „re-1" sind dasselbe.
 *
 * Die Fahrplandaten hängen bei manchen Verbünden die Zugnummer an —
 * „RB41 (81921)". Die Klammer fliegt weg, sonst fände die Suche nach „RB 41"
 * genau diese Linien nie.
 */
const normLine = (s: string): string =>
  s.replace(/\([^)]*\)/g, ' ').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');

/** Zerlegt „RE1A" in Kürzel, Nummer und Zusatz. */
function lineParts(n: string): { prefix: string; digits: string; suffix: string } {
  const m = /^([A-ZÄÖÜ]*)(\d*)([A-ZÄÖÜ]*)$/.exec(n);
  return { prefix: m?.[1] ?? '', digits: m?.[2] ?? '', suffix: m?.[3] ?? '' };
}

/**
 * Passt eine Linienbezeichnung zur Eingabe? 0 = nein, größer = besser.
 *
 * Bewusst streng bei den Ziffern: „RE 1" darf nicht „RE 11" treffen. Bewusst
 * großzügig ohne Kürzel: Wer nur „1" eingibt, meint die Linie 1 — ob Bus,
 * Tram oder Regionalzug, entscheidet er beim Ansehen der Treffer.
 */
function lineScore(q: { norm: string; parts: ReturnType<typeof lineParts> }, name: string): number {
  const n = normLine(name);
  if (!n) return 0;
  if (n === q.norm) return 3;
  const p = lineParts(n);
  if (q.parts.digits) {
    if (p.digits !== q.parts.digits || p.suffix !== q.parts.suffix) return 0;
    if (!q.parts.prefix) return 2;
    return p.prefix === q.parts.prefix ? 3 : 0;
  }
  return q.parts.prefix && p.prefix === q.parts.prefix ? 1 : 0;
}

/** Sieht die Eingabe nach einer Linie aus — oder nach einem Ortsnamen? */
function looksLikeLine(s: string): boolean {
  const n = normLine(s);
  if (!n) return false;
  // „Bremen Hauptbahnhof" ist keine Linie — Linienbezeichner sind kurz.
  if (s.trim().split(/\s+/).length > 2) return false;
  if (/^[A-ZÄÖÜ]{0,5}\d{1,5}[A-ZÄÖÜ]{0,2}$/.test(n)) return true;
  // Reine Buchstaben nur, wenn es ein bekanntes Kürzel ist — sonst wäre „Hbf"
  // eine Linie.
  return FERN_PREFIX.has(n) || REGIO_PREFIX.has(n);
}

/**
 * Eingabe zerlegen. Erlaubt sind:
 *   „RE 1"                     → Linie
 *   „RE 1 nach Bremen"         → Linie und Richtung
 *   „RE 1 ab Bremen Hbf"       → Linie an einem Halt
 *   „Bremen Hbf"               → nur der Halt (alle Abfahrten)
 *
 * „an" und „in" sind bewusst **keine** Trennwörter: „Frankfurt an der Oder"
 * und „Berlin" wären sonst zerschnitten.
 */
function parseQuery(raw: string): { line: string; stop: string; dir: string } {
  let rest = raw.trim().replace(/\s+/g, ' ');
  let dir = '';
  let stop = '';
  const dirMatch = /\s(?:->|→|>|nach|richtung)\s+(.+)$/i.exec(rest);
  if (dirMatch) {
    dir = dirMatch[1]!.trim();
    rest = rest.slice(0, dirMatch.index).trim();
  }
  const stopMatch = /\s(?:ab|von|@|haltestelle|halt)\s+(.+)$/i.exec(rest);
  if (stopMatch) {
    stop = stopMatch[1]!.trim();
    rest = rest.slice(0, stopMatch.index).trim();
  }
  if (looksLikeLine(rest)) return { line: rest, stop, dir };
  // Kein Linienkürzel: Der Rest gehört zum Ortsnamen.
  return { line: '', stop: [rest, stop].filter(Boolean).join(' ').trim(), dir };
}

/** Welche Suchstufen kommen für dieses Kürzel infrage — in dieser Reihenfolge? */
function tiersFor(prefix: string): Tier[] {
  if (FERN_PREFIX.has(prefix)) return ['bund', 'region'];
  if (REGIO_PREFIX.has(prefix)) return ['region', 'lokal', 'bund'];
  return ['lokal', 'region', 'bund'];
}

/** Ausschnitt und Zoom einer Suchstufe. */
function tierBox(tier: Tier, ref: { lat: number; lon: number }, view: Bbox | null): { box: Bbox; zoom: number } {
  if (tier === 'bund') return { box: BUND_BOX, zoom: 6 };
  if (tier === 'region') {
    return {
      box: { west: ref.lon - 1.4, east: ref.lon + 1.4, south: ref.lat - 1.4, north: ref.lat + 1.4 },
      zoom: 8,
    };
  }
  // Lokal: der sichtbare Ausschnitt, aber mindestens ein brauchbarer Umkreis
  // und höchstens so viel, wie MOTIS bei Zoom 12 noch herausgibt.
  const half = Math.min(0.7, Math.max(0.3, view ? Math.max(view.east - view.west, view.north - view.south) * 0.75 : 0.35));
  const c = view ? { lat: (view.south + view.north) / 2, lon: (view.west + view.east) / 2 } : ref;
  return {
    box: { west: c.lon - half, east: c.lon + half, south: c.lat - half, north: c.lat + half },
    zoom: 12,
  };
}

interface MotisPlace {
  name?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
}

interface MotisTripLeg {
  mode?: string;
  from?: MotisPlace;
  to?: MotisPlace;
  tripFrom?: MotisPlace;
  tripTo?: MotisPlace;
  intermediateStops?: MotisPlace[];
  headsign?: string;
  displayName?: string;
  routeShortName?: string;
  routeLongName?: string;
  tripShortName?: string;
  agencyName?: string;
  realTime?: boolean;
  cancelled?: boolean;
  bikesAllowed?: boolean;
  wheelchairAccessible?: string;
  legGeometry?: { points?: string; precision?: number };
}

/** Den Fahrt-Abschnitt einer `/trip`-Antwort holen (der Rest sind Fußwege). */
async function fetchTripLeg(tripId: string): Promise<MotisTripLeg | null> {
  const raw = await fetchJson<{ legs?: MotisTripLeg[] }>(
    `${MOTIS_BASE}/trip?tripId=${encodeURIComponent(tripId)}`,
    { timeoutMs: 9000 },
  );
  return (raw.legs ?? []).find((l) => l.mode && l.mode !== 'WALK') ?? null;
}

interface GeoEntry {
  type?: string;
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
  areas?: { name?: string; matched?: boolean }[];
}

/** Treffer nach Halt: Wer weiß, wo sein Bus abfährt, sucht darüber. */
async function findAtStop(
  stopText: string,
  q: { norm: string; parts: ReturnType<typeof lineParts> } | null,
  dir: string,
  ref: { lat: number; lon: number },
): Promise<TransitFind[]> {
  const places = await fetchJson<GeoEntry[]>(
    `${MOTIS_BASE}/geocode?text=${encodeURIComponent(stopText)}`,
    { timeoutMs: 9000 },
  );
  const stops = places.filter((p) => p.type === 'STOP' && p.id).slice(0, 2);
  if (!stops.length) return [];

  const lists = await mapPool(stops, 2, async (stop) => {
    try {
      const dep = await fetchJson<{ stopTimes?: MotisStopTime[] }>(
        `${MOTIS_BASE}/stoptimes?stopId=${encodeURIComponent(stop.id!)}&n=60`,
        { timeoutMs: 9000 },
      );
      const km = stop.lat != null && stop.lon != null ? distanceKm(ref, { lat: stop.lat, lon: stop.lon }) : null;
      return (dep.stopTimes ?? [])
        .filter((x) => x.tripId)
        .map((x): TransitFind => {
          const place = x.place ?? {};
          const planned = place.scheduledDeparture ?? null;
          const actual = place.departure ?? planned;
          const name = x.routeShortName || x.displayName || x.tripShortName || MODE_DE[x.mode ?? ''] || '?';
          return {
            tripId: x.tripId!,
            line: name,
            mode: x.mode ?? 'OTHER',
            product: productOf(x.mode, name),
            towards: x.headsign || x.routeLongName || '',
            origin: null,
            via: 'stop',
            lat: null,
            lon: null,
            lastStop: null,
            nextStop: null,
            stopName: stop.name ?? place.name ?? stopText,
            when: actual,
            track: place.track ?? place.scheduledTrack ?? null,
            delayMin:
              x.realTime && planned && actual
                ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60000)
                : null,
            realTime: Boolean(x.realTime),
            cancelled: Boolean(x.cancelled || x.tripCancelled || place.cancelled),
            distanceM: km == null ? null : Math.round(km * 1000),
          };
        });
    } catch {
      return [] as TransitFind[];
    }
  });

  const needle = dir.toLowerCase();
  return lists
    .flat()
    .filter((h) => !q || lineScore(q, h.line) > 0)
    .filter((h) => !needle || h.towards.toLowerCase().includes(needle))
    .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''));
}

/**
 * Eine bestimmte Linie suchen.
 *
 *   GET /api/vehicles/find?q=RE 1 nach Bremen&lat=…&lon=…&bbox=…
 *
 * `lat`/`lon` sind der Bezugspunkt für Entfernung und Reihenfolge, `bbox` der
 * sichtbare Kartenausschnitt (bestimmt die lokale Suchstufe). Beides ist
 * freiwillig; ohne Angabe wird von der Mitte des Ausschnitts ausgegangen.
 */
vehiclesRoute.get('/find', async (c) => {
  const raw = (c.req.query('q') ?? '').trim().slice(0, 80);
  if (raw.length < 1) return c.json({ error: 'q erforderlich' }, 400);
  const view = readBbox(c);
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  const ref =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon }
      : view
        ? { lat: (view.south + view.north) / 2, lon: (view.west + view.east) / 2 }
        : { lat: 52.52, lon: 13.4 };

  const { line, stop, dir } = parseQuery(raw);
  const q = line ? { norm: normLine(line), parts: lineParts(normLine(line)) } : null;

  const key = `find:${raw.toLowerCase()}:${ref.lat.toFixed(1)},${ref.lon.toFixed(1)}`;
  const cache = cached<TransitFind[]>(key, 20);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  const hits: TransitFind[] = [];
  const seen = new Set<string>();

  // Stufe 1: Fahrzeuge, die gerade unterwegs sind.
  if (q) {
    const now = Date.now();
    for (const tier of tiersFor(q.parts.prefix)) {
      const { box, zoom } = tierBox(tier, ref, view);
      let segments: TripSegment[] = [];
      try {
        segments = await scanSegments(box, zoom, tier === 'bund' ? 20000 : 12000);
      } catch {
        continue;
      }
      for (const s of segments) {
        const name = s.trips?.[0]?.routeShortName;
        if (!name || !lineScore(q, name)) continue;
        const v = segmentVehicle(s, now);
        if (!v || seen.has(v.id)) continue;
        seen.add(v.id);
        hits.push({
          tripId: v.id,
          line: v.line,
          mode: v.mode,
          product: v.product,
          towards: '',
          origin: null,
          via: 'live',
          lat: v.lat,
          lon: v.lon,
          lastStop: s.from?.name ?? null,
          nextStop: s.to?.name ?? null,
          stopName: null,
          when: null,
          track: null,
          delayMin: v.delayMin,
          realTime: v.realTime,
          cancelled: false,
          distanceM: Math.round(distanceKm(ref, { lat: v.lat, lon: v.lon }) * 1000),
        });
      }
      if (hits.length) break;
    }
    hits.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
  }

  // Stufe 2: Was an einem genannten Halt noch kommt — auch Fahrten, die noch
  // gar nicht losgefahren sind und deshalb nirgends auf der Karte stehen.
  if (stop) {
    try {
      for (const h of await findAtStop(stop, q, dir, ref)) {
        if (seen.has(h.tripId)) continue;
        seen.add(h.tripId);
        hits.push(h);
      }
    } catch {
      /* Ortssuche ohne Treffer → die Live-Treffer bleiben stehen */
    }
  }

  const top = hits.slice(0, 25);

  // Endstation und Startort nachtragen: Für die Auswahl ist „→ Uelzen" die
  // entscheidende Angabe, und im Kartenabschnitt steht nur der nächste Halt.
  // Erst danach lässt sich nach der Richtung filtern — der nächste Halt eines
  // Abschnitts sagt über das Fahrtziel nichts aus.
  const needDetail = top.filter((h) => !h.towards).slice(0, dir ? 14 : 8);
  await mapPool(needDetail, 6, async (h) => {
    try {
      const leg = await fetchTripLeg(h.tripId);
      if (!leg) return;
      h.towards = leg.headsign || leg.tripTo?.name || leg.routeLongName || '';
      h.origin = leg.tripFrom?.name ?? null;
      h.cancelled = h.cancelled || Boolean(leg.cancelled);
    } catch {
      /* ohne Endstation bleibt der Treffer trotzdem brauchbar */
    }
  });

  const needle = dir.toLowerCase();
  const data = needle
    ? top.filter((h) => `${h.towards} ${h.nextStop ?? ''}`.toLowerCase().includes(needle))
    : top;

  cache.set(data);
  return c.json(envelope(data, 'transitous.org'));
});

/* ---------- Eine Fahrt verfolgen ---------- */

const minutesBetween = (planned: string | null, actual: string | null): number | null =>
  planned && actual ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60000) : null;

/** Ein Halt der Fahrt mit An- und Abfahrt getrennt. */
function toJourneyStop(p: MotisPlace): TransitTripStop {
  const plannedDep = p.scheduledDeparture ?? null;
  const plannedArr = p.scheduledArrival ?? null;
  const dep = p.departure ?? plannedDep;
  const arr = p.arrival ?? plannedArr;
  return {
    name: p.name ?? '',
    lat: p.lat ?? 0,
    lon: p.lon ?? 0,
    // `when` bleibt die Abfahrt (am Ziel die Ankunft) — so, wie die übrigen
    // Fahrtansichten es erwarten.
    when: dep ?? arr,
    plannedWhen: plannedDep ?? plannedArr,
    delayMin: minutesBetween(plannedDep ?? plannedArr, dep ?? arr),
    cancelled: Boolean(p.cancelled),
    track: p.track ?? p.scheduledTrack ?? null,
    arrival: arr,
    plannedArrival: plannedArr,
  };
}

/**
 * Wo ist die Fahrt gerade?
 *
 * Nicht der Anteil an der Gesamtzeit — das wäre über eine ganze Fahrt hinweg
 * grob falsch, weil zwischen zwei Halten mal 2 und mal 20 Minuten liegen.
 * Stattdessen wird **jeder Halt auf den Linienzug projiziert**; zwischen zwei
 * Halten wird linear nach der Zeit interpoliert. Damit passt die Marke auch
 * dann zum Fahrplan, wenn die Fahrt irgendwo lange steht.
 */
function locate(
  stops: TransitTripStop[],
  line: [number, number][],
  now: number,
): Pick<TransitJourney, 'state' | 'position' | 'nextStopIndex' | 'atStop' | 'progress'> {
  if (line.length < 2 || stops.length < 2) {
    return { state: 'running', position: null, nextStopIndex: null, atStop: false, progress: 0 };
  }
  const steps = cumulativeLengths(line);
  const total = steps[steps.length - 1] ?? 0;

  // Halte der Reihe nach auf die Linie legen; die Suche wandert dabei nur
  // vorwärts, damit Schleifen und Kopfbahnhöfe die Reihenfolge nicht drehen.
  const marks: number[] = [];
  let from = 0;
  for (const s of stops) {
    const hit = projectOnLine(line, steps, [s.lon, s.lat], from);
    from = hit.index;
    marks.push(hit.length);
  }

  const depAt = (i: number): number => Date.parse(stops[i]!.when ?? stops[i]!.plannedWhen ?? '');
  const arrAt = (i: number): number => {
    const s = stops[i]!;
    const t = Date.parse(s.arrival ?? s.plannedArrival ?? '');
    return Number.isFinite(t) ? t : depAt(i);
  };

  const first = depAt(0);
  const last = arrAt(stops.length - 1);
  const point = (length: number, index: number) => {
    const at = pointAtLength(line, steps, length);
    return {
      position: at,
      progress: total > 0 ? Math.max(0, Math.min(1, length / total)) : 0,
      nextStopIndex: index,
    };
  };

  if (Number.isFinite(first) && now < first) {
    const p = point(marks[0]!, 0);
    return { state: 'planned', position: p.position, nextStopIndex: 0, atStop: true, progress: 0 };
  }
  if (Number.isFinite(last) && now >= last) {
    return {
      state: 'done',
      position: pointAtLength(line, steps, marks[marks.length - 1]!),
      nextStopIndex: null,
      atStop: true,
      progress: 1,
    };
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const dep = depAt(i);
    const nextArr = arrAt(i + 1);
    const arr = arrAt(i);
    // Aufenthalt am Halt: Ankunft ist durch, Abfahrt noch nicht.
    if (Number.isFinite(arr) && Number.isFinite(dep) && now >= arr && now < dep) {
      const p = point(marks[i]!, i);
      return { state: 'running', position: p.position, nextStopIndex: i, atStop: true, progress: p.progress };
    }
    if (!Number.isFinite(dep) || !Number.isFinite(nextArr) || now < dep || now >= nextArr) continue;
    const span = nextArr - dep;
    const t = span > 0 ? (now - dep) / span : 0;
    const p = point(marks[i]! + (marks[i + 1]! - marks[i]!) * t, i + 1);
    return { state: 'running', position: p.position, nextStopIndex: i + 1, atStop: false, progress: p.progress };
  }

  // Zeiten unvollständig (kommt bei Fahrten ohne Echtzeit vor): letzte
  // bekannte Stelle nehmen, statt gar nichts zu zeigen.
  return { state: 'running', position: null, nextStopIndex: null, atStop: false, progress: 0 };
}

/**
 * Alles zu einer Fahrt — Laufweg, Zeiten, Verspätung und die gerechnete
 * Position. Der Client fragt das im Takt ab, solange er die Fahrt verfolgt.
 *
 *   GET /api/vehicles/journey?id=<tripId>
 */
vehiclesRoute.get('/journey', async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!id) return c.json({ error: 'id erforderlich' }, 400);

  // Der Fahrplanteil ändert sich langsam, die Position mit jeder Sekunde:
  // Deshalb wird die Antwort von MOTIS gecacht, die Position aber bei jeder
  // Anfrage neu gerechnet.
  const key = `journey-leg:${id}`;
  const cache = cached<MotisTripLeg | null>(key, 20);
  let leg = cache.hit ?? null;
  if (!leg) {
    try {
      leg = await fetchTripLeg(id);
      cache.set(leg);
    } catch {
      return c.json(envelope(null, 'transitous.org'));
    }
  }
  if (!leg) return c.json(envelope(null, 'transitous.org'));

  const stops = [
    toJourneyStop(leg.from ?? {}),
    ...(leg.intermediateStops ?? []).map(toJourneyStop),
    toJourneyStop(leg.to ?? {}),
  ].filter((s) => s.name);

  const geometry = leg.legGeometry?.points
    ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 7)
    : [];
  const now = Date.now();
  const where = locate(stops, geometry, now);

  // Verspätung dort, wo sie den Verfolgenden interessiert: am nächsten Halt.
  const at = where.nextStopIndex != null ? stops[where.nextStopIndex] : stops[stops.length - 1];
  const delayMin = leg.realTime ? (at?.delayMin ?? null) : null;

  const legLine =
    leg.routeShortName || leg.displayName || leg.tripShortName || MODE_DE[leg.mode ?? ''] || '?';
  const journey: TransitJourney = {
    tripId: id,
    line: legLine,
    mode: leg.mode ?? 'OTHER',
    product: productOf(leg.mode, legLine),
    towards: leg.headsign || leg.routeLongName || leg.tripTo?.name || '',
    origin: leg.tripFrom?.name ?? stops[0]?.name ?? '',
    destination: leg.tripTo?.name ?? stops[stops.length - 1]?.name ?? '',
    operator: leg.agencyName ?? null,
    bikes: leg.bikesAllowed ?? null,
    wheelchair:
      leg.wheelchairAccessible == null
        ? null
        : leg.wheelchairAccessible === 'ACCESSIBLE' || leg.wheelchairAccessible === 'POSSIBLE',
    cancelled: Boolean(leg.cancelled),
    realTime: Boolean(leg.realTime),
    delayMin,
    state: where.state,
    position: where.position,
    nextStopIndex: where.nextStopIndex,
    atStop: where.atStop,
    progress: where.progress,
    startTime: stops[0]?.when ?? null,
    endTime: stops[stops.length - 1]?.arrival ?? stops[stops.length - 1]?.when ?? null,
    stops,
    geometry,
    at: new Date(now).toISOString(),
  };
  return c.json(envelope(journey, 'transitous.org'));
});
