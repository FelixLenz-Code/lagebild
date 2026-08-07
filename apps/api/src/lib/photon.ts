import type { NewsPlace, StateCode } from '@lagebild/shared';
import { FEDERAL_STATE_BOUNDS } from '@lagebild/shared';
import { cached } from './cache.js';
import { fetchJson } from './http.js';
import { ALL_STATE_NAMES } from './states.js';

/**
 * Ortsnamen aus Meldungen in Koordinaten übersetzen (Photon/Komoot).
 *
 * Der schwierige Teil ist nicht die Abfrage, sondern das Aussortieren: Photon
 * findet zu fast jedem Wort irgendetwas — „Wetter" ist eine Stadt im
 * Ruhrgebiet, „Gewerkschaften" eine Straße. Deshalb zwei Filter: nur Ortstypen
 * zählen, und der Treffer muss im mitgegebenen Rechteck liegen. Ein Fehlgriff
 * fällt damit durch das Raster, statt die Karte zu verschmutzen.
 */

/** Ergebnisse werden lange gehalten — Ortsnamen ändern sich nicht. */
export const PLACE_TTL = 7 * 24 * 3600;

/** Ortstypen, die als Ortsangabe taugen. */
const PLACE_TYPES = ['city', 'town', 'village', 'district', 'county', 'state', 'locality'];

/** Deutschland als Rückfallrechteck, wenn kein Land bekannt ist. */
export const GERMANY_BOX: [number, number, number, number] = [5.8, 47.2, 15.1, 55.1];

interface PhotonHit {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

/** Zähler für das Abfragebudget einer Aktualisierung — schont Photon. */
export interface LookupBudget {
  left: number;
}

/**
 * Ort suchen und gegen `box` prüfen. `state` wird nur durchgereicht, damit die
 * Meldung später weiß, aus welchem Land sie stammt.
 */
export async function lookupPlace(
  name: string,
  box: readonly number[],
  budget: LookupBudget,
  state?: StateCode,
): Promise<NewsPlace | null> {
  const key = `place:${name.toLowerCase()}:${box.join(',')}`;
  const cache = cached<NewsPlace | null>(key, PLACE_TTL);
  if (cache.hit !== undefined) return cache.hit;
  if (budget.left <= 0) return null;
  budget.left--;

  try {
    const res = await fetchJson<{ features?: PhotonHit[] }>(
      `https://photon.komoot.io/api?q=${encodeURIComponent(name)}&lang=de&limit=5&bbox=${box.join(',')}`,
      { timeoutMs: 8000 },
    );
    for (const f of res.features ?? []) {
      const c = f.geometry?.coordinates;
      const p = f.properties ?? {};
      const type = typeof p.type === 'string' ? p.type : '';
      if (!c || !PLACE_TYPES.includes(type)) continue;
      const [lon, lat] = c;
      if (lon < box[0]! || lon > box[2]! || lat < box[1]! || lat > box[3]!) continue;
      // Ein ganzes Bundesland ist kein Ort — dann bleibt es beim Mittelpunkt.
      const place: NewsPlace = { name, lat, lon, state, approximate: type === 'state' };
      cache.set(place);
      return place;
    }
  } catch {
    /* Ortssuche nicht erreichbar → Meldung bleibt ohne Ort */
  }
  cache.set(null);
  return null;
}

/** Rechteck eines Bundeslands, sonst Deutschland. */
export function boxFor(state?: StateCode): readonly number[] {
  return state ? FEDERAL_STATE_BOUNDS[state] : GERMANY_BOX;
}

/** Mittelpunkt eines Bundeslands als grober Ort, wenn nichts Genaueres da ist. */
export function stateCenter(state: StateCode, label: string): NewsPlace {
  const b = FEDERAL_STATE_BOUNDS[state];
  return { name: label, lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2, state, approximate: true };
}

/** Landesnamen taugen nicht als genauer Ort. */
export function isStateName(name: string): boolean {
  return ALL_STATE_NAMES.has(name);
}
