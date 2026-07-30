import { Hono } from 'hono';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Listet die serverseitig vorhandenen Offline-Karten (PMTiles pro Bundesland,
 * Dateiname = zweistelliger Ländercode, z.B. 04.pmtiles). Die Dateien selbst
 * werden über /api/maps/<code>.pmtiles ausgeliefert (serveStatic in index.ts).
 */
export const mapsRoute = new Hono();

mapsRoute.get('/', (c) => {
  const data: { code: string; bytes: number }[] = [];
  if (existsSync(config.mapsDir)) {
    for (const file of readdirSync(config.mapsDir)) {
      const m = file.match(/^(\d{2})\.pmtiles$/);
      if (m) data.push({ code: m[1]!, bytes: statSync(join(config.mapsDir, file)).size });
    }
  }
  return c.json({ data, source: 'lagebild', fetchedAt: new Date().toISOString() });
});
