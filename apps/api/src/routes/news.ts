import { Hono } from 'hono';
import type { NewsItem, NewsPlace, StateCode } from '@lagebild/shared';
import { FEDERAL_STATE_BOUNDS } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Aktuelle Meldungen der Tagesschau-API (bund.dev). Wichtig: Endpunkt ohne
 * abschließenden Slash, sonst leitet der Server auf eine leere Antwort um.
 */
export const newsRoute = new Hono();

interface RawNews {
  sophoraId?: string;
  externalId?: string;
  title?: string;
  firstSentence?: string;
  date?: string;
  ressort?: string;
  shareURL?: string;
  detailsweb?: string;
  type?: string;
  /** Schlagworte — enthalten neben Themen auch Orte und Landkreise. */
  tags?: { tag?: string }[];
  /** Regionskennung der Tagesschau (1 = Baden-Württemberg, alphabetisch). */
  regionId?: number;
}

/** Tagesschau zählt die Länder alphabetisch, wir nach amtlichem Schlüssel. */
const REGION_TO_STATE: Record<number, StateCode> = {
  1: '08', // Baden-Württemberg
  2: '09', // Bayern
  3: '11', // Berlin
  4: '12', // Brandenburg
  5: '04', // Bremen
  6: '02', // Hamburg
  7: '06', // Hessen
  8: '13', // Mecklenburg-Vorpommern
  9: '03', // Niedersachsen
  10: '05', // Nordrhein-Westfalen
  11: '07', // Rheinland-Pfalz
  12: '10', // Saarland
  13: '14', // Sachsen
  14: '15', // Sachsen-Anhalt
  15: '01', // Schleswig-Holstein
  16: '16', // Thüringen
};

const STATE_NAME: Record<StateCode, string> = {
  '01': 'Schleswig-Holstein',
  '02': 'Hamburg',
  '03': 'Niedersachsen',
  '04': 'Bremen',
  '05': 'Nordrhein-Westfalen',
  '06': 'Hessen',
  '07': 'Rheinland-Pfalz',
  '08': 'Baden-Württemberg',
  '09': 'Bayern',
  '10': 'Saarland',
  '11': 'Berlin',
  '12': 'Brandenburg',
  '13': 'Mecklenburg-Vorpommern',
  '14': 'Sachsen',
  '15': 'Sachsen-Anhalt',
  '16': 'Thüringen',
};

const ALL_STATE_NAMES = new Set(Object.values(STATE_NAME));

/**
 * Orte aus den Schlagworten bestimmen.
 *
 * Die Tags mischen Themen und Orte („Gewerkschaften" neben „Schwerin"), und
 * eine Ortssuche findet zu fast jedem Wort irgendetwas — „Wetter" etwa eine
 * Stadt im Ruhrgebiet. Deshalb wird jeder Treffer gegen das **Bundesland der
 * Meldung** geprüft: liegt er außerhalb, war es kein Ortsname. Meldungen ohne
 * Region (bundesweit, Ausland) bekommen gar keinen Ort.
 */
interface PhotonHit {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

/** Ergebnisse werden lange gehalten — Ortsnamen ändern sich nicht. */
const GEO_TTL = 7 * 24 * 3600;
/** Höchstens so viele neue Abfragen je Aktualisierung (Photon schonen). */
const MAX_LOOKUPS = 15;
/** Je Meldung werden nur die aussichtsreichsten Schlagworte geprüft. */
const TAGS_PER_ITEM = 3;

async function locate(tag: string, state: StateCode, budget: { left: number }): Promise<NewsPlace | null> {
  const key = `newsgeo:${tag.toLowerCase()}`;
  const cache = cached<NewsPlace | null>(key, GEO_TTL);
  if (cache.hit !== undefined) return cache.hit;
  if (budget.left <= 0) return null;
  budget.left--;

  const box = FEDERAL_STATE_BOUNDS[state];
  try {
    const res = await fetchJson<{ features?: PhotonHit[] }>(
      `https://photon.komoot.io/api?q=${encodeURIComponent(tag)}&lang=de&limit=5&bbox=${box.join(',')}`,
      { timeoutMs: 8000 },
    );
    for (const f of res.features ?? []) {
      const c = f.geometry?.coordinates;
      const p = f.properties ?? {};
      const type = typeof p.type === 'string' ? p.type : '';
      // Nur Orte und Verwaltungseinheiten zählen, keine Straßen oder Geschäfte.
      if (!c || !['city', 'town', 'village', 'district', 'county', 'state', 'locality'].includes(type)) continue;
      const [lon, lat] = c;
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
      // Ein ganzes Bundesland ist kein Ort — dann bleibt es beim Mittelpunkt.
      const place: NewsPlace = { name: tag, lat, lon, state, approximate: type === 'state' };
      cache.set(place);
      return place;
    }
  } catch {
    /* Ortssuche nicht erreichbar → Meldung bleibt beim Bundesland */
  }
  cache.set(null);
  return null;
}

newsRoute.get('/', async (c) => {
  const cache = cached<NewsItem[]>('news:tagesschau', 300);
  if (cache.hit) return c.json(envelope(cache.hit, 'Tagesschau', true));

  const body = await fetchJson<{ news?: RawNews[] }>('https://www.tagesschau.de/api2u/news');
  const raw = (body.news ?? []).filter((n) => n.title && (n.shareURL || n.detailsweb)).slice(0, 30);

  const budget = { left: MAX_LOOKUPS };
  const items: NewsItem[] = [];
  for (const n of raw) {
    const state = n.regionId ? REGION_TO_STATE[n.regionId] : undefined;
    let place: NewsPlace | undefined;
    if (state) {
      // Zuerst die genaueren Schlagworte: Landkreise und Städte vor dem
      // Landesnamen, der ohnehin nur den Mittelpunkt liefern würde.
      const candidates = (n.tags ?? [])
        .map((t) => t.tag?.trim() ?? '')
        // Landesnamen (egal welches) taugen nicht als genauer Ort.
        .filter((t) => t.length >= 3 && !ALL_STATE_NAMES.has(t))
        .slice(0, TAGS_PER_ITEM);
      for (const tag of candidates) {
        const hit = await locate(tag, state, budget);
        if (hit && !hit.approximate) {
          place = hit;
          break;
        }
      }
      if (!place) {
        // Wenigstens das Bundesland — als solches gekennzeichnet.
        const b = FEDERAL_STATE_BOUNDS[state];
        place = {
          name: STATE_NAME[state],
          lat: (b[1] + b[3]) / 2,
          lon: (b[0] + b[2]) / 2,
          state,
          approximate: true,
        };
      }
    }
    items.push({
      id: n.sophoraId ?? n.externalId ?? (n.shareURL as string),
      title: (n.title as string).trim(),
      summary: n.firstSentence || undefined,
      url: (n.shareURL ?? n.detailsweb) as string,
      publishedAt: n.date ?? null,
      topic: n.ressort || undefined,
      place,
    });
  }

  cache.set(items);
  return c.json(envelope(items, 'Tagesschau'));
});
