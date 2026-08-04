import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AvalancheDanger, AvalancheRegion, AvalancheReport } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { envelope } from '../lib/envelope.js';
import { fetchJson } from '../lib/http.js';
import { mapPool } from '../lib/pool.js';

/**
 * Lawinenlagebericht des Europäischen Lawinenwarndienst-Verbunds (EAWS).
 *
 * Die Warndienste veröffentlichen ihre Berichte als offene JSON-Dateien im
 * CAAML-Format unter `static.avalanche.report`, ein Verzeichnis je Tag. Es gibt
 * sie nur in der Saison (etwa Dezember bis April) — außerhalb liefert diese
 * Route eine leere Liste mit dem Vermerk `offSeason`, statt einen Fehler.
 *
 * **Zweigeteilt:** Die Regionsflächen ändern sich höchstens einmal im Jahr und
 * liegen als eigene Route bereit (gut zwischenspeicherbar); die Lage selbst ist
 * klein und wird oft neu geholt. Sonst müsste die App für eine neue
 * Gefahrenstufe jedes Mal ein Megabyte Geometrie mitladen.
 */
export const avalancheRoute = new Hono();

const BASE = process.env.EAWS_BASE ?? 'https://static.avalanche.report/eaws_bulletins';

/** Herausgeber im Alpenraum samt Deutschland. */
const PUBLISHERS = [
  'DE-BY', 'AT-02', 'AT-03', 'AT-04', 'AT-05', 'AT-06', 'AT-07', 'AT-08',
  'CH', 'IT-32-BZ', 'IT-32-TN', 'IT-21', 'IT-23', 'IT-25', 'IT-34', 'IT-36',
  'FR', 'SI',
];

const PROBLEM_DE: Record<string, string> = {
  new_snow: 'Neuschnee',
  wind_slab: 'Triebschnee',
  persistent_weak_layers: 'Altschnee',
  wet_snow: 'Nassschnee',
  gliding_snow: 'Gleitschnee',
  favourable_situation: 'günstige Lage',
  cornices: 'Wechten',
  no_distinct_avalanche_problem: 'kein ausgeprägtes Problem',
};

const LEVEL: Record<string, AvalancheDanger> = {
  low: 1,
  moderate: 2,
  considerable: 3,
  high: 4,
  very_high: 5,
};

/** Höhengrenze im Klartext — „Waldgrenze" oder eine Zahl in Metern. */
function boundaryText(elevation: { lowerBound?: string; upperBound?: string } | undefined): string | undefined {
  const value = elevation?.lowerBound ?? elevation?.upperBound;
  if (!value) return undefined;
  if (value === 'treeline') return 'Waldgrenze';
  return /^\d+$/.test(value) ? `${value} m` : value;
}

interface CaamlBulletin {
  regions?: { regionID?: string }[];
  validTime?: { endTime?: string };
  dangerRatings?: {
    mainValue?: string;
    elevation?: { lowerBound?: string; upperBound?: string };
  }[];
  avalancheProblems?: { problemType?: string }[];
  highlights?: string;
  avalancheActivity?: { highlights?: string; comment?: string };
  source?: { provider?: { name?: string } };
}

/** Einen Herausgeber-Bericht auf die Regionen verteilen. */
function spread(day: string, publisher: string, body: { bulletins?: CaamlBulletin[] }): AvalancheRegion[] {
  const out: AvalancheRegion[] = [];
  for (const b of body.bulletins ?? []) {
    const ratings = b.dangerRatings ?? [];
    const levels = ratings.map((r) => LEVEL[r.mainValue ?? ''] ?? 0).filter((v) => v > 0);
    if (!levels.length) continue;

    // Zwei Stufen bedeuten „unterhalb/oberhalb einer Höhengrenze".
    const above = ratings.find((r) => r.elevation?.lowerBound);
    const below = ratings.find((r) => r.elevation?.upperBound);
    const region: Omit<AvalancheRegion, 'id'> = {
      danger: Math.max(...levels) as AvalancheDanger,
      ...(above?.mainValue ? { dangerAbove: LEVEL[above.mainValue] } : {}),
      ...(below?.mainValue ? { dangerBelow: LEVEL[below.mainValue] } : {}),
      ...(boundaryText(above?.elevation ?? below?.elevation)
        ? { boundary: boundaryText(above?.elevation ?? below?.elevation)! }
        : {}),
      problems: [
        ...new Set((b.avalancheProblems ?? []).map((p) => PROBLEM_DE[p.problemType ?? ''] ?? p.problemType ?? '')),
      ].filter(Boolean),
      ...(b.highlights || b.avalancheActivity?.highlights || b.avalancheActivity?.comment
        ? {
            text: (b.highlights || b.avalancheActivity?.highlights || b.avalancheActivity?.comment)!
              .replace(/<[^>]*>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 400),
          }
        : {}),
      source: b.source?.provider?.name ?? publisher,
      validUntil: b.validTime?.endTime ?? null,
    };
    for (const r of b.regions ?? []) {
      if (r.regionID) out.push({ id: r.regionID, ...region });
    }
  }
  void day;
  return out;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

avalancheRoute.get('/', async (c) => {
  // Halbe Stunde: Die Warndienste veröffentlichen morgens und am späten
  // Nachmittag, öfter nachzufragen bringt nichts und belastet nur den Dienst.
  const cache = cached<AvalancheReport>('avalanche', 1800);
  if (cache.hit) return c.json(envelope(cache.hit, 'EAWS', true));

  // Der Bericht von heute erscheint am Vorabend; ist er noch nicht da, gilt
  // der von gestern weiter.
  // Für Prüfläufe außerhalb der Saison lässt sich ein Tag erzwingen.
  const days = process.env.EAWS_DAY
    ? [process.env.EAWS_DAY]
    : [isoDay(new Date()), isoDay(new Date(Date.now() - 86_400_000))];
  for (const day of days) {
    const results = await mapPool(PUBLISHERS, 8, async (p) => {
      try {
        return spread(day, p, await fetchJson(`${BASE}/${day}/${day}-${p}.json`, { timeoutMs: 12000 }));
      } catch {
        return [] as AvalancheRegion[];
      }
    });
    const regions = results.flat();
    if (regions.length) {
      const data: AvalancheReport = { day, regions, offSeason: false };
      cache.set(data);
      return c.json(envelope(data, 'EAWS'));
    }
  }

  const data: AvalancheReport = { day: days[0]!, regions: [], offSeason: true };
  cache.set(data);
  return c.json(envelope(data, 'EAWS'));
});

/* --- Regionsflächen: groß, aber praktisch unveränderlich --- */

const here = dirname(fileURLToPath(import.meta.url));
let regionsText: string | null = null;

avalancheRoute.get('/regions', (c) => {
  if (regionsText == null) {
    try {
      // Im Bundle liegt die Datei neben der Server-Datei, im Quellbetrieb in src/data.
      for (const path of [join(here, 'eaws-regions.json'), join(here, '..', 'data', 'eaws-regions.json')]) {
        try {
          regionsText = readFileSync(path, 'utf8');
          break;
        } catch {
          /* nächster Pfad */
        }
      }
    } catch {
      regionsText = null;
    }
  }
  if (!regionsText) return c.json({ error: 'Regionsflächen fehlen' }, 503);
  // Ein Jahr: Die Grenzen ändern sich höchstens zur neuen Saison, und dann
  // kommt ohnehin eine neue Fassung der App.
  c.header('cache-control', 'public, max-age=31536000, immutable');
  c.header('content-type', 'application/json; charset=utf-8');
  return c.body(regionsText);
});
