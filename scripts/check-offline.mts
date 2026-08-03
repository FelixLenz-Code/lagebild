/**
 * Prüflauf für Graph, Router und Suchindex — läuft in Node gegen die gebauten
 * Paketdateien, ohne Browser:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-offline.mts [ordner] [code]
 *
 * Entwicklungswerkzeug: es liest dieselben Module wie die App und entpackt die
 * Nutzlast so, wie es sonst der Download im Browser tut.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { Container, HEADER_PROBE_BYTES, parseHeader } from '../apps/web/src/offline/container.js';
import { RouteGraph, mergeGraphs, distanceM } from '../apps/web/src/offline/graph.js';
import { PROFILES, route, snap } from '../apps/web/src/offline/router.js';
import { SearchIndex } from '../apps/web/src/offline/search.js';

const dir = process.argv[2] ?? 'apps/api/maps';
/** Mehrere Codes durch Komma trennen — dann werden die Regionen verbunden. */
const codes = (process.argv[3] ?? '04').split(',');
const code = codes[0]!;

/** Datei laden und die Nutzlast entpacken — das macht sonst der Download. */
function loadContainer(path: string): { container: Container; bytes: Uint8Array } {
  const raw = readFileSync(path);
  const header = parseHeader(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.min(raw.length, HEADER_PROBE_BYTES)));
  const payload = header.deflate
    ? inflateRawSync(raw.subarray(header.payloadStart))
    : raw.subarray(header.payloadStart);
  const merged = new Uint8Array(header.payloadStart + payload.length);
  merged.set(raw.subarray(0, header.payloadStart));
  merged.set(payload, header.payloadStart);
  const plain = { ...header, deflate: false };
  return { container: new Container(plain, merged.buffer), bytes: merged };
}

const t0 = Date.now();
const parts = codes.map((c) => RouteGraph.fromContainer(loadContainer(join(dir, `${c}.route`)).container));
const graph = mergeGraphs(parts);
console.log(`Graph geladen in ${Date.now() - t0} ms:`, {
  regionen: codes.join('+'),
  nodes: graph.nodeCount,
  edges: graph.edgeCount,
  verbote: graph.restrictionCount,
  nahtstellen: graph.meta.stitches ?? 0,
  bbox: graph.meta.bbox,
});

const { container: searchC, bytes: searchBytes } = loadContainer(join(dir, `${code}.search`));
const index = new SearchIndex(searchC, async (start, length) =>
  searchBytes.subarray(start, start + length),
);
console.log('Suchindex:', { entries: index.entryCount, terms: index.termCount });

/* --- Fangen --- */
const hbf = { lat: 53.0836, lon: 8.8137 }; // Bremen Hbf
const s = snap(graph, hbf, PROFILES.car);
console.log('Snap Hbf:', s && { name: s.name, offRoadM: Math.round(s.offRoadM), lenM: Math.round(s.totalM) });

/* --- Routen --- */
const targets: [string, { lat: number; lon: number }][] = [
  ['Bremerhaven', { lat: 53.5396, lon: 8.5809 }],
  ['Bremen-Vegesack', { lat: 53.1667, lon: 8.6167 }],
  ['Universität Bremen', { lat: 53.1069, lon: 8.8517 }],
];
for (const [name, to] of targets) {
  for (const profile of ['car', 'bike', 'foot'] as const) {
    if (profile !== 'car' && name === 'Bremerhaven') continue;
    const t = Date.now();
    const r = route(graph, hbf, to, profile);
    const air = distanceM(hbf.lat, hbf.lon, to.lat, to.lon) / 1000;
    if (!r) {
      console.log(`${name} / ${profile}: KEINE ROUTE (${Date.now() - t} ms)`);
      continue;
    }
    console.log(
      `${name} / ${profile}: ${(r.distanceM / 1000).toFixed(1)} km (Luftlinie ${air.toFixed(1)} km), ` +
        `${Math.round(r.durationS / 60)} min, ${r.steps.length} Anweisungen, ${r.coordinates.length} Punkte, ${Date.now() - t} ms`,
    );
    if (profile === 'car' && name === 'Bremerhaven') {
      for (const st of r.steps.slice(0, 6)) {
        console.log(`   · ${st.text} (${Math.round(st.distanceM)} m)`);
      }
      console.log(`   … ${r.steps[r.steps.length - 1]!.text}`);
    }
  }
}

/* --- Wander- und Radwegenetz --- */
if (graph.hasTrails) {
  let hike = 0;
  let bike = 0;
  let named = 0;
  const names = new Set<string>();
  for (let e = 0; e < graph.edgeCount; e++) {
    const mask = graph.trail(e);
    if (!mask) continue;
    if (mask & 1) hike++;
    if (mask & 2) bike++;
    const name = graph.trailName(e);
    if (name) {
      named++;
      names.add(name);
    }
  }
  console.log(
    `\nWegenetz: ${hike} Kanten Wandern, ${bike} Rad, ${named} benannt, ${names.size} verschiedene Routen`,
  );
  console.log('   z. B. ' + [...names].slice(0, 5).join(' · '));
} else {
  console.log('\nWegenetz: im Paket nicht enthalten (älterer Bau)');
}

/* --- Suche --- */
const queries = ['Schlengstraße 31', 'Apotheke', 'Bremerhaven', 'Am Wall 12', 'Universität', 'Tankstelle'];
const hitCounts = new Map<string, number>();
for (const q of queries) {
  const t = Date.now();
  const hits = await index.query(q, hbf, 4);
  hitCounts.set(q, hits.length);
  console.log(`\nSuche „${q}" (${Date.now() - t} ms):`);
  for (const h of hits) {
    console.log(
      `   ${h.name} — ${h.detail ?? ''} [${h.category}] ${h.distanceM != null ? `${(h.distanceM / 1000).toFixed(1)} km` : ''} @ ${h.lat.toFixed(5)},${h.lon.toFixed(5)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Mindestanforderungen
 *
 * Der Rest des Skripts ist zum Anschauen — dieser Teil entscheidet über den
 * Rückgabewert, damit es in der CI etwas taugt. Geprüft wird nur, was für
 * **jedes** Bundesland-Paket gelten muss; feste Zahlen stünden hier falsch,
 * weil sich OpenStreetMap täglich ändert.
 * ------------------------------------------------------------------ */

let failed = 0;
const must = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++;
  console.log(`\n  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

must('Graph hat Knoten und Kanten', graph.nodeCount > 1000 && graph.edgeCount > 1000);
must('Suchindex ist gefüllt', index.entryCount > 1000 && index.termCount > 100);
must('Startpunkt lässt sich fangen', !!s && s.offRoadM < 3000);
for (const profile of ['car', 'bike', 'foot'] as const) {
  const r = route(graph, hbf, { lat: 53.1069, lon: 8.8517 }, profile);
  must(
    `Route zur Universität (${profile})`,
    !!r && r.distanceM > 1000 && r.steps.length > 2,
    r ? `${(r.distanceM / 1000).toFixed(1)} km, ${r.steps.length} Anweisungen` : 'keine Route',
  );
}
must('Adresssuche findet die Hausnummer', (hitCounts.get('Schlengstraße 31') ?? 0) > 0);
must('Kategoriesuche findet etwas', (hitCounts.get('Apotheke') ?? 0) > 0);

console.log(failed ? `\n${failed} Mindestanforderung(en) nicht erfüllt\n` : '\nAlle Mindestanforderungen erfüllt\n');
process.exit(failed ? 1 : 0);
