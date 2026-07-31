import { Hono } from 'hono';
import type { Aircraft } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { readBbox, bboxCenter, inBbox } from '../lib/geo.js';
import { distanceKm } from '../lib/distance.js';

/**
 * Flugverkehr aus dem offenen ADS-B-Netz (adsb.lol — freiwillige Empfänger,
 * frei und ohne Key). Abgefragt wird ein Kreis um die Mitte des Kartenaus-
 * schnitts; gefiltert wird anschließend auf den Ausschnitt selbst.
 * https://api.adsb.lol/docs
 */
export const aircraftRoute = new Hono();

const ADSB_BASE = process.env.ADSB_BASE ?? 'https://api.adsb.lol/v2';
/** Der Dienst deckelt den Radius bei 250 Seemeilen. */
const MAX_RADIUS_NM = 250;
const KM_PER_NM = 1.852;

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  baro_rate?: number;
  geom_rate?: number;
  gs?: number;
  track?: number;
  squawk?: string;
  emergency?: string;
}

const EMERGENCY_BY_SQUAWK: Record<string, Aircraft['emergency']> = {
  '7500': 'hijack',
  '7600': 'radio-failure',
  '7700': 'general',
};

function normalize(a: AdsbAircraft): Aircraft | null {
  if (!a.hex || typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
  const onGround = a.alt_baro === 'ground';
  return {
    icao: a.hex,
    callsign: a.flight?.trim() || null,
    registration: a.r ?? null,
    type: a.t ?? null,
    description: a.desc ?? null,
    coordinates: { lat: a.lat, lon: a.lon },
    altitudeFt: typeof a.alt_baro === 'number' ? a.alt_baro : null,
    verticalRateFpm: a.baro_rate ?? a.geom_rate ?? null,
    groundSpeedKt: a.gs ?? null,
    trackDeg: a.track ?? null,
    onGround,
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
  const all =
    cache.hit ??
    cache.set(
      (
        await fetchJson<{ ac?: AdsbAircraft[] }>(
          `${ADSB_BASE}/lat/${center.lat.toFixed(4)}/lon/${center.lon.toFixed(4)}/dist/${radiusNm}`,
          { timeoutMs: 9000 },
        )
      ).ac
        ?.map(normalize)
        .filter((a): a is Aircraft => a !== null) ?? [],
    );

  const visible = all.filter((a) => inBbox(a.coordinates, bbox));
  return c.json(envelope(visible, 'adsb.lol', cache.hit !== undefined));
});
