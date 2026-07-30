import { Hono } from 'hono';
import type { RadarData } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Regenradar-Frames von RainViewer (frei, ohne API-Key). Liefert die letzten
 * ~2 h Vergangenheit plus vorhandene Nowcast-Frames. Die eigentlichen
 * Kachelbilder holt das Frontend direkt vom RainViewer-Tilecache.
 * https://www.rainviewer.com/api.html
 */
export const radarRoute = new Hono();

interface RvFrame {
  time: number;
  path: string;
}
interface RvResponse {
  host: string;
  radar?: { past?: RvFrame[]; nowcast?: RvFrame[] };
}

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
