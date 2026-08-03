import { Hono } from 'hono';
import type { RadarData, RadarForecast } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { readCoords } from '../lib/geo.js';

/**
 * Regenradar-Frames von RainViewer (frei, ohne API-Key). Liefert die letzten
 * ~2 h Vergangenheit plus vorhandene Nowcast-Frames. Die eigentlichen
 * Kachelbilder holt das Frontend direkt vom RainViewer-Tilecache.
 * https://www.rainviewer.com/api.html
 */
export const radarRoute = new Hono();

const BRIGHT_SKY = 'https://api.brightsky.dev';

interface RvFrame {
  time: number;
  path: string;
}
interface RvResponse {
  host: string;
  radar?: { past?: RvFrame[]; nowcast?: RvFrame[] };
}

/**
 * Radar-Vorhersage des DWD (RADOLAN-RV) über Bright Sky: 5-Minuten-Schritte von
 * ~30 min Vergangenheit bis 2 h voraus. Bright Sky liefert das Gitter
 * zlib-komprimiert und base64-kodiert — genau so reichen wir es weiter, das
 * Frontend packt es aus und malt daraus die Kartenüberlagerung.
 * Nur Deutschland: außerhalb des Radarverbunds kommt eine leere Frame-Liste.
 * https://brightsky.dev/docs/#/operations/getRadar
 */
interface BsRadarResponse {
  radar?: { timestamp: string; precipitation_5: string }[];
  /** Ausschnitt im RADOLAN-Gitter: [oben, links, unten, rechts]. */
  bbox?: [number, number, number, number];
  latlon_position?: { x: number; y: number };
  /** Ecken des Ausschnitts: NW, SW, SO, NO. */
  geometry?: { coordinates: [number, number][] };
}

const EMPTY_FORECAST: RadarForecast = { width: 0, height: 0, corners: [], frames: [] };

radarRoute.get('/forecast', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);
  const distance = Math.min(Math.max(Number(c.req.query('distance')) || 120000, 20000), 200000);

  const key = `radar-fc:${coords.lat.toFixed(2)}:${coords.lon.toFixed(2)}:${distance}`;
  const cache = cached<RadarForecast>(key, 180);
  if (cache.hit) return c.json(envelope(cache.hit, 'DWD (Bright Sky)', true));

  const from = new Date(Date.now() - 30 * 60_000).toISOString();
  const to = new Date(Date.now() + 2 * 3600_000).toISOString();
  const url =
    `${BRIGHT_SKY}/radar?lat=${coords.lat}&lon=${coords.lon}&distance=${distance}` +
    `&format=compressed&date=${encodeURIComponent(from)}&last_date=${encodeURIComponent(to)}`;

  let body: BsRadarResponse;
  try {
    body = await fetchJson<BsRadarResponse>(url, { timeoutMs: 12000 });
  } catch {
    // Außerhalb Deutschlands (oder Dienst gestört) — Frontend fällt auf RainViewer zurück.
    return c.json(envelope(EMPTY_FORECAST, 'DWD (Bright Sky)'));
  }

  const bbox = body.bbox;
  const corners = body.geometry?.coordinates;
  if (!bbox || !corners || corners.length < 4 || !body.radar?.length) {
    return c.json(envelope(EMPTY_FORECAST, 'DWD (Bright Sky)'));
  }

  const now = Date.now();
  const [nw, sw, se, ne] = corners as [number, number][];
  const data: RadarForecast = {
    height: bbox[2] - bbox[0] + 1,
    width: bbox[3] - bbox[1] + 1,
    corners: [nw!, ne!, se!, sw!],
    // Bright Sky sagt selbst, wo der angefragte Punkt im Gitter liegt — das
    // ist verlässlicher, als die Mitte anzunehmen.
    ...(body.latlon_position ? { position: body.latlon_position } : {}),
    frames: body.radar.map((f) => ({
      time: f.timestamp,
      forecast: new Date(f.timestamp).getTime() > now,
      data: f.precipitation_5,
    })),
  };

  cache.set(data);
  return c.json(envelope(data, 'DWD (Bright Sky)'));
});

radarRoute.get('/', async (c) => {
  const cache = cached<RadarData>('radar', 120);
  if (cache.hit) return c.json(envelope(cache.hit, 'RainViewer', true));

  const d = await fetchJson<RvResponse>('https://api.rainviewer.com/public/weather-maps.json');
  const past = (d.radar?.past ?? []).map((f) => ({ time: f.time, path: f.path, forecast: false }));
  const nowcast = (d.radar?.nowcast ?? []).map((f) => ({ time: f.time, path: f.path, forecast: true }));
  const data: RadarData = { host: d.host, frames: [...past, ...nowcast] };

  cache.set(data);
  return c.json(envelope(data, 'RainViewer'));
});
