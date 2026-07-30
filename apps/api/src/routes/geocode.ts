import { Hono } from 'hono';
import type { GeoResult } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Ortssuche über Photon (Komoot, frei, ohne API-Key). Auf Deutschland
 * eingegrenzt.
 * https://photon.komoot.io/
 */
export const geocodeRoute = new Hono();

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function label(p: Record<string, unknown>): string {
  const name = str(p, 'name');
  const city = str(p, 'city');
  const postcode = str(p, 'postcode');
  const state = str(p, 'state');
  const place = postcode && city ? `${postcode} ${city}` : city;
  return [name, place && place !== name ? place : undefined, state].filter(Boolean).join(', ');
}

geocodeRoute.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json(envelope([] as GeoResult[], 'Photon'));

  const key = `geocode:${q.toLowerCase()}`;
  const cache = cached<GeoResult[]>(key, 3600);
  if (cache.hit) return c.json(envelope(cache.hit, 'Photon', true));

  const url =
    `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&lang=de&limit=6` +
    `&bbox=5.8,47.2,15.1,55.1`;
  const data = await fetchJson<{ features?: PhotonFeature[] }>(url);
  const results: GeoResult[] = (data.features ?? [])
    .filter((f) => Array.isArray(f.geometry?.coordinates))
    .map((f) => ({
      name: label(f.properties ?? {}),
      lat: f.geometry!.coordinates![1],
      lon: f.geometry!.coordinates![0],
    }))
    .filter((r) => r.name.length > 0);

  cache.set(results);
  return c.json(envelope(results, 'Photon'));
});
