import { Hono } from 'hono';
import type { Aircraft, AircraftClass, AircraftDetails, Airport, BosInfo, BosRole } from '@lagebild/shared';
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

/* ------------------------------------------------------------------ */
/* BOS-Luftfahrzeuge                                                    */
/* ------------------------------------------------------------------ */

/**
 * Erkennung von Rettungs-, Polizei- und Zollflug.
 *
 * Zwei Wege, weil keiner allein reicht: Das **Rufzeichen** ist sofort da und
 * sagt zugleich die Aufgabe („CHX43" = Christoph 43, ein Rettungshubschrauber
 * — auch wenn ihn die Bundespolizei betreibt). Es fehlt aber oft: Manche
 * Maschinen senden statt eines Rufzeichens ihre Kennung („DHXCA" für D-HXCA).
 * Dann hilft der **Halter** aus der Luftfahrzeugrolle (adsbdb) weiter, der für
 * genau diese Fälle nachgeschlagen wird.
 */
const ROLE_BY_CALLSIGN: [RegExp, BosRole][] = [
  // Luftrettung: Christoph (zivil und Bundespolizei), Intensivtransport,
  // Ambulanzflüge. „Christoph n" wird als CHXn und als CHRn gesendet.
  [/^(CHX|CHR)\d/, 'hems'],
  [/^(RTH|ITH|AMBU?\d|MEDIC)/, 'hems'],
  // Bundespolizei-Fliegergruppe und die Staffeln der Länder. „IBIS", „PHS",
  // „PIWI" und die Vogelnamen sind eingeführte Staffelrufzeichen.
  [/^(BPO|POL|PHS|PHX|PIWI|IBIS|HUMMEL|LIBELLE|EDELWEISS|SEEADLER|BUSSARD|HABICHT|PHOENIX)/, 'police'],
  [/^SAR\d?/, 'sar'],
  [/^(ZOLL|CUSTOM)/, 'customs'],
];

/** Halterbezeichnungen aus der Luftfahrzeugrolle. */
const ROLE_BY_OWNER: [RegExp, BosRole][] = [
  [/luftrettung|air ambulance|air rescue|rettungsflugwacht|adac|drf|johanniter|luftrettungsstaffel/i, 'hems'],
  [/bundespolizei|police|polizei|landeskriminalamt/i, 'police'],
  [/feuerwehr|fire (brigade|department)/i, 'fire'],
  [/zoll|customs/i, 'customs'],
];

/**
 * Viele Maschinen senden als Rufzeichen schlicht ihre Kennung („PHSVD" für
 * PH-SVD). Das ist kein Staffelrufzeichen und darf die Mustererkennung nicht
 * auslösen — sonst wird aus einem niederländischen Privathubschrauber ein
 * Polizeihubschrauber, weil „PHS…" passt.
 */
function isRegistrationCallsign(callsign: string, registration: string | null): boolean {
  if (!registration) return false;
  return callsign.toUpperCase() === registration.toUpperCase().replace(/-/g, '');
}

function roleFromCallsign(callsign: string | null, registration: string | null): BosRole | null {
  if (!callsign) return null;
  const cs = callsign.toUpperCase();
  if (isRegistrationCallsign(cs, registration)) return null;
  for (const [re, role] of ROLE_BY_CALLSIGN) if (re.test(cs)) return role;
  return null;
}

function roleFromOwner(owner: string | null): BosRole | null {
  if (!owner) return null;
  for (const [re, role] of ROLE_BY_OWNER) if (re.test(owner)) return role;
  return null;
}

/** „CHX43" → „Christoph 43"; die Nummer ist der Standort des Hubschraubers. */
function bosName(callsign: string | null): string | null {
  const m = callsign?.toUpperCase().match(/^CH[XR](\d{1,3}|E\d{1,2})$/);
  if (!m) return null;
  const suffix = m[1]!;
  return suffix.startsWith('E') ? `Christoph Europa ${suffix.slice(1)}` : `Christoph ${suffix}`;
}

/** Halter werden lange gehalten — sie ändern sich über Jahre nicht. */
const OWNER_TTL = 7 * 24 * 3600;
/** So viele unbekannte Maschinen werden je Abfrage nachgeschlagen. */
const MAX_OWNER_LOOKUPS = 8;

/**
 * Halter zu einer ICAO-Adresse. Getrennt vom Popup-Nachschlag, weil hier nur
 * der Halter zählt und das Ergebnis über Tage gilt; `null` heißt „nicht in der
 * Rolle" und wird ebenso gemerkt, damit nicht bei jeder Abfrage erneut gefragt
 * wird.
 */
async function ownerOf(icao: string, budget: { left: number }): Promise<string | null> {
  const cache = cached<string | null>(`aircraft-owner:${icao}`, OWNER_TTL);
  if (cache.hit !== undefined) return cache.hit;
  if (budget.left <= 0) return null;
  budget.left--;
  try {
    const res = await fetchJson<AdsbdbAircraft>(`${ADSBDB_BASE}/aircraft/${icao}`, { timeoutMs: 6000 });
    return cache.set(res.response?.aircraft?.registered_owner ?? null);
  } catch {
    // Auch der Fehlschlag wird gemerkt — sonst hängt jede Abfrage am selben
    // unbekannten Hubschrauber.
    return cache.set(null);
  }
}

/**
 * BOS-Merkmal ergänzen. Das Rufzeichen entscheidet über die Aufgabe, der
 * Halter füllt die Lücken und liefert den Betreiber. Nachgeschlagen wird nur
 * bei Drehflüglern ohne erkanntes Rufzeichen — Verkehrsflugzeuge kommen für
 * die Ebene ohnehin nicht in Frage.
 */
async function withBos(list: Aircraft[]): Promise<Aircraft[]> {
  const budget = { left: MAX_OWNER_LOOKUPS };
  const roles = new Map<string, BosRole | null>();
  const owners = new Map<string, string | null>();
  for (const a of list) roles.set(a.icao, roleFromCallsign(a.callsign, a.registration));

  // Erst die offenen Fälle: Nur dort **entscheidet** der Halter darüber, ob die
  // Maschine überhaupt in die Ebene gehört.
  for (const a of list) {
    if (roles.get(a.icao) || a.aircraftClass !== 'helicopter') continue;
    const owner = await ownerOf(a.icao, budget);
    owners.set(a.icao, owner);
    roles.set(a.icao, roleFromOwner(owner));
  }
  // Was übrig bleibt, geht in den Betreibernamen der schon erkannten Mittel.
  for (const a of list) {
    if (!roles.get(a.icao) || owners.has(a.icao)) continue;
    owners.set(a.icao, await ownerOf(a.icao, budget));
  }

  return list.map((a) => {
    const role = roles.get(a.icao) ?? null;
    const bos: BosInfo | null = role
      ? { role, name: bosName(a.callsign), operator: owners.get(a.icao) ?? null }
      : null;
    return { ...a, bos };
  });
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

/**
 * Flugzeuge um die Mitte des Ausschnitts holen. Beide Ebenen (alle Flugzeuge
 * und nur die BOS-Mittel) teilen sich diese Abfrage samt Cache — sonst würde
 * dasselbe Netz zweimal belastet, wenn beide Ebenen an sind.
 */
async function load(bbox: NonNullable<ReturnType<typeof readBbox>>): Promise<{ list: Aircraft[]; stale: boolean }> {
  const center = bboxCenter(bbox);
  // Radius so wählen, dass der ganze Ausschnitt abgedeckt ist (Ecke + Puffer).
  const cornerKm = distanceKm(center, { lat: bbox.north, lon: bbox.east });
  const radiusNm = Math.min(Math.ceil((cornerKm * 1.15) / KM_PER_NM) + 2, MAX_RADIUS_NM);

  // Grob gerasterter Cache-Schlüssel: benachbarte Ausschnitte teilen sich die Abfrage.
  const key = `aircraft:${center.lat.toFixed(1)}:${center.lon.toFixed(1)}:${radiusNm}`;
  const cache = cached<Aircraft[]>(key, 12);
  if (cache.hit) return { list: cache.hit, stale: true };

  const body = await fetchJson<{ ac?: AdsbAircraft[]; aircraft?: AdsbAircraft[] }>(
    `${ADSB_BASE}/lat/${center.lat.toFixed(4)}/lon/${center.lon.toFixed(4)}/dist/${radiusNm}`,
    { timeoutMs: 9000 },
  );
  const list = (body.ac ?? body.aircraft ?? []).map(normalize).filter((a): a is Aircraft => a !== null);
  cache.set(list);
  return { list, stale: false };
}

aircraftRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  const { list, stale } = await load(bbox);
  return c.json(envelope(list.filter((a) => inBbox(a.coordinates, bbox)), 'adsb.fi', stale));
});

/**
 * Nur die Luftfahrzeuge von Behörden und Organisationen mit
 * Sicherheitsaufgaben. Eigene Ebene, weil ein kreisender Rettungs- oder
 * Polizeihubschrauber ein Lagehinweis ist, der zwischen hunderten
 * Verkehrsflugzeugen untergeht.
 *
 * **Muss vor `/:icao` stehen** — sonst fängt die Detailroute den Pfad ab.
 */
aircraftRoute.get('/bos', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  const { list, stale } = await load(bbox);
  const visible = list.filter((a) => inBbox(a.coordinates, bbox));
  const enriched = await withBos(visible);
  return c.json(envelope(enriched.filter((a) => a.bos), 'adsb.fi · adsbdb.com', stale));
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
