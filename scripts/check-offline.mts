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

/* --- Suche --- */
const queries = ['Schlengstraße 31', 'Apotheke', 'Bremerhaven', 'Am Wall 12', 'Universität', 'Tankstelle'];
for (const q of queries) {
  const t = Date.now();
  const hits = await index.query(q, hbf, 4);
  console.log(`\nSuche „${q}" (${Date.now() - t} ms):`);
  for (const h of hits) {
    console.log(
      `   ${h.name} — ${h.detail ?? ''} [${h.category}] ${h.distanceM != null ? `${(h.distanceM / 1000).toFixed(1)} km` : ''} @ ${h.lat.toFixed(5)},${h.lon.toFixed(5)}`,
    );
  }
}
