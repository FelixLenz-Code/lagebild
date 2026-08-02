import { Hono } from 'hono';
import type { PollenForecast, PollenKind, PollenLoad, StateCode } from '@lagebild/shared';
import { FEDERAL_STATE_BOUNDS } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Pollenflug-Gefahrenindex des DWD.
 *
 * Der DWD veröffentlicht ihn einmal täglich (gegen 11 Uhr) für **Regionen**,
 * nicht für Koordinaten — und die Regionen kommen ohne Geometrie. Deshalb wird
 * hier über das Bundesland zugeordnet; hat eine Region mehrere Teilregionen,
 * gewinnt der **höhere** Wert. Das ist die vorsichtige Richtung: lieber eine
 * Warnung zu viel als eine zu wenig. Welche Region gemeint ist, steht in der
 * Antwort und wird in der App genannt.
 */
export const pollenRoute = new Hono();

const URL_S31FG =
  process.env.DWD_POLLEN_URL ??
  'https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json';

/** Bundesland (AGS-Präfix) → DWD-Pollenregion. */
const REGION_BY_STATE: Record<string, number> = {
  '01': 10, // Schleswig-Holstein
  '02': 10, // Hamburg
  '03': 30, // Niedersachsen
  '04': 30, // Bremen
  '05': 40, // Nordrhein-Westfalen
  '06': 90, // Hessen
  '07': 100, // Rheinland-Pfalz
  '08': 110, // Baden-Württemberg
  '09': 120, // Bayern
  '10': 100, // Saarland
  '11': 50, // Berlin
  '12': 50, // Brandenburg
  '13': 20, // Mecklenburg-Vorpommern
  '14': 80, // Sachsen
  '15': 60, // Sachsen-Anhalt
  '16': 70, // Thüringen
};

/** Deutsche Namen der Pollenarten, in blühender Reihenfolge. */
const KINDS: { key: string; label: PollenKind }[] = [
  { key: 'Hasel', label: 'Hasel' },
  { key: 'Erle', label: 'Erle' },
  { key: 'Esche', label: 'Esche' },
  { key: 'Birke', label: 'Birke' },
  { key: 'Graeser', label: 'Gräser' },
  { key: 'Roggen', label: 'Roggen' },
  { key: 'Beifuss', label: 'Beifuß' },
  { key: 'Ambrosia', label: 'Ambrosia' },
];

/** Die Stufen kommen als Text („0", „0-1", „1", … „3"). */
const LEVELS: Record<string, { value: number; text: string }> = {
  '0': { value: 0, text: 'keine Belastung' },
  '0-1': { value: 0.5, text: 'keine bis geringe Belastung' },
  '1': { value: 1, text: 'geringe Belastung' },
  '1-2': { value: 1.5, text: 'geringe bis mittlere Belastung' },
  '2': { value: 2, text: 'mittlere Belastung' },
  '2-3': { value: 2.5, text: 'mittlere bis hohe Belastung' },
  '3': { value: 3, text: 'hohe Belastung' },
};

interface RawRegion {
  region_id?: number;
  region_name?: string;
  partregion_id?: number;
  partregion_name?: string;
  Pollen?: Record<string, { today?: string; tomorrow?: string; dayafter_to?: string }>;
}
interface RawFeed {
  last_update?: string;
  next_update?: string;
  content?: RawRegion[];
}

/**
 * Bundesland zum Punkt. Die Rechtecke überlappen stark — es gewinnt das
 * kleinste passende, weil ein Stadtstaat der nähere Bezug ist als das
 * umgebende Flächenland.
 */
function stateAt(point: { lat: number; lon: number }): StateCode | null {
  let best: StateCode | null = null;
  let bestArea = Infinity;
  for (const [code, b] of Object.entries(FEDERAL_STATE_BOUNDS) as [StateCode, number[]][]) {
    if (point.lon < b[0]! || point.lon > b[2]! || point.lat < b[1]! || point.lat > b[3]!) continue;
    const size = (b[2]! - b[0]!) * (b[3]! - b[1]!);
    if (size < bestArea) {
      bestArea = size;
      best = code;
    }
  }
  return best;
}

const load = (raw: string | undefined): PollenLoad => {
  const step = LEVELS[String(raw ?? '0').trim()] ?? LEVELS['0']!;
  return { value: step.value, text: step.text };
};

/** Von zwei Stufen die höhere behalten. */
const worse = (a: PollenLoad, b: PollenLoad): PollenLoad => (b.value > a.value ? b : a);

/**
 *   GET /api/pollen?lat=…&lon=…
 *
 * Belastung für heute, morgen und übermorgen in der Region des Standorts.
 */
pollenRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const state = stateAt(coords);
  const regionId = state ? REGION_BY_STATE[state] : undefined;
  if (!regionId) return c.json(envelope(null, 'DWD (Pollenflug-Gefahrenindex)'));

  // Einmal täglich neu — eine Stunde Cache ist reichlich sparsam.
  const cache = cached<RawFeed>('pollen:feed', 3600);
  let feed = cache.hit;
  if (!feed) {
    try {
      feed = cache.set(await fetchJson<RawFeed>(URL_S31FG, { timeoutMs: 12000 }));
    } catch {
      return c.json(envelope(null, 'DWD (Pollenflug-Gefahrenindex)'));
    }
  }

  const parts = (feed.content ?? []).filter((r) => r.region_id === regionId);
  if (!parts.length) return c.json(envelope(null, 'DWD (Pollenflug-Gefahrenindex)'));

  const kinds = KINDS.map(({ key, label }) => {
    let today = load('0');
    let tomorrow = load('0');
    let dayAfter = load('0');
    for (const part of parts) {
      const p = part.Pollen?.[key];
      today = worse(today, load(p?.today));
      tomorrow = worse(tomorrow, load(p?.tomorrow));
      dayAfter = worse(dayAfter, load(p?.dayafter_to));
    }
    return { kind: label, today, tomorrow, dayAfter };
  });

  const data: PollenForecast = {
    regionName: parts[0]!.region_name ?? '',
    // Bei mehreren Teilregionen steht der höchste Wert — das gehört dazugesagt.
    partRegions: parts.map((p) => p.partregion_name ?? '').filter(Boolean),
    updatedAt: feed.last_update ?? null,
    nextUpdate: feed.next_update ?? null,
    kinds,
  };
  return c.json(envelope(data, 'DWD (Pollenflug-Gefahrenindex)'));
});
