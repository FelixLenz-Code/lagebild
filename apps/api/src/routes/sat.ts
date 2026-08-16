import { Hono } from 'hono';
import type { SatelliteSet } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchText } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Bahndaten (TLE) für die Überflugvorhersage.
 *
 * Die Route reicht nur durch und normalisiert. **Gerechnet wird auf dem
 * Gerät** — die Bahnelemente sind ein paar Dutzend Kilobyte und gelten tagelang,
 * damit ist die Vorhersage danach vollständig offline möglich. Genau deshalb
 * lädt man sie als eigenes Paket herunter und nicht bei jedem Blick neu.
 *
 * Quelle: CelesTrak (Dr. T.S. Kelso), Nutzung frei mit Quellenangabe. Die
 * Betreiber bitten ausdrücklich darum, nicht öfter als alle paar Stunden
 * abzurufen — TLE werden ein- bis zweimal täglich erneuert. Deshalb der lange
 * Cache hier und der Hinweis in der Oberfläche, wie alt der Stand ist.
 */
export const satRoute = new Hono();

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';
/** Vier Stunden — deutlich seltener, als die Quelle selbst erneuert. */
const CACHE_SECONDS = 4 * 3600;

/**
 * Die angebotenen Gruppen. Bewusst kurz gehalten: Ein Paket über alle
 * zehntausend Objekte wäre nutzlos groß, und die Frage „wann sehe ich was"
 * betrifft diese vier.
 */
const GROUPS: Record<string, { celestrak: string; label: string }> = {
  stations: { celestrak: 'stations', label: 'Raumstationen (ISS, Tiangong)' },
  weather: { celestrak: 'weather', label: 'Wettersatelliten (NOAA, Meteor)' },
  amateur: { celestrak: 'amateur', label: 'Amateurfunk' },
  visual: { celestrak: 'visual', label: 'Mit bloßem Auge sichtbar' },
};

export const SAT_GROUPS = Object.entries(GROUPS).map(([id, g]) => ({ id, label: g.label }));

/** TLE-Text (drei Zeilen je Satellit) in Einträge zerlegen. */
function parseTle(text: string): SatelliteSet['satellites'] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const out: SatelliteSet['satellites'] = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1 || !l2) break;
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) break;
    out.push({ name: name.trim(), line1: l1, line2: l2 });
  }
  return out;
}

satRoute.get('/tle', async (c) => {
  const wanted = (c.req.query('groups') ?? 'stations,weather,amateur')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g in GROUPS);
  const groups = wanted.length ? [...new Set(wanted)] : ['stations'];

  const key = `sat-tle:${groups.slice().sort().join(',')}`;
  const cache = cached<SatelliteSet>(key, CACHE_SECONDS);
  if (cache.hit) return c.json(envelope(cache.hit, 'celestrak.org', true));

  const satellites: SatelliteSet['satellites'] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    let text: string;
    try {
      text = await fetchText(`${BASE}?GROUP=${GROUPS[group]!.celestrak}&FORMAT=tle`, { timeoutMs: 12000 });
    } catch {
      // Eine ausgefallene Gruppe darf das Paket nicht verhindern.
      continue;
    }
    for (const sat of parseTle(text)) {
      // Ein Satellit steht oft in mehreren Gruppen (die ISS in „stations" und
      // „visual") — die Kennung aus Zeile 1 entscheidet.
      const id = sat.line1.slice(2, 7);
      if (seen.has(id)) continue;
      seen.add(id);
      satellites.push({ ...sat, group });
    }
  }

  if (!satellites.length) return c.json({ error: 'Keine Bahndaten erhalten' }, 502);
  const set: SatelliteSet = { satellites, updatedAt: new Date().toISOString() };
  cache.set(set);
  return c.json(envelope(set, 'celestrak.org'));
});
