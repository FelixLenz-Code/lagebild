import { Hono } from 'hono';
import { config } from '../config.js';

/**
 * Proxy für TomTom-Verkehrsfluss-Kacheln (grün = frei … rot = stockend/gesperrt).
 * Der API-Key bleibt serverseitig und taucht nie im Browser auf. Kurze
 * Cache-Freigabe, damit der Browser Kacheln wiederverwendet.
 * https://developer.tomtom.com/traffic-api/documentation/traffic-flow/flow-tiles
 */
export const flowRoute = new Hono();

flowRoute.get('/:z/:x/:y', async (c) => {
  if (!config.tomtomKey) return c.body(null, 404);

  const z = c.req.param('z');
  const x = c.req.param('x');
  const y = c.req.param('y').replace(/\.png$/, '');
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return c.body(null, 400);

  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.png?key=${config.tomtomKey}`;
  const res = await fetch(url);
  if (!res.ok) return c.body(null, 502);

  const buf = await res.arrayBuffer();
  return c.body(buf, 200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=60',
  });
});
