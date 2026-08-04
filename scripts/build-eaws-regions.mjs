#!/usr/bin/env node
/**
 * Holt die Regionsflächen des Europäischen Lawinenwarndienst-Verbunds (EAWS)
 * und schreibt daraus eine kleine Datei für den Server:
 *
 *   node scripts/build-eaws-regions.mjs [ziel.json]
 *
 * Die Quelle umfasst 751 Mikroregionen von Andorra bis Norwegen und wiegt
 * 16 MB. Gebraucht wird davon der **Alpenraum samt Deutschland** — und auch
 * der nur so genau, wie eine Übersichtskarte ihn zeigen kann. Deshalb wird
 * gefiltert und die Umrisse ausgedünnt.
 *
 * Läuft einmal beim Bauen, nicht zur Laufzeit: Die Regionsgrenzen ändern sich
 * höchstens einmal im Jahr, die Lawinenlage täglich.
 */

import { writeFileSync } from 'node:fs';

const SOURCE = process.env.EAWS_REGIONS ?? 'https://regions.avalanches.org/micro-regions.geojson';
const OUT = process.argv[2] ?? 'apps/api/src/data/eaws-regions.json';

/** Länder, deren Regionen übernommen werden (Alpenbogen + Deutschland). */
const WANTED = ['DE', 'AT', 'CH', 'LI', 'IT', 'FR', 'SI'];

/** Ausdünnung der Umrisse in Grad — rund 100 m, für eine Übersicht reichlich. */
const TOLERANCE = 0.004;

/** Douglas-Peucker auf einem Ring (iterativ, in Grad gerechnet). */
function simplify(ring, tolerance) {
  if (ring.length < 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [from, to] = stack.pop();
    if (to - from < 2) continue;
    const [ax, ay] = ring[from];
    const [bx, by] = ring[to];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const px = ring[i][0] - ax;
      const py = ring[i][1] - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ox = px - t * dx;
      const oy = py - t * dy;
      const d2 = ox * ox + oy * oy;
      if (d2 > worst) {
        worst = d2;
        at = i;
      }
    }
    if (worst > tol2 && at > 0) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  const out = ring.filter((_, i) => keep[i] === 1);
  // Ein Ring braucht mindestens vier Punkte und muss geschlossen bleiben.
  if (out.length < 4) return ring;
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push(first);
  return out;
}

/** Koordinaten auf fünf Nachkommastellen runden (~1 m) — spart nochmals viel. */
const round = (ring) => ring.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);

function shrink(geometry) {
  const rings = (list) => list.map((ring) => round(simplify(ring, TOLERANCE)));
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: rings(geometry.coordinates) };
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(rings) };
  }
  return geometry;
}

const before = Date.now();
process.stdout.write(`Lade ${SOURCE} … `);
// Beim Entwickeln darf auch eine schon heruntergeladene Datei herhalten.
let raw;
if (SOURCE.startsWith('http')) {
  const res = await fetch(SOURCE, { headers: { 'user-agent': 'lagebild-build/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  raw = await res.text();
} else {
  raw = (await import('node:fs')).readFileSync(SOURCE.replace('file://', ''), 'utf8');
}
console.log(`${(raw.length / 1_048_576).toFixed(1)} MB in ${((Date.now() - before) / 1000).toFixed(1)} s`);

const all = JSON.parse(raw);
const kept = [];
for (const f of all.features) {
  const id = String(f.properties?.id ?? '');
  if (!WANTED.some((c) => id === c || id.startsWith(`${c}-`))) continue;
  kept.push({ id, geometry: shrink(f.geometry) });
}

// Nach Land gruppiert ausgeben — das erleichtert das Nachsehen von Hand.
kept.sort((a, b) => a.id.localeCompare(b.id));
const out = { source: SOURCE, built: new Date().toISOString(), regions: kept };
const text = JSON.stringify(out);
writeFileSync(OUT, text);

const byCountry = {};
for (const r of kept) {
  const c = r.id.split('-')[0];
  byCountry[c] = (byCountry[c] ?? 0) + 1;
}
console.log(`${kept.length} von ${all.features.length} Regionen übernommen:`);
console.log('  ' + Object.entries(byCountry).map(([c, n]) => `${c} ${n}`).join(' · '));
console.log(`${OUT} — ${(text.length / 1024).toFixed(0)} kB (aus ${(raw.length / 1_048_576).toFixed(1)} MB)`);
