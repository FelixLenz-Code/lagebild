import { Hono } from 'hono';
import type { RestFacility } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { mapPool } from '../lib/pool.js';

/**
 * Rast- und Ladeinfrastruktur an den Autobahnen.
 *
 * Dieselbe offene Schnittstelle wie die Verkehrsmeldungen (Autobahn GmbH über
 * bund.dev), nur andere Endpunkte je Autobahn:
 *
 *   …/services/parking_lorry               Rastanlagen mit Stellplätzen
 *   …/services/electric_charging_station   Ladepunkte (auch das Deutschlandnetz)
 *
 * Beides ändert sich in Wochen, nicht in Minuten — deshalb ein langer Cache
 * und der Aufbau in **einem** Durchlauf über alle Autobahnen (rund 120
 * Abfragen je Endpunkt beim Cache-Miss).
 */
export const restRoute = new Hono();

const BASE = 'https://verkehr.autobahn.de/o/autobahn';

interface RawFacility {
  identifier?: string;
  title?: string;
  subtitle?: string;
  description?: string[];
  coordinate?: { lat?: string; long?: string };
  display_type?: string;
  lorryParkingFeatureIcons?: { icon?: string; description?: string }[];
}

async function loadRoads(): Promise<string[]> {
  const cache = cached<string[]>('autobahn:roads', 86_400);
  if (cache.hit) return cache.hit;
  const body = await fetchJson<{ roads?: string[] }>(`${BASE}/`, { timeoutMs: 9000 });
  return cache.set((body.roads ?? []).map((r) => r.trim()).filter(Boolean));
}

/** „PKW Stellplätze: 12" → 12. */
function spaces(description: string[] | undefined, label: string): number | null {
  for (const line of description ?? []) {
    const m = line.match(new RegExp(`${label}\\s*Stellpl[äa]tze:\\s*(\\d+)`, 'i'));
    if (m) return Number(m[1]);
  }
  return null;
}

/** Ladeleistung und Kupplung stehen als freie Zeilen in der Beschreibung. */
function chargingDetail(description: string[] | undefined): {
  points: number | null;
  power: string | null;
  operator: string | null;
} {
  let points: number | null = null;
  let power: string | null = null;
  let operator: string | null = null;
  for (const raw of description ?? []) {
    const line = raw.trim();
    const p = line.match(/^(\d+)\s*Ladepunkte?/i);
    if (p) points = Number(p[1]);
    const kw = line.match(/^(\d+\+?\s*kW)/i);
    if (kw) power = kw[1]!.replace(/\s+/g, ' ');
    const op = line.match(/^Ladesäulenbetreiber:\s*(.+)$/i);
    if (op) operator = op[1]!.trim();
  }
  return { points, power, operator };
}

function toFacility(road: string, kind: RestFacility['kind'], raw: RawFacility): RestFacility | null {
  const lat = Number(raw.coordinate?.lat);
  const lon = Number(raw.coordinate?.long);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const charging = kind === 'charging' ? chargingDetail(raw.description) : null;

  /*
   * Die beiden Endpunkte benennen ihre Anlagen unterschiedlich:
   * Rastanlagen führen den Namen im **Untertitel** („NI 40 W bei km 197,8"),
   * während der Titel nur die Autobahn samt ihrer beiden Enden nennt
   * („A1 | Puttgarden") — der wäre als Überschrift irreführend. Ladepunkte
   * dagegen hängen den Namen hinten an den Titel („… | Buddikate Ost") und
   * schreiben die Art in den Untertitel.
   */
  const segments = (raw.title ?? '').split('|').map((p) => p.trim()).filter(Boolean);
  const name =
    kind === 'charging'
      ? (segments.length > 2 ? segments[segments.length - 1]! : raw.subtitle?.trim()) || road
      : raw.subtitle?.trim() || segments[segments.length - 1] || road;

  return {
    id: raw.identifier ?? `${road}-${lat}-${lon}`,
    road,
    kind,
    title: name,
    subtitle: kind === 'charging' ? raw.subtitle?.trim() || null : null,
    lat,
    lon,
    carSpaces: kind === 'parking' ? spaces(raw.description, 'PKW') : null,
    lorrySpaces: kind === 'parking' ? spaces(raw.description, 'LKW') : null,
    chargePoints: charging?.points ?? null,
    chargePower: charging?.power ?? null,
    operator: charging?.operator ?? null,
    // Die Ausstattung steht als Liste von Symbolen bzw. Textzeilen dabei.
    features: (raw.lorryParkingFeatureIcons ?? [])
      .map((f) => f.description?.trim())
      .filter((v): v is string => Boolean(v)),
  };
}

const ENDPOINTS: { path: string; kind: RestFacility['kind'] }[] = [
  { path: 'parking_lorry', kind: 'parking' },
  { path: 'electric_charging_station', kind: 'charging' },
];

async function loadAll(): Promise<RestFacility[]> {
  const cache = cached<RestFacility[]>('autobahn:rest', 21_600);
  if (cache.hit) return cache.hit;

  const roads = await loadRoads();
  const out: RestFacility[] = [];
  for (const { path, kind } of ENDPOINTS) {
    const perRoad = await mapPool(roads, 8, async (road) => {
      try {
        const body = await fetchJson<Record<string, RawFacility[]>>(
          `${BASE}/${encodeURIComponent(road)}/services/${path}`,
          { timeoutMs: 8000 },
        );
        return (body[path] ?? [])
          .map((raw) => toFacility(road, kind, raw))
          .filter((x): x is RestFacility => x !== null);
      } catch {
        return [];
      }
    });
    out.push(...perRoad.flat());
  }
  // Dieselbe Anlage taucht an beiden Fahrtrichtungen bzw. mehrfach auf.
  const seen = new Set<string>();
  const unique = out.filter((f) => {
    const key = `${f.kind}:${f.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return cache.set(unique);
}

/**
 *   GET /api/rest?bbox=west,süd,ost,nord
 *
 * Rastanlagen und Ladepunkte im Ausschnitt.
 */
restRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  const all = await loadAll();
  const data = bbox
    ? all
        .filter(
          (f) => f.lon >= bbox.west && f.lon <= bbox.east && f.lat >= bbox.south && f.lat <= bbox.north,
        )
        .slice(0, 800)
    : all.slice(0, 800);
  return c.json(envelope(data, 'Autobahn GmbH (bund.dev)'));
});
