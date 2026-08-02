import { Hono } from 'hono';
import type { RadiationHistory, RadiationPoint, RadiationStation } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Ortsdosisleistung (Gamma-Strahlung) aus dem Messnetz des Bundesamts für
 * Strahlenschutz.
 *
 * Rund 1700 Sonden melden stündlich; das BfS stellt sie als offenen WFS-Dienst
 * bereit (`imis.bfs.de`, keine Anmeldung). Für die Karte zählt vor allem die
 * Einordnung: Der natürliche Untergrund liegt in Deutschland etwa zwischen
 * 0,05 und 0,18 µSv/h und schwankt mit Geologie und Höhe — auffällig ist nicht
 * ein hoher Absolutwert, sondern ein Wert deutlich über dem, was diese Sonde
 * sonst zeigt. Deshalb liefert die Route neben dem Messwert auch den
 * **kosmischen und terrestrischen Anteil** mit, aus dem sich der erwartbare
 * Untergrund ergibt.
 */
export const radiationRoute = new Hono();

const WFS = process.env.BFS_WFS ?? 'https://www.imis.bfs.de/ogc/opendata/ows';
const LAYER = 'opendata:odlinfo_odl_1h_latest';
const TIMESERIES = 'opendata:odlinfo_timeseries_odl_1h';

interface WfsFeature {
  geometry?: { type?: string; coordinates?: [number, number] };
  properties?: {
    id?: string;
    name?: string;
    plz?: string;
    value?: number;
    value_cosmic?: number;
    value_terrestrial?: number;
    unit?: string;
    site_status?: number;
    end_measure?: string;
    validated?: number;
    height_above_sea?: number;
  };
}

/**
 *   GET /api/radiation[?bbox=west,süd,ost,nord]
 *
 * Messwerte der letzten Stunde. Ohne bbox kommt das ganze Netz.
 */
radiationRoute.get('/', async (c) => {
  const bbox = readBbox(c);

  // Die Sonden melden stündlich — 15 Minuten Cache reichen völlig und halten
  // die Last beim BfS klein.
  const cache = cached<RadiationStation[]>('radiation:all', 900);
  let all = cache.hit;

  if (!all) {
    const url =
      `${WFS}?service=WFS&version=2.0.0&request=GetFeature` +
      `&typeNames=${encodeURIComponent(LAYER)}&outputFormat=application/json&count=3000`;
    try {
      const data = await fetchJson<{ features?: WfsFeature[] }>(url, { timeoutMs: 20000 });
      all = (data.features ?? [])
        .map((f): RadiationStation | null => {
          const p = f.properties ?? {};
          const coords = f.geometry?.coordinates;
          if (!coords || typeof p.value !== 'number') return null;
          // Außer Betrieb genommene Sonden melden keinen brauchbaren Wert.
          if (p.site_status !== undefined && p.site_status !== 1) return null;
          const cosmic = typeof p.value_cosmic === 'number' ? p.value_cosmic : null;
          const terrestrial = typeof p.value_terrestrial === 'number' ? p.value_terrestrial : null;
          return {
            id: p.id ?? `${coords[0]},${coords[1]}`,
            name: p.name ?? '',
            lat: coords[1],
            lon: coords[0],
            microSievertPerHour: Math.round(p.value * 1000) / 1000,
            cosmic,
            terrestrial,
            measuredAt: p.end_measure ?? null,
            validated: p.validated === 1,
          };
        })
        .filter((s): s is RadiationStation => s !== null);
      cache.set(all);
    } catch {
      all = cache.hit ?? [];
    }
  }

  const data = bbox
    ? all.filter(
        (s) => s.lon >= bbox.west && s.lon <= bbox.east && s.lat >= bbox.south && s.lat <= bbox.north,
      )
    : all;

  return c.json(envelope(data, 'Bundesamt für Strahlenschutz (ODL-Messnetz)'));
});

/**
 *   GET /api/radiation/history?id=DEZ2860[&days=3]
 *
 * Stundenwerte einer Sonde für die Kurve im Popup. Das BfS führt dafür eine
 * eigene WFS-Ebene (`odlinfo_timeseries_odl_1h`); gefiltert wird über die
 * Kennung der Sonde, sortiert nach Messende absteigend.
 */
radiationRoute.get('/history', async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(id)) return c.json({ error: 'id erforderlich' }, 400);
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 3) || 3, 1), 7);

  const cache = cached<RadiationHistory>(`radiation-hist:${id}:${days}`, 1800);
  if (cache.hit) return c.json(envelope(cache.hit, 'Bundesamt für Strahlenschutz (ODL-Messnetz)', true));

  const url =
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(TIMESERIES)}&outputFormat=application/json` +
    `&count=${days * 24}&sortBy=end_measure+D` +
    `&CQL_FILTER=${encodeURIComponent(`id='${id}'`)}`;

  const empty: RadiationHistory = { points: [], min: 0, max: 0, average: 0 };
  try {
    const data = await fetchJson<{ features?: WfsFeature[] }>(url, { timeoutMs: 20000 });
    // Nachgereichte Einzelwerte hängen sonst als weit zurückliegender Punkt an
    // der Kurve — deshalb hart auf das angefragte Fenster beschneiden.
    const cutoff = Date.now() - days * 86_400_000;
    const points: RadiationPoint[] = (data.features ?? [])
      .map((f) => ({ t: f.properties?.end_measure ?? '', v: Number(f.properties?.value) }))
      .filter((p) => p.t && Number.isFinite(p.v) && Date.parse(p.t) >= cutoff)
      // Die Antwort kommt neueste zuerst — für die Kurve andersherum.
      .reverse();
    if (!points.length) return c.json(envelope(empty, 'Bundesamt für Strahlenschutz (ODL-Messnetz)'));

    const values = points.map((p) => p.v);
    const history: RadiationHistory = {
      points,
      min: Math.min(...values),
      max: Math.max(...values),
      average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
    };
    cache.set(history);
    return c.json(envelope(history, 'Bundesamt für Strahlenschutz (ODL-Messnetz)'));
  } catch {
    return c.json(envelope(empty, 'Bundesamt für Strahlenschutz (ODL-Messnetz)'));
  }
});
