import { Hono } from 'hono';
import type { RescuePoint } from '@lagebild/shared';
import { readBbox, type Bbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Rettungspunkte — die nummerierten Schilder im Wald, an Wegen und in
 * Naherholungsgebieten, deren Kennung man dem Rettungsdienst durchgibt, wenn
 * man den eigenen Standort nicht benennen kann.
 *
 * Quelle ist **OpenStreetMap** (`highway=emergency_access_point`) über die
 * Overpass-API: rund 47.000 Punkte in Deutschland, jeweils mit der Kennung im
 * `ref`-Feld — genau der Nummer auf dem Schild. Die forstlichen
 * GPX-Sammlungen der Länder sind dieselben Punkte, nur ohne einheitliche
 * Schnittstelle und je Bundesland verschieden lizenziert; OSM steht unter der
 * ODbL und ist im Projekt ohnehin die Kartengrundlage.
 *
 * **Rücksicht auf Overpass (öffentlicher, gespendeter Dienst):** Abgefragt wird
 * nur der Kartenausschnitt, auf ein grobes Raster **aufgerundet** (damit
 * benachbarte Ausschnitte denselben Cache treffen), höchstens 1,5° groß, und
 * das Ergebnis bleibt zwölf Stunden liegen — die Punkte ändern sich in Jahren.
 */
export const rescueRoute = new Hono();

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
/** Rastergröße für den Cache-Schlüssel (Grad). */
const GRID = 0.25;
/** Größere Ausschnitte sind nicht sinnvoll — die Punkte stehen dicht. */
const MAX_SPAN = 1.5;

interface OverpassNode {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

/** Ausschnitt auf das Raster aufrunden. */
function snap(b: Bbox): Bbox {
  const down = (v: number) => Math.floor(v / GRID) * GRID;
  const up = (v: number) => Math.ceil(v / GRID) * GRID;
  return { west: down(b.west), south: down(b.south), east: up(b.east), north: up(b.north) };
}

/**
 *   GET /api/rescue?bbox=west,süd,ost,nord
 *
 * Rettungspunkte im Ausschnitt, mit ihrer Kennung.
 */
rescueRoute.get('/', async (c) => {
  const raw = readBbox(c);
  if (!raw) return c.json({ error: 'bbox erforderlich' }, 400);
  if (raw.east - raw.west > MAX_SPAN || raw.north - raw.south > MAX_SPAN) {
    return c.json(envelope([] as RescuePoint[], 'OpenStreetMap (Overpass)'));
  }

  const box = snap(raw);
  const key = `rescue:${box.west},${box.south},${box.east},${box.north}`;
  const cache = cached<RescuePoint[]>(key, 43_200);
  if (cache.hit) return c.json(envelope(cache.hit, 'OpenStreetMap (Overpass)', true));

  const query =
    `[out:json][timeout:25];` +
    `node["highway"="emergency_access_point"](${box.south},${box.west},${box.north},${box.east});` +
    `out body;`;

  try {
    const data = await fetchJson<{ elements?: OverpassNode[] }>(
      `${OVERPASS}?data=${encodeURIComponent(query)}`,
      { timeoutMs: 30000 },
    );
    const points: RescuePoint[] = (data.elements ?? [])
      .filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
      .map((e) => ({
        id: String(e.id ?? `${e.lat},${e.lon}`),
        // Ohne Kennung ist der Punkt trotzdem nützlich (Treffpunkt), aber die
        // Nummer ist das Entscheidende — deshalb steht sie an erster Stelle.
        ref: e.tags?.ref?.trim() || null,
        name: e.tags?.name?.trim() || null,
        operator: e.tags?.operator?.trim() || null,
        phone: e.tags?.emergency_telephone_code?.trim() || null,
        lat: e.lat!,
        lon: e.lon!,
      }));
    cache.set(points);
    return c.json(envelope(points, 'OpenStreetMap (Overpass)'));
  } catch {
    return c.json(envelope([] as RescuePoint[], 'OpenStreetMap (Overpass)'));
  }
});
