import { Hono } from 'hono';
import type { Aircraft, AircraftClass, AircraftDetails, Airport } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { readBbox, bboxCenter, inBbox } from '../lib/geo.js';
import { distanceKm } from '../lib/distance.js';

/**
 * Flugverkehr aus dem offenen ADS-B-Netz (freiwillige Empfänger, frei und ohne
 * Key). Abgefragt wird ein Kreis um die Mitte des Kartenausschnitts; gefiltert
 * wird anschließend auf den Ausschnitt selbst.
 *
 * Zusatzdaten (Halter, Muster, Flugroute) liefert auf Klick adsbdb.com — auch
 * frei und ohne Key. Diese Abfrage läuft bewusst nur für ein einzelnes
 * Flugzeug, nicht für die ganze Liste.
 */
export const aircraftRoute = new Hono();

// adsb.fi liefert zusätzlich `desc` (Klartext-Muster); adsb.lol/airplanes.live
// sprechen dasselbe Format und lassen sich per Env einsetzen.
const ADSB_BASE = process.env.ADSB_BASE ?? 'https://opendata.adsb.fi/api/v2';
const ADSBDB_BASE = process.env.ADSBDB_BASE ?? 'https://api.adsbdb.com/v0';
/** Der Dienst deckelt den Radius bei 250 Seemeilen. */
const MAX_RADIUS_NM = 250;
const KM_PER_NM = 1.852;

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  category?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  nav_altitude_mcp?: number;
  baro_rate?: number;
  geom_rate?: number;
  gs?: number;
  ias?: number;
  mach?: number;
  track?: number;
  oat?: number;
  wd?: number;
  ws?: number;
  dst?: number;
  seen?: number;
  squawk?: string;
  emergency?: string;
}

const EMERGENCY_BY_SQUAWK: Record<string, Aircraft['emergency']> = {
  '7500': 'hijack',
  '7600': 'radio-failure',
  '7700': 'general',
};

/** ADS-B-Kategorien: A1 leicht … A5 schwer, A7 Drehflügler, B1/B2 Segler & Ballon. */
const CLASS_BY_CATEGORY: Record<string, AircraftClass> = {
  A1: 'light',
  A2: 'jet',
  A3: 'jet',
  A4: 'heavy',
  A5: 'heavy',
  A6: 'jet',
  A7: 'helicopter',
  B1: 'glider',
  B2: 'glider',
  B4: 'light',
};

/** Musterkürzel, die sich ohne Kategorie zuordnen lassen. */
const HELICOPTER_TYPES = /^(EC|AS|R2|R4|R6|H1|H2|H5|H6|S7|S9|A1[0-9]9|B06|B47|B4T|BK1|MD5|NH9|UH|EH1|SH)/;
const GLIDER_TYPES = /^(GLID|DG|LS[0-9]|AS[0-9]{2}|DISC|VENT|ARCU|NIMB|JS[0-9]|SZD|PIPI|BALL|SHK)/;

function classify(a: AdsbAircraft): AircraftClass {
  const byCategory = a.category ? CLASS_BY_CATEGORY[a.category] : undefined;
  if (byCategory) return byCategory;
  const type = a.t ?? '';
  if (HELICOPTER_TYPES.test(type)) return 'helicopter';
  if (GLIDER_TYPES.test(type)) return 'glider';
  // Kleinflugzeuge tragen meist Muster wie C172, PA28, DA40.
  if (/^(C1[0-9]{2}|C2[0-9]{2}|PA[0-9]{2}|DA[0-9]{2}|SR2|BE[0-9]{2}|AT[0-9]{2}|RV[0-9])/.test(type)) return 'light';
  return type ? 'jet' : 'other';
}

function normalize(a: AdsbAircraft): Aircraft | null {
  if (!a.hex || typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
  return {
    icao: a.hex,
    callsign: a.flight?.trim() || null,
    registration: a.r ?? null,
    type: a.t ?? null,
    description: a.desc ?? null,
    category: a.category ?? null,
    aircraftClass: classify(a),
    coordinates: { lat: a.lat, lon: a.lon },
    altitudeFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
    selectedAltitudeFt: a.nav_altitude_mcp ?? null,
    verticalRateFpm: a.baro_rate ?? a.geom_rate ?? null,
    groundSpeedKt: a.gs ?? null,
    indicatedSpeedKt: a.ias ?? null,
    mach: a.mach ?? null,
    trackDeg: a.track ?? null,
    outsideTempC: a.oat ?? null,
    windDirDeg: a.wd ?? null,
    windKt: a.ws ?? null,
    distanceKm: a.dst != null ? Math.round(a.dst * KM_PER_NM * 10) / 10 : null,
    seenSec: a.seen ?? null,
    onGround: a.alt_baro === 'ground',
    squawk: a.squawk ?? null,
    emergency: (a.squawk && EMERGENCY_BY_SQUAWK[a.squawk]) || null,
  };
}

aircraftRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);

  const center = bboxCenter(bbox);
  // Radius so wählen, dass der ganze Ausschnitt abgedeckt ist (Ecke + Puffer).
  const cornerKm = distanceKm(center, { lat: bbox.north, lon: bbox.east });
  const radiusNm = Math.min(Math.ceil((cornerKm * 1.15) / KM_PER_NM) + 2, MAX_RADIUS_NM);

  // Grob gerasterter Cache-Schlüssel: benachbarte Ausschnitte teilen sich die Abfrage.
  const key = `aircraft:${center.lat.toFixed(1)}:${center.lon.toFixed(1)}:${radiusNm}`;
  const cache = cached<Aircraft[]>(key, 12);
  const visible = (list: Aircraft[]) => list.filter((a) => inBbox(a.coordinates, bbox));
  if (cache.hit) return c.json(envelope(visible(cache.hit), 'adsb.fi', true));

  const body = await fetchJson<{ ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] }>(
    `${ADSB_BASE}/lat/${center.lat.toFixed(4)}/lon/${center.lon.toFixed(4)}/dist/${radiusNm}`,
    { timeoutMs: 9000 },
  );
  const list = (body.ac ?? body.aircraft ?? []).map(normalize).filter((a): a is Aircraft => a !== null);
  cache.set(list);

  return c.json(envelope(visible(list), 'adsb.fi'));
});

// --- Zusatzdaten zu einem Flug (auf Klick) ------------------------------

interface AdsbdbAirport {
  name?: string;
  municipality?: string;
  iata_code?: string;
  icao_code?: string;
  country_name?: string;
}
interface AdsbdbCallsign {
  response?: {
    flightroute?: {
      airline?: { name?: string };
      origin?: AdsbdbAirport;
      destination?: AdsbdbAirport;
    };
  };
}
interface AdsbdbAircraft {
  response?: {
    aircraft?: {
      type?: string;
      manufacturer?: string;
      registration?: string;
      registered_owner?: string;
      registered_owner_country_name?: string;
    };
  };
}

function toAirport(a: AdsbdbAirport | undefined): Airport | null {
  if (!a?.name) return null;
  return {
    name: a.name,
    municipality: a.municipality ?? null,
    iata: a.iata_code ?? null,
    icao: a.icao_code ?? null,
    countryName: a.country_name ?? null,
  };
}

/**
 * Halter, Muster und Flugroute zu einer ICAO-Adresse. Wird nur abgerufen, wenn
 * der Nutzer ein Flugzeug antippt, und lange gecacht — die Daten sind statisch
 * bzw. gelten für den ganzen Flug.
 */
aircraftRoute.get('/:icao', async (c) => {
  const icao = c.req.param('icao').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(icao)) return c.json({ error: 'ungültige ICAO-Adresse' }, 400);
  const callsign = (c.req.query('callsign') ?? '').trim().toUpperCase();

  const key = `aircraft-details:${icao}:${callsign}`;
  const cache = cached<AircraftDetails>(key, 3600);
  if (cache.hit) return c.json(envelope(cache.hit, 'adsbdb.com', true));

  const details: AircraftDetails = {
    icao,
    registration: null,
    type: null,
    manufacturer: null,
    owner: null,
    ownerCountry: null,
    airline: null,
    origin: null,
    destination: null,
  };

  const [plane, route] = await Promise.allSettled([
    fetchJson<AdsbdbAircraft>(`${ADSBDB_BASE}/aircraft/${icao}`, { timeoutMs: 6000 }),
    callsign && /^[A-Z0-9]{3,8}$/.test(callsign)
      ? fetchJson<AdsbdbCallsign>(`${ADSBDB_BASE}/callsign/${callsign}`, { timeoutMs: 6000 })
      : Promise.resolve({} as AdsbdbCallsign),
  ]);

  if (plane.status === 'fulfilled') {
    const a = plane.value.response?.aircraft;
    details.registration = a?.registration ?? null;
    details.type = a?.type ?? null;
    details.manufacturer = a?.manufacturer ?? null;
    details.owner = a?.registered_owner ?? null;
    details.ownerCountry = a?.registered_owner_country_name ?? null;
  }
  if (route.status === 'fulfilled') {
    const r = route.value.response?.flightroute;
    details.airline = r?.airline?.name ?? null;
    details.origin = toAirport(r?.origin);
    details.destination = toAirport(r?.destination);
  }

  cache.set(details);
  return c.json(envelope(details, 'adsbdb.com'));
});
