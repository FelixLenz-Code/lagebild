import { Hono } from 'hono';
import type { FireWaterPoint } from '@lagebild/shared';
import { readBbox, type Bbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Löschwasser — Hydranten, Saugstellen, Löschwasserbehälter und -teiche.
 *
 * Quelle ist **OpenStreetMap** über Overpass; die Feuerwehren pflegen ihre
 * Entnahmestellen dort in vielen Gemeinden mit. Es ist ausdrücklich **keine
 * amtliche Löschwasserkarte**: Wo nichts eingetragen ist, kann trotzdem ein
 * Hydrant stehen, und ein eingetragener kann trocken sein. Das sagt die
 * Oberfläche auch so.
 *
 * **Anders als bei den Rettungspunkten muss der Ausschnitt klein bleiben.**
 * Rettungspunkte gibt es bundesweit rund 47.000, Hydranten mehrere Hunderttausend
 * — deshalb ein engerer Rahmen (0,12°), eine Obergrenze je Antwort und eine
 * Ebene, die erst ab Zoom 13 zeichnet.
 */
export const waterRoute = new Hono();

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
/** Rastergröße für den Cache-Schlüssel (Grad). */
const GRID = 0.02;
/** Größere Ausschnitte sind bei dieser Dichte nicht sinnvoll. */
const MAX_SPAN = 0.12;
/** Mehr trägt die Karte ohnehin nicht. */
const MAX_POINTS = 3000;

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function snap(b: Bbox): Bbox {
  const down = (v: number) => Math.floor(v / GRID) * GRID;
  const up = (v: number) => Math.ceil(v / GRID) * GRID;
  return { west: down(b.west), south: down(b.south), east: up(b.east), north: up(b.north) };
}

/** Bauform des Hydranten in Klartext — das entscheidet über das Werkzeug. */
const BAUART: Record<string, string> = {
  pillar: 'Überflurhydrant',
  underground: 'Unterflurhydrant',
  wall: 'Wandhydrant',
  pipe: 'Rohr',
  pond: 'Löschteich',
};

function kindOf(tags: Record<string, string>): FireWaterPoint['kind'] | null {
  const e = tags.emergency;
  if (e === 'fire_hydrant') return 'hydrant';
  if (e === 'suction_point') return 'suction';
  if (e === 'water_tank' || e === 'fire_water_pond') return 'tank';
  return null;
}

/**
 * Fördermenge, wie sie in OSM steht (`flow_rate`, z. B. „800 l/min" oder
 * „48 m3/h"). Wird nicht umgerechnet — die Angabe ist zu uneinheitlich, als
 * dass eine Umrechnung ehrlicher wäre als das Zitat.
 */
function flow(tags: Record<string, string>): string | null {
  return tags['fire_hydrant:flow_rate']?.trim() || tags.flow_rate?.trim() || null;
}

/**
 *   GET /api/water?bbox=west,süd,ost,nord
 */
waterRoute.get('/', async (c) => {
  const raw = readBbox(c);
  if (!raw) return c.json({ error: 'bbox erforderlich' }, 400);
  if (raw.east - raw.west > MAX_SPAN || raw.north - raw.south > MAX_SPAN) {
    return c.json(envelope([] as FireWaterPoint[], 'OpenStreetMap (Overpass)'));
  }

  const box = snap(raw);
  const key = `water:${box.west.toFixed(2)},${box.south.toFixed(2)},${box.east.toFixed(2)},${box.north.toFixed(2)}`;
  const cache = cached<FireWaterPoint[]>(key, 43_200);
  if (cache.hit) return c.json(envelope(cache.hit, 'OpenStreetMap (Overpass)', true));

  const area = `(${box.south},${box.west},${box.north},${box.east})`;
  // **Ausdrücklich ohne regulären Ausdruck über den Wert:** `["emergency"~"^(…)$"]`
  // umgeht den Schlüssel-Wert-Index und lief für einen Stadtausschnitt in den
  // Zeitausfall (504), während dieselbe Menge als Aufzählung in Sekunden kommt.
  // Behälter und Teiche sind oft Flächen — `out center` gibt dafür den
  // Schwerpunkt, damit alles als Punkt behandelt werden kann.
  const arten = ['fire_hydrant', 'suction_point', 'water_tank', 'fire_water_pond'];
  const query =
    `[out:json][timeout:30];(` +
    arten.map((a) => `node["emergency"="${a}"]${area};`).join('') +
    arten
      .slice(1)
      .map((a) => `way["emergency"="${a}"]${area};`)
      .join('') +
    `);out center body;`;

  try {
    const data = await fetchJson<{ elements?: OverpassElement[] }>(
      `${OVERPASS}?data=${encodeURIComponent(query)}`,
      { timeoutMs: 35_000 },
    );
    const points: FireWaterPoint[] = [];
    for (const el of data.elements ?? []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const tags = el.tags ?? {};
      const kind = kindOf(tags);
      if (kind == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const type = tags['fire_hydrant:type'] ?? '';
      points.push({
        id: `${el.type ?? 'node'}/${el.id ?? `${lat},${lon}`}`,
        kind,
        form: BAUART[type] ?? null,
        ref: tags.ref?.trim() || null,
        // Nennweite in Millimetern, wie am Schild.
        diameter: tags['fire_hydrant:diameter']?.trim() || tags.diameter?.trim() || null,
        couplings: tags.couplings?.trim() || tags['couplings:type']?.trim() || null,
        flowRate: flow(tags),
        operator: tags.operator?.trim() || null,
        lat: lat as number,
        lon: lon as number,
      });
      if (points.length >= MAX_POINTS) break;
    }
    cache.set(points);
    return c.json(envelope(points, 'OpenStreetMap (Overpass)'));
  } catch {
    return c.json(envelope([] as FireWaterPoint[], 'OpenStreetMap (Overpass)'));
  }
});
