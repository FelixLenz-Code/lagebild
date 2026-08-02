import { Hono } from 'hono';
import type { AuroraGrid, EarthquakeItem, FireDangerGrid } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson, fetchText } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';

/**
 * Weitere Gefahrenlagen für die Karte:
 *
 *   GET /api/hazards/quakes   Erdbeben der letzten Tage (USGS, gemeinfrei)
 *   GET /api/hazards/aurora   Polarlicht-Wahrscheinlichkeit (NOAA OVATION)
 *   GET /api/hazards/fire     Waldbrandgefahr in Deutschland (DWD)
 */
export const hazardsRoute = new Hono();

/* ------------------------------------------------------------------ */
/* Erdbeben (USGS)                                                     */
/* ------------------------------------------------------------------ */

const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

interface UsgsFeature {
  id?: string;
  properties?: { mag?: number; place?: string; time?: number; url?: string; tsunami?: number };
  geometry?: { coordinates?: [number, number, number] };
}

hazardsRoute.get('/quakes', async (c) => {
  // „week" statt „day": ein leeres Kartenbild wäre wenig aussagekräftig.
  const period = c.req.query('period') === 'day' ? 'all_day' : 'all_week';
  const minMag = Math.max(0, Math.min(Number(c.req.query('minMag') ?? 2.5) || 2.5, 8));

  const key = `quakes:${period}:${minMag}`;
  const cache = cached<EarthquakeItem[]>(key, 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'USGS', true));

  try {
    const body = await fetchJson<{ features?: UsgsFeature[] }>(`${USGS}/${period}.geojson`, {
      timeoutMs: 12000,
    });
    const data: EarthquakeItem[] = (body.features ?? [])
      .filter((f) => (f.properties?.mag ?? -9) >= minMag && f.geometry?.coordinates)
      .map((f) => ({
        id: f.id ?? '',
        magnitude: f.properties!.mag as number,
        place: f.properties?.place ?? '',
        time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
        depthKm: Math.round((f.geometry!.coordinates![2] ?? 0) * 10) / 10,
        lat: f.geometry!.coordinates![1],
        lon: f.geometry!.coordinates![0],
        url: f.properties?.url ?? '',
        tsunami: Boolean(f.properties?.tsunami),
      }))
      .sort((a, b) => b.magnitude - a.magnitude)
      .slice(0, 500);
    cache.set(data);
    return c.json(envelope(data, 'USGS'));
  } catch {
    return c.json(envelope([] as EarthquakeItem[], 'USGS'));
  }
});

/* ------------------------------------------------------------------ */
/* Polarlicht (NOAA OVATION)                                           */
/* ------------------------------------------------------------------ */

hazardsRoute.get('/aurora', async (c) => {
  const cache = cached<AuroraGrid>('aurora', 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'NOAA SWPC', true));

  try {
    const raw = await fetchJson<{
      'Observation Time'?: string;
      'Forecast Time'?: string;
      coordinates?: [number, number, number][];
    }>('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', { timeoutMs: 15000 });

    // Das Gitter kommt als 360×181 Tripel [Länge 0…359, Breite -90…90, Prozent].
    const cols = 360;
    const rows = 181;
    const values = new Array<number>(cols * rows).fill(0);
    let max = 0;
    for (const [lon, lat, value] of raw.coordinates ?? []) {
      const col = ((lon % 360) + 360) % 360;
      const row = 90 - lat; // Zeile 0 = Nordpol
      if (row < 0 || row >= rows) continue;
      values[row * cols + col] = value;
      if (value > max) max = value;
    }
    const data: AuroraGrid = {
      observedAt: raw['Observation Time'] ?? null,
      forecastAt: raw['Forecast Time'] ?? null,
      cols,
      rows,
      values,
      maxPercent: max,
    };
    cache.set(data);
    return c.json(envelope(data, 'NOAA SWPC'));
  } catch {
    return c.json(
      envelope({ observedAt: null, forecastAt: null, cols: 0, rows: 0, values: [], maxPercent: 0 }, 'NOAA SWPC'),
    );
  }
});

/* ------------------------------------------------------------------ */
/* Waldbrandgefahr (DWD)                                               */
/* ------------------------------------------------------------------ */

const DWD_FIRE =
  'https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/forecast/recent';
const STATION_LIST = `${DWD_FIRE}/derived_germany_fire_danger_index_woodland_forecast_recent_v2-3--0_stations_list.txt`;
/** Ein Vertreter je Gitterzelle reicht — sonst wären es 484 Abrufe. */
const STATION_CELL_DEG = 0.6;

interface Station {
  id: string;
  lat: number;
  lon: number;
  name: string;
}

/** Stationsliste (fest, ändert sich selten) — eine Woche vorhalten. */
async function stations(): Promise<Station[]> {
  const cache = cached<Station[]>('fire:stations', 7 * 24 * 3600);
  if (cache.hit) return cache.hit;
  const text = await fetchText(STATION_LIST, { timeoutMs: 15000 });
  const list: Station[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split(';');
    if (cols.length < 5) continue;
    const id = cols[0]!.trim();
    const lat = Number(cols[2]);
    const lon = Number(cols[3]);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    list.push({ id, lat, lon, name: cols[4]!.trim() });
  }
  // Räumlich ausdünnen: je Zelle die erste Station.
  const seen = new Set<string>();
  const thinned = list.filter((s) => {
    const cell = `${Math.round(s.lat / STATION_CELL_DEG)},${Math.round(s.lon / STATION_CELL_DEG)}`;
    if (seen.has(cell)) return false;
    seen.add(cell);
    return true;
  });
  return cache.set(thinned);
}

/** Heutiger Waldbrandgefahrenindex einer Station (Stufe 1–5). */
async function stationValue(s: Station): Promise<number | null> {
  const url = `${DWD_FIRE}/derived_germany_fire_danger_index_woodland_forecast_recent_${s.id}_v2-3--0.csv.gz`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'lagebild/0.1 (+https://github.com/FelixLenz-Code/lagebild)' },
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const lines = text.trim().split('\n');
    const last = lines[lines.length - 1]?.split(';');
    // Spalte 2 ist wbi_0 = heutiger Wert.
    const value = Number(last?.[2]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

hazardsRoute.get('/fire', async (c) => {
  const cache = cached<FireDangerGrid>('fire:grid', 6 * 3600);
  if (cache.hit) return c.json(envelope(cache.hit, 'DWD', true));

  try {
    const list = await stations();
    const measured: { lat: number; lon: number; value: number; name: string }[] = [];
    await mapPool(list, 8, async (s) => {
      const value = await stationValue(s);
      if (value != null) measured.push({ lat: s.lat, lon: s.lon, value, name: s.name });
    });
    if (!measured.length) throw new Error('keine Stationswerte');

    // Fläche über Deutschland: inverse Distanzgewichtung der Stationswerte.
    const west = 5.8;
    const south = 47.2;
    const cell = 0.2;
    const cols = Math.round((15.1 - west) / cell) + 1;
    const rows = Math.round((55.1 - south) / cell) + 1;
    const values: number[] = [];
    for (let r = 0; r < rows; r++) {
      const lat = 55.1 - r * cell;
      for (let col = 0; col < cols; col++) {
        const lon = west + col * cell;
        let sum = 0;
        let weight = 0;
        for (const m of measured) {
          const dy = (m.lat - lat) * 111;
          const dx = (m.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180);
          const km = Math.sqrt(dx * dx + dy * dy);
          if (km > 150) continue;
          const w = 1 / (1 + (km / 35) ** 2);
          sum += m.value * w;
          weight += w;
        }
        values.push(weight > 0 ? Math.round((sum / weight) * 10) / 10 : 0);
      }
    }

    const data: FireDangerGrid = {
      day: new Date().toISOString().slice(0, 10),
      stations: measured.length,
      west,
      north: 55.1,
      cellDeg: cell,
      cols,
      rows,
      values,
    };
    cache.set(data);
    return c.json(envelope(data, 'DWD'));
  } catch {
    return c.json(
      envelope(
        { day: '', stations: 0, west: 0, north: 0, cellDeg: 0, cols: 0, rows: 0, values: [] },
        'DWD',
      ),
    );
  }
});
