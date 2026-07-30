import { Hono } from 'hono';
import type { Warning, Severity } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Amtliche DWD-Unwetterwarnungen über Bright Sky (standortgenau, ohne API-Key).
 * https://brightsky.dev/docs/#/operations/getAlerts
 */
export const alertsRoute = new Hono();

interface BrightSkyAlert {
  id?: number;
  alert_id?: string;
  event_de?: string;
  event_en?: string;
  headline_de?: string;
  description_de?: string;
  instruction_de?: string;
  severity?: string;
  onset?: string;
  expires?: string;
}

const SEVERITIES: Severity[] = ['minor', 'moderate', 'severe', 'extreme'];
function toSeverity(raw: string | undefined): Severity {
  const s = (raw ?? '').toLowerCase();
  return (SEVERITIES as string[]).includes(s) ? (s as Severity) : 'moderate';
}

alertsRoute.get('/', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat und lon erforderlich' }, 400);

  const key = `alerts:${coords.lat.toFixed(3)}:${coords.lon.toFixed(3)}`;
  const cache = cached<Warning[]>(key);
  if (cache.hit) return c.json(envelope(cache.hit, 'DWD via Bright Sky', true));

  const url = `https://api.brightsky.dev/alerts?lat=${coords.lat}&lon=${coords.lon}`;
  const body = await fetchJson<{ alerts?: BrightSkyAlert[] }>(url);

  const warnings: Warning[] = (body.alerts ?? []).map((a) => ({
    id: String(a.id ?? a.alert_id ?? crypto.randomUUID()),
    provider: 'dwd',
    event: a.event_de ?? a.event_en ?? 'Warnung',
    headline: a.headline_de ?? a.event_de ?? 'Amtliche Warnung',
    description: [a.description_de, a.instruction_de].filter(Boolean).join('\n\n') || undefined,
    severity: toSeverity(a.severity),
    onset: a.onset ?? null,
    expires: a.expires ?? null,
    area: null,
  }));

  cache.set(warnings);
  return c.json(envelope(warnings, 'DWD via Bright Sky'));
});
