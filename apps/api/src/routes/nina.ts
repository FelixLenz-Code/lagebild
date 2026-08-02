import { Hono } from 'hono';
import type { CivilWarning, GeoJsonGeometry, Severity } from '@lagebild/shared';
import { readBbox, type Bbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';

/**
 * Behördenwarnungen aus dem Warnsystem des Bundes (BBK/NINA).
 *
 * Der DWD-Kanal steckt schon in der Ebene „Warnungen"; hier geht es um alles
 * andere, was über dieselbe Infrastruktur läuft:
 *
 * - **MoWaS** — Warnungen von Behörden (Gefahrstoffe, Trinkwasser, Bombenfund,
 *   Evakuierung, Zivilschutz)
 * - **KATWARN** und **BIWAPP** — kommunale Warnsysteme
 * - **Polizei** — polizeiliche Gefahrenmeldungen
 * - **LHP** — Länderübergreifendes Hochwasserportal
 *
 * Frei und ohne Schlüssel unter warnung.bund.de. Zwei Stufen: die Übersicht
 * (`<kanal>/mapData.json`) nennt nur Kennung, Titel und Stufe, Text und Fläche
 * kommen je Warnung aus `warnings/<id>.json` bzw. `.geojson`. Deshalb wird
 * beides gecacht — die Übersicht kurz, die Einzelmeldung länger.
 */
export const ninaRoute = new Hono();

const BASE = process.env.NINA_BASE ?? 'https://warnung.bund.de/api31';

/** Kanäle samt Bezeichnung für die Anzeige. */
const CHANNELS: { key: string; label: string }[] = [
  { key: 'mowas', label: 'Behördenwarnung' },
  { key: 'katwarn', label: 'KATWARN' },
  { key: 'biwapp', label: 'BIWAPP' },
  { key: 'police', label: 'Polizei' },
  { key: 'lhp', label: 'Hochwasser' },
];

/** Mehr als das ist auf einer Karte ohnehin nicht lesbar. */
const MAX_WARNINGS = 80;

interface MapItem {
  id: string;
  version?: number;
  startDate?: string;
  expiresDate?: string;
  severity?: string;
  urgency?: string;
  type?: string;
  i18nTitle?: Record<string, string>;
}

interface CapArea {
  areaDesc?: string;
}
interface CapInfo {
  event?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  severity?: string;
  urgency?: string;
  category?: string[];
  web?: string;
  contact?: string;
  area?: CapArea[];
}
interface CapDetail {
  identifier?: string;
  sender?: string;
  sent?: string;
  msgType?: string;
  info?: CapInfo[];
}

const SEV: Record<string, Severity> = {
  minor: 'minor',
  moderate: 'moderate',
  severe: 'severe',
  extreme: 'extreme',
};
const toSeverity = (raw: unknown): Severity => SEV[String(raw ?? '').toLowerCase()] ?? 'moderate';

/** CAP-Texte enthalten HTML-Umbrüche und Entities — die Karte will Klartext. */
function plain(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length ? text : undefined;
}

/** Umschließendes Rechteck einer Geometrie — für den Ausschnitts-Filter. */
function geometryBbox(geometry: GeoJsonGeometry): Bbox | null {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      return;
    }
    for (const child of node) visit(child);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
  return west <= east && south <= north ? { west, south, east, north } : null;
}

const overlaps = (a: Bbox, b: Bbox): boolean =>
  a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Übersicht eines Kanals (kurz gecacht — Warnungen sollen schnell erscheinen). */
async function channelItems(channel: string): Promise<MapItem[]> {
  const cache = cached<MapItem[]>(`nina:map:${channel}`, 60);
  if (cache.hit) return cache.hit;
  try {
    const list = await fetchJson<MapItem[]>(`${BASE}/${channel}/mapData.json`, { timeoutMs: 9000 });
    return cache.set(Array.isArray(list) ? list : []);
  } catch {
    return cache.set([]);
  }
}

/** Text und Fläche einer einzelnen Warnung. */
async function warningDetail(
  item: MapItem,
  label: string,
): Promise<CivilWarning | null> {
  // Der Versionszähler steckt im Schlüssel: eine geänderte Warnung wird neu geholt.
  const cache = cached<CivilWarning | null>(`nina:warn:${item.id}:${item.version ?? 0}`, 900);
  if (cache.hit !== undefined) return cache.hit;

  try {
    const [detail, geo] = await Promise.all([
      fetchJson<CapDetail>(`${BASE}/warnings/${item.id}.json`, { timeoutMs: 9000 }),
      fetchJson<{ features?: { geometry?: GeoJsonGeometry }[] }>(
        `${BASE}/warnings/${item.id}.geojson`,
        { timeoutMs: 9000 },
      ),
    ]);
    const info = detail.info?.[0];
    const geometry = geo.features?.find((f) => f.geometry)?.geometry;
    if (!info || !geometry) return cache.set(null);

    const title =
      info.headline ?? item.i18nTitle?.de ?? info.event ?? 'Warnung der Behörden';
    return cache.set({
      id: item.id,
      channel: label,
      event: info.event ?? label,
      headline: title,
      description: plain(info.description),
      instruction: plain(info.instruction),
      severity: toSeverity(info.severity ?? item.severity),
      urgent: String(item.urgency ?? info.urgency ?? '').toLowerCase() === 'immediate',
      areaDesc: info.area?.map((a) => a.areaDesc).filter(Boolean).join(', ') || null,
      sender: detail.sender ?? null,
      web: info.web ?? null,
      onset: item.startDate ?? detail.sent ?? null,
      expires: item.expiresDate ?? null,
      geometry,
    });
  } catch {
    return cache.set(null);
  }
}

/**
 *   GET /api/nina?bbox=west,süd,ost,nord
 *
 * Behördenwarnungen, die den Ausschnitt berühren.
 */
ninaRoute.get('/', async (c) => {
  const bbox = readBbox(c);

  const lists = await Promise.all(
    CHANNELS.map(async (ch) => ({ label: ch.label, items: await channelItems(ch.key) })),
  );

  // Zurückgezogene Meldungen fliegen raus, doppelte Kennungen ebenso.
  const seen = new Set<string>();
  const pending: { item: MapItem; label: string }[] = [];
  for (const { label, items } of lists) {
    for (const item of items) {
      if (!item?.id || seen.has(item.id)) continue;
      if (item.type === 'Cancel') continue;
      seen.add(item.id);
      pending.push({ item, label });
    }
  }
  // Neueste zuerst, damit die Obergrenze die aktuellen Meldungen behält.
  pending.sort((a, b) => (b.item.startDate ?? '').localeCompare(a.item.startDate ?? ''));

  const details = await mapPool(pending.slice(0, MAX_WARNINGS), 6, (p) =>
    warningDetail(p.item, p.label),
  );

  const data = details.filter((w): w is CivilWarning => {
    if (!w) return false;
    if (!bbox) return true;
    const own = geometryBbox(w.geometry);
    return own ? overlaps(own, bbox) : false;
  });

  return c.json(envelope(data, 'BBK (NINA / warnung.bund.de)'));
});
