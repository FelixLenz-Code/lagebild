import { Hono } from 'hono';
import type { NewsItem, NewsPlace, StateCode } from '@lagebild/shared';
import { FEDERAL_STATE_BOUNDS } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
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
/** Umgekehrte Zuordnung: unser Ländercode → Regionskennung der Tagesschau. */
const STATE_TO_REGION: Record<string, number> = Object.fromEntries(
  Object.entries(REGION_TO_STATE).map(([region, code]) => [code, Number(region)]),
);
/** Kürzel der Rundfunkanstalten — Schlagworte, aber keine Orte. */
const BROADCASTERS = new Set(['HR', 'NDR', 'WDR', 'BR', 'MDR', 'SWR', 'RBB', 'SR', 'RB', 'ARD', 'ZDF']);

/**
 * Welche Landesprogramme passen zum Standort? Die Rechtecke überlappen sich
 * (Bremen liegt in Niedersachsen, Wiesbaden im rheinland-pfälzischen Rechteck)
 * — bei Nachrichten ist das kein Problem, sondern erwünscht: wer in Bremen
 * sitzt, interessiert sich auch für das Umland. Deshalb bis zu zwei Programme,
 * das am besten passende zuerst.
 */
function statesOf(point: { lat: number; lon: number }): StateCode[] {
  const hits: { code: StateCode; margin: number }[] = [];
  for (const [code, b] of Object.entries(FEDERAL_STATE_BOUNDS) as [StateCode, number[]][]) {
    if (point.lon < b[0]! || point.lon > b[2]! || point.lat < b[1]! || point.lat > b[3]!) continue;
    hits.push({
      code,
      margin: Math.min(point.lon - b[0]!, b[2]! - point.lon, point.lat - b[1]!, b[3]! - point.lat),
    });
  }
  // Kleine Länder zuerst: ein Stadtstaat ist der nähere Bezug als das Flächenland.
  hits.sort((a, b) => {
    const areaA = area(a.code);
    const areaB = area(b.code);
    return areaA - areaB;
  });
  return hits.slice(0, 2).map((h) => h.code);
}

function area(code: StateCode): number {
  const b = FEDERAL_STATE_BOUNDS[code];
  return (b[2] - b[0]) * (b[3] - b[1]);
}

/**
 * Ortsname aus der Schlagzeile raten: „CSD **in Schlüchtern**", „Landesstraße
 * **bei Penkun**". Der Treffer wird ohnehin gegen das Bundesland geprüft, ein
 * Fehlgriff fällt also durch das Raster.
 */
function placeFromTitle(title: string): string | null {
  const m = title.match(
    /\b(?:in|bei|aus|nahe|um|vor)\s+([A-ZÄÖÜ][\wäöüß.-]{2,}(?:\s[A-ZÄÖÜ][\wäöüß.-]{2,})?)/,
  );
  const found = m?.[1]?.trim();
  if (!found || ALL_STATE_NAMES.has(found)) return null;
  return found;
}

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
  // Mit Standort kommen zusätzlich die Meldungen des Regionalprogramms dazu
  // (hessenschau, NDR, BR … — die Tagesschau-API führt sie unter `regions`).
  const coords = readCoords(c);
  const states = coords ? statesOf(coords) : [];

  const cache = cached<NewsItem[]>(`news:tagesschau:${states.join('-') || 'de'}`, 300);
  if (cache.hit) return c.json(envelope(cache.hit, 'Tagesschau', true));

  const national = await fetchJson<{ news?: RawNews[] }>('https://www.tagesschau.de/api2u/news');
  const regional: RawNews[] = [];
  for (const state of states) {
    const region = STATE_TO_REGION[state];
    if (!region) continue;
    try {
      const res = await fetchJson<{ news?: RawNews[] }>(
        `https://www.tagesschau.de/api2u/news?regions=${region}`,
        { timeoutMs: 9000 },
      );
      regional.push(...(res.news ?? []).filter((n) => n.regionId === region).slice(0, 8));
    } catch {
      /* ohne Regionalteil bleibt die bundesweite Liste */
    }
  }

  const usable = (n: RawNews) => Boolean(n.title && (n.shareURL || n.detailsweb));
  const seen = new Set<string>();
  const raw: (RawNews & { regional?: boolean })[] = [];
  // Regionales zuerst — es ist für den Standort das Nähere.
  for (const n of regional.filter(usable).slice(0, 14)) {
    const id = n.sophoraId ?? n.externalId ?? n.shareURL ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    raw.push({ ...n, regional: true });
  }
  for (const n of (national.news ?? []).filter(usable).slice(0, 22)) {
    const id = n.sophoraId ?? n.externalId ?? n.shareURL ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    raw.push(n);
  }

  const budget = { left: MAX_LOOKUPS };
  const items: NewsItem[] = [];
  for (const n of raw) {
    const itemState = n.regionId ? REGION_TO_STATE[n.regionId] : undefined;
    let place: NewsPlace | undefined;
    if (itemState) {
      // Zuerst die genaueren Schlagworte: Landkreise und Städte vor dem
      // Landesnamen, der ohnehin nur den Mittelpunkt liefern würde.
      const fromTitle = placeFromTitle(n.title ?? '');
      const candidates = [
        ...(n.tags ?? [])
          .map((t) => t.tag?.trim() ?? '')
          // Landesnamen und Senderkürzel taugen nicht als genauer Ort.
          .filter((t) => t.length >= 3 && !ALL_STATE_NAMES.has(t) && !BROADCASTERS.has(t)),
        ...(fromTitle ? [fromTitle] : []),
      ].slice(0, TAGS_PER_ITEM);
      for (const tag of candidates) {
        const hit = await locate(tag, itemState, budget);
        if (hit && !hit.approximate) {
          place = hit;
          break;
        }
      }
      if (!place) {
        // Wenigstens das Bundesland — als solches gekennzeichnet.
        const b = FEDERAL_STATE_BOUNDS[itemState];
        place = {
          name: STATE_NAME[itemState],
          lat: (b[1] + b[3]) / 2,
          lon: (b[0] + b[2]) / 2,
          state: itemState,
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
      // Regionalmeldungen haben kein Ressort — dort steht das Land als Herkunft.
      topic: n.ressort || (n.regional && itemState ? STATE_NAME[itemState] : undefined),
      place,
      regional: n.regional,
    });
  }

  cache.set(items);
  return c.json(envelope(items, 'Tagesschau'));
});
