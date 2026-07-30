import { Hono } from 'hono';
import type { WarningFeature, Severity, GeoJsonGeometry } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Amtliche DWD-Warnungen als Flächen für das Kartenlayer. Quelle ist der
 * DWD-GeoServer (WFS), serverseitig auf den Kartenausschnitt gefiltert —
 * bundesweit wären es ~23.000 Gemeinde-Polygone.
 */
export const warningsRoute = new Hono();

const WFS = 'https://maps.dwd.de/geoserver/dwd/ows';

interface WfsFeature {
  properties: Record<string, unknown>;
  geometry: GeoJsonGeometry | null;
}

const SEV: Record<string, Severity> = { minor: 'minor', moderate: 'moderate', severe: 'severe', extreme: 'extreme' };
function toSeverity(raw: unknown): Severity {
  return SEV[String(raw ?? '').toLowerCase()] ?? 'moderate';
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

warningsRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);

  const key = `warnings:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
  const cache = cached<WarningFeature[]>(key, 120);
  if (cache.hit) return c.json(envelope(cache.hit, 'DWD (GeoServer)', true));

  // WFS 2.0: bbox in EPSG:4326 → Achsenreihenfolge lat,lon
  const url =
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=dwd:Warnungen_Gemeinden&outputFormat=application/json` +
    `&srsName=urn:ogc:def:crs:EPSG::4326&count=4000` +
    `&bbox=${bbox.south},${bbox.west},${bbox.north},${bbox.east},urn:ogc:def:crs:EPSG::4326`;
  const data = await fetchJson<{ features?: WfsFeature[] }>(url, { timeoutMs: 12000 });

  const features: WarningFeature[] = (data.features ?? [])
    .filter((f): f is WfsFeature & { geometry: GeoJsonGeometry } => f.geometry != null)
    .map((f) => {
      const p = f.properties;
      return {
        id: str(p.IDENTIFIER) ?? '',
        event: str(p.EVENT) ?? 'Warnung',
        headline: str(p.HEADLINE) ?? str(p.EVENT) ?? 'Amtliche Warnung',
        description: str(p.DESCRIPTION),
        instruction: str(p.INSTRUCTION),
        severity: toSeverity(p.SEVERITY),
        regionName: str(p.NAME),
        onset: str(p.ONSET) ?? null,
        expires: str(p.EXPIRES) ?? null,
        geometry: f.geometry,
      };
    });

  cache.set(features);
  return c.json(envelope(features, 'DWD (GeoServer)'));
});
