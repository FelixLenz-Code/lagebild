import { Hono } from 'hono';
import type { NewsCategory, NewsItem, NewsPlace, StateCode } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { ALL_STATE_NAMES, STATE_NAME, statesOf } from '../lib/states.js';
import { boxFor, isStateName, lookupPlace, stateCenter, type LookupBudget } from '../lib/photon.js';

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
  /** Dachzeile, oft das Bundesland. */
  topline?: string;
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

/** Umgekehrte Zuordnung: unser Ländercode → Regionskennung der Tagesschau. */
const STATE_TO_REGION: Record<string, number> = Object.fromEntries(
  Object.entries(REGION_TO_STATE).map(([region, code]) => [code, Number(region)]),
);
/** Kürzel der Rundfunkanstalten — Schlagworte, aber keine Orte. */
const BROADCASTERS = new Set(['HR', 'NDR', 'WDR', 'BR', 'MDR', 'SWR', 'RBB', 'SR', 'RB', 'ARD', 'ZDF']);

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
  if (!found || isStateName(found)) return null;
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
/** Höchstens so viele neue Abfragen je Aktualisierung (Photon schonen). */
const MAX_LOOKUPS = 20;
/** So viele Meldungen je Landesprogramm bzw. bundesweit übernehmen. */
const REGIONAL_PER_STATE = 20;
const NATIONAL_MAX = 60;
/** Je Meldung werden nur die aussichtsreichsten Schlagworte geprüft. */
const TAGS_PER_ITEM = 3;

function locate(tag: string, state: StateCode, budget: LookupBudget): Promise<NewsPlace | null> {
  return lookupPlace(tag, boxFor(state), budget, state);
}

/* ------------------------------------------------------------------ */
/* Einordnung der Meldungen                                            */
/* ------------------------------------------------------------------ */

/**
 * Stichwortlisten je Kategorie, in dieser Reihenfolge geprüft: Gefahren
 * zuerst, damit „Sturmschäden" als Gefahr und nicht als Wetter landet.
 *
 * **Ohne `\b` am Wortanfang** — im Deutschen steckt das Stichwort meist in
 * einer Zusammensetzung („Flugzeugabsturz", „Unwetterwarnung"). Dafür sind die
 * Stichworte lang genug gewählt, damit sie nicht in harmlosen Wörtern
 * auftauchen. Das ist bewusst grob: Es soll auf der Karte das Wichtige
 * hervorheben, nicht den Inhalt erschöpfend beschreiben.
 */
/**
 * Stichwort-Regel je Kategorie.
 *
 * `start` muss ein Wort **beginnen** — „Brand" ja, „Deichbrand-Festival" nein.
 * `anywhere` darf auch in einer Zusammensetzung stecken, weil das Stichwort im
 * Deutschen oft hinten steht: „Flugzeugabsturz", „Vollsperrung",
 * „Verkehrsunfall". Die Trennung verhindert die typischen Fehlgriffe.
 */
function rule(start: string[], anywhere: string[] = []): RegExp {
  const parts: string[] = [];
  if (start.length) parts.push(`(?<![a-zäöüß])(?:${start.join('|')})`);
  if (anywhere.length) parts.push(`(?:${anywhere.join('|')})`);
  return new RegExp(parts.join('|'), 'i');
}

const CATEGORY_WORDS: [NewsCategory, RegExp][] = [
  [
    'danger',
    rule(
      [
        'brand', 'brennt', 'feuer(?!wehr)', 'angriff', 'attacke', 'alarm', 'amok', 'bombe',
        'explosion', 'evakuier', 'vermisst', 'tote', 'getötet', 'verletzt', 'leiche',
        'sturmtief', 'sturmflut', 'rettungseinsatz', 'rettungskräfte', 'notfall', 'warnstufe',
      ],
      [
        'absturz', 'unfall', 'kollision', 'hochwasser', 'überschwemm', 'unwetter', 'waldbrand',
        'starkregen', 'orkan', 'entgleis', 'blindgänger', 'gefahrgut', 'katastroph', 'erdbeben',
        'schüsse', 'schießerei', 'schusswaffe', 'sprengung', 'gesperrt', 'sperrung', 'messerangriff',
      ],
    ),
  ],
  [
    'crime',
    rule(
      ['polizei', 'festnahme', 'festgenommen', 'razzia', 'drogen', 'betrug', 'diebstahl', 'einbruch', 'überfall', 'urteil', 'prozess', 'gericht'],
      ['ermittl', 'tatverdäch', 'staatsanwalt', 'kriminal', 'haftbefehl', 'missbrauch'],
    ),
  ],
  [
    'traffic',
    rule(
      ['stau', 'streik', 'baustelle', 'flughafen', 'fähre', 'umleitung', 'fahrplan'],
      ['bahnverkehr', 'zugverkehr', 'verkehr', 'autobahn', 'nahverkehr', 's-bahn', 'straßenbahn', 'schienenersatz'],
    ),
  ],
  ['weather', rule(['wetter', 'regen', 'hitze', 'dürre', 'schnee', 'glätte', 'sonnig', 'frost'], ['temperatur'])],
  [
    'health',
    rule(['klinik', 'virus', 'grippe', 'corona', 'ärzte', 'ärztin', 'pflege', 'impf', 'patient'], ['krankenhaus', 'infektion', 'gesundheit', 'notaufnahme']),
  ],
  [
    'politics',
    rule(['wahl', 'landtag', 'bundestag', 'regierung', 'minister', 'partei', 'koalition', 'abstimmung', 'bürgermeister', 'stadtrat', 'gesetz', 'behörde', 'afd', 'cdu', 'spd', 'grüne', 'fdp']),
  ],
  [
    'economy',
    rule(['wirtschaft', 'insolvenz', 'tarif', 'gehalt', 'unternehmen', 'firma', 'konzern', 'steuer', 'preise', 'inflation', 'börse', 'handel'], ['arbeitsmarkt']),
  ],
  [
    'sport',
    rule(['fußball', 'bundesliga', 'spieltag', 'olympia', 'turnier', 'sport', 'eintracht', 'werder', 'schalke', 'stadion', 'triathlon', 'handball', 'regatta'], ['meisterschaft']),
  ],
  [
    'culture',
    rule(['festival', 'konzert', 'museum', 'theater', 'kultur', 'ausstellung', 'csd', 'kirche', 'bistum', 'kino', 'literatur'], ['jubiläum']),
  ],
];

/**
 * Zuerst zählt die Schlagzeile (mit den Schlagworten) — der Anriss dient nur
 * als Rückfall. Sonst landet „Wiederaufbau eines Kirchturms" bei den Gefahren,
 * weil im Text irgendwo der Brand von damals erwähnt wird.
 */
function classify(n: RawNews): NewsCategory {
  const headline = `${n.title ?? ''} ${(n.tags ?? []).map((t) => t.tag ?? '').join(' ')}`;
  for (const [category, re] of CATEGORY_WORDS) {
    if (re.test(headline)) return category;
  }
  const body = n.firstSentence ?? '';
  for (const [category, re] of CATEGORY_WORDS) {
    if (re.test(body)) return category;
  }
  return 'other';
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
      regional.push(...(res.news ?? []).filter((n) => n.regionId === region).slice(0, REGIONAL_PER_STATE));
    } catch {
      /* ohne Regionalteil bleibt die bundesweite Liste */
    }
  }

  const usable = (n: RawNews) => Boolean(n.title && (n.shareURL || n.detailsweb));
  const seen = new Set<string>();
  const raw: (RawNews & { regional?: boolean })[] = [];
  // Regionales zuerst — es ist für den Standort das Nähere.
  for (const n of regional.filter(usable)) {
    const id = n.sophoraId ?? n.externalId ?? n.shareURL ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    raw.push({ ...n, regional: true });
  }
  for (const n of (national.news ?? []).filter(usable).slice(0, NATIONAL_MAX)) {
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
        place = stateCenter(itemState, STATE_NAME[itemState]);
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
      category: classify(n),
    });
  }

  cache.set(items);
  return c.json(envelope(items, 'Tagesschau'));
});
