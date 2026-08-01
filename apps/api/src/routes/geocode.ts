import { Hono } from 'hono';
import type { GeoResult } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Orts-, Adress- und POI-Suche über Photon (Komoot, frei, ohne API-Key), auf
 * Deutschland eingegrenzt. Mit `lat`/`lon` bevorzugt Photon Treffer in der
 * Nähe — dieselbe Rangfolge wie in der Offline-Suche.
 * https://photon.komoot.io/
 */
export const geocodeRoute = new Hono();

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** osm_key/osm_value → Kategorie-Schlüssel (gleiche Namen wie im Offline-Index). */
function category(p: Record<string, unknown>): string {
  const key = str(p, 'osm_key');
  const value = str(p, 'osm_value');
  const type = str(p, 'type');
  const pair = `${key}=${value}`;
  const map: Record<string, string> = {
    'amenity=fuel': 'fuel',
    'amenity=charging_station': 'charging',
    'amenity=parking': 'parking',
    'amenity=pharmacy': 'pharmacy',
    'amenity=hospital': 'hospital',
    'amenity=clinic': 'hospital',
    'amenity=doctors': 'doctor',
    'amenity=dentist': 'doctor',
    'amenity=police': 'police',
    'amenity=fire_station': 'fire_station',
    'amenity=restaurant': 'restaurant',
    'amenity=cafe': 'cafe',
    'amenity=fast_food': 'fast_food',
    'amenity=bar': 'bar',
    'amenity=pub': 'bar',
    'amenity=atm': 'atm',
    'amenity=bank': 'bank',
    'amenity=post_office': 'post',
    'amenity=toilets': 'toilets',
    'amenity=school': 'school',
    'amenity=kindergarten': 'kindergarten',
    'amenity=university': 'university',
    'amenity=townhall': 'townhall',
    'amenity=place_of_worship': 'church',
    'amenity=ferry_terminal': 'ferry_terminal',
    'shop=supermarket': 'supermarket',
    'shop=convenience': 'supermarket',
    'shop=bakery': 'bakery',
    'tourism=hotel': 'hotel',
    'tourism=museum': 'museum',
    'tourism=viewpoint': 'viewpoint',
    'tourism=camp_site': 'camp',
    'leisure=playground': 'playground',
    'leisure=park': 'park',
    'railway=station': 'station',
    'railway=halt': 'station',
    'railway=tram_stop': 'tram_stop',
    'highway=bus_stop': 'bus_stop',
    'aeroway=aerodrome': 'airport',
    'natural=peak': 'peak',
    'natural=water': 'water',
  };
  if (map[pair]) return map[pair]!;
  if (key === 'shop') return 'shop';
  if (type === 'house') return 'address';
  if (type === 'street') return 'street';
  if (type === 'city' || type === 'district' || type === 'locality' || type === 'county') return 'place';
  return 'poi';
}

/** Anzeigename: „Name Hausnummer" bzw. der Ortsname. */
function label(p: Record<string, unknown>): string {
  const name = str(p, 'name');
  const street = str(p, 'street');
  const houseNumber = str(p, 'housenumber');
  if (name) return houseNumber && !name.includes(houseNumber) ? `${name} ${houseNumber}` : name;
  if (street) return houseNumber ? `${street} ${houseNumber}` : street;
  return str(p, 'city') ?? str(p, 'district') ?? str(p, 'state') ?? '';
}

/** Zweite Zeile: PLZ, Ort, Bezirk. */
function detail(p: Record<string, unknown>): string | null {
  const city = str(p, 'city') ?? str(p, 'district');
  const postcode = str(p, 'postcode');
  const street = str(p, 'street');
  const name = str(p, 'name');
  const parts = [
    name && street ? street : undefined,
    postcode && city ? `${postcode} ${city}` : city,
    str(p, 'state'),
  ];
  const text = parts.filter(Boolean).join(', ');
  return text.length ? text : null;
}

geocodeRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json(envelope([] as GeoResult[], 'Photon'));
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  const near = Number.isFinite(lat) && Number.isFinite(lon);

  const key = `geocode:${q.toLowerCase()}:${near ? `${lat.toFixed(1)},${lon.toFixed(1)}` : '-'}`;
  const cache = cached<GeoResult[]>(key, 3600);
  if (cache.hit) return c.json(envelope(cache.hit, 'Photon', true));

  const url =
    `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&lang=de&limit=10` +
    `&bbox=5.8,47.2,15.1,55.1` +
    (near ? `&lat=${lat}&lon=${lon}` : '');
  const data = await fetchJson<{ features?: PhotonFeature[] }>(url);
  const results: GeoResult[] = (data.features ?? [])
    .filter((f) => Array.isArray(f.geometry?.coordinates))
    .map((f) => {
      const p = f.properties ?? {};
      return {
        name: label(p),
        lat: f.geometry!.coordinates![1],
        lon: f.geometry!.coordinates![0],
        detail: detail(p),
        category: category(p),
        source: 'online' as const,
      };
    })
    .filter((r) => r.name.length > 0);

  cache.set(results);
  return c.json(envelope(results, 'Photon'));
});
