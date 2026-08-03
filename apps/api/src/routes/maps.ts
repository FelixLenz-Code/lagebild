import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Listet die serverseitig vorhandenen Offline-Pakete je Bundesland. Der
 * Dateiname ist immer der zweistellige Ländercode:
 *
 *   04.pmtiles   Hintergrundkarte (Vektorkacheln)
 *   04.route     Routing-Graph für die Navigation
 *   04.terrain   Höhenraster für das Höhenprofil (optional)
 *   04.search    Suchindex mit Adressen und POIs
 *
 * Ausgeliefert werden die Dateien über /api/maps/<datei> (serveStatic in
 * index.ts). Erzeugt werden sie mit scripts/build-maps.sh bzw.
 * scripts/build-routing.mjs.
 */
export const mapsRoute = new Hono();

const KIND_BY_EXT: Record<string, 'map' | 'route' | 'search' | 'terrain'> = {
  pmtiles: 'map',
  route: 'route',
  search: 'search',
  terrain: 'terrain',
};

export interface MapRegionInfo {
  code: string;
  map?: number;
  route?: number;
  search?: number;
  terrain?: number;
}

mapsRoute.get('/', (c) => {
  const byCode = new Map<string, MapRegionInfo>();
  if (existsSync(config.mapsDir)) {
    for (const file of readdirSync(config.mapsDir)) {
      const m = file.match(/^(\d{2})\.(pmtiles|route|search|terrain)$/);
      if (!m) continue;
      const code = m[1]!;
      let entry = byCode.get(code);
      if (!entry) byCode.set(code, (entry = { code }));
      entry[KIND_BY_EXT[m[2]!]!] = statSync(join(config.mapsDir, file)).size;
    }
  }
  const data = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  return c.json({ data, source: 'lagebild', fetchedAt: new Date().toISOString() });
});
