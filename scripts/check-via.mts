/**
 * Prüflauf für **Zwischenziele** in der Offline-Routenplanung:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-via.mts [ordner] [code]
 *
 * Geprüft wird das, was beim Aneinanderhängen der Abschnitte schiefgehen kann:
 * Doppelpunkte an der Naht, verrutschte Anweisungsindizes, falsche Summen und
 * die Frage, ob der Umweg über das Zwischenziel überhaupt einer ist.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import type { Coords } from '@lagebild/shared';
import { Container, HEADER_PROBE_BYTES, parseHeader } from '../apps/web/src/offline/container.js';
import { RouteGraph, distanceM } from '../apps/web/src/offline/graph.js';
import { routeVia } from '../apps/web/src/offline/router.js';

const dir = process.argv[2] ?? 'apps/api/maps';
const code = process.argv[3] ?? '04';

let failed = 0;
const check = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

function loadGraph(path: string): RouteGraph {
  const raw = readFileSync(path);
  const header = parseHeader(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.min(raw.length, HEADER_PROBE_BYTES)),
  );
  const payload = header.deflate
    ? inflateRawSync(raw.subarray(header.payloadStart))
    : raw.subarray(header.payloadStart);
  const merged = new Uint8Array(header.payloadStart + payload.length);
  merged.set(raw.subarray(0, header.payloadStart));
  merged.set(payload, header.payloadStart);
  return RouteGraph.fromContainer(new Container({ ...header, deflate: false }, merged.buffer));
}

const graph = loadGraph(join(dir, `${code}.route`));
console.log(`Graph ${code}: ${graph.nodeCount} Knoten, ${graph.edgeCount} Kanten\n`);

const hbf: Coords = { lat: 53.0836, lon: 8.8137 }; // Bremen Hbf
const uni: Coords = { lat: 53.1069, lon: 8.8517 }; // Universität
const vegesack: Coords = { lat: 53.1667, lon: 8.6167 };
const neustadt: Coords = { lat: 53.0619, lon: 8.7856 }; // südlich der Weser

/* ------------------------------------------------------------------ */

console.log('Ein Zwischenziel');
const direct = routeVia(graph, [hbf, uni], 'car');
const withVia = routeVia(graph, [hbf, neustadt, uni], 'car');
check('direkte Route gefunden', direct.status === 'ok');
check('Route mit Zwischenziel gefunden', withVia.status === 'ok', withVia.status);

const r = withVia.route!;
const d = direct.route!;
console.log(
  `  direkt ${(d.distanceM / 1000).toFixed(1)} km / ${Math.round(d.durationS / 60)} min · ` +
    `über Neustadt ${(r.distanceM / 1000).toFixed(1)} km / ${Math.round(r.durationS / 60)} min`,
);
check('der Umweg ist wirklich länger', r.distanceM > d.distanceM);
check('zwei Abschnitte gemeldet', r.legs?.length === 2, `${r.legs?.length}`);
check('Summe der Abschnitte = Gesamtlänge', Math.abs((r.legs ?? []).reduce((s, l) => s + l.distanceM, 0) - r.distanceM) < 1);
check('Summe der Abschnitte = Gesamtdauer', Math.abs((r.legs ?? []).reduce((s, l) => s + l.durationS, 0) - r.durationS) < 1);
check('ein Zwischenziel eingetragen', r.waypoints?.length === 1);
check(
  'Zwischenziel liegt beim gewünschten Punkt',
  !!r.waypoints?.[0] && distanceM(r.waypoints[0].lat, r.waypoints[0].lon, neustadt.lat, neustadt.lon) < 200,
  r.waypoints?.[0] && `${Math.round(distanceM(r.waypoints[0].lat, r.waypoints[0].lon, neustadt.lat, neustadt.lon))} m daneben`,
);

/* Naht: kein doppelter Punkt, keine Lücke. */
let doubled = 0;
let biggestGap = 0;
for (let i = 1; i < r.coordinates.length; i++) {
  const [aLon, aLat] = r.coordinates[i - 1]!;
  const [bLon, bLat] = r.coordinates[i]!;
  const step = distanceM(aLat, aLon, bLat, bLon);
  if (step < 0.01) doubled++;
  if (step > biggestGap) biggestGap = step;
}
check('kein doppelter Punkt an der Naht', doubled === 0, `${doubled} doppelte`);
check('kein Sprung in der Linie', biggestGap < 2000, `größter Schritt ${Math.round(biggestGap)} m`);

/* Anweisungen: genau eine Zwischenziel-Marke, ein Aufbruch, ein Ziel. */
const kinds = r.steps.map((s) => s.type);
check('genau ein Aufbruch', kinds.filter((k) => k === 'depart').length === 1);
check('genau eine Zwischenziel-Anweisung', kinds.filter((k) => k === 'waypoint').length === 1);
check('genau ein Ziel', kinds.filter((k) => k === 'arrive').length === 1);
check('Ziel steht am Ende', kinds[kinds.length - 1] === 'arrive');

/* Die Indizes müssen nach dem Verschieben noch auf die richtigen Punkte zeigen. */
let worstIndex = 0;
for (const s of r.steps) {
  const p = r.coordinates[s.index];
  if (!p) {
    worstIndex = Infinity;
    break;
  }
  worstIndex = Math.max(worstIndex, distanceM(s.lat, s.lon, p[1], p[0]));
}
check('Anweisungen zeigen auf ihren Punkt in der Linie', worstIndex < 30, `größter Abstand ${Math.round(worstIndex)} m`);

const viaStep = r.steps.findIndex((s) => s.type === 'waypoint');
const viaPoint = r.coordinates[r.steps[viaStep]!.index]!;
check(
  'Zwischenziel-Anweisung sitzt an der Naht',
  distanceM(viaPoint[1], viaPoint[0], r.waypoints![0]!.lat, r.waypoints![0]!.lon) < 30,
);

/* ------------------------------------------------------------------ */

console.log('\nZwei Zwischenziele und Reihenfolge');
const twoVias = routeVia(graph, [hbf, neustadt, vegesack, uni], 'car');
check('Route gefunden', twoVias.status === 'ok', twoVias.status);
check('drei Abschnitte', twoVias.route?.legs?.length === 3);
check('zwei Zwischenziele', twoVias.route?.waypoints?.length === 2);
check(
  'Reihenfolge wird eingehalten',
  !!twoVias.route?.waypoints &&
    distanceM(twoVias.route.waypoints[0]!.lat, twoVias.route.waypoints[0]!.lon, neustadt.lat, neustadt.lon) < 200 &&
    distanceM(twoVias.route.waypoints[1]!.lat, twoVias.route.waypoints[1]!.lon, vegesack.lat, vegesack.lon) < 500,
);
const swapped = routeVia(graph, [hbf, vegesack, neustadt, uni], 'car');
check(
  'andere Reihenfolge ergibt eine andere Länge',
  swapped.status === 'ok' && swapped.route!.distanceM !== twoVias.route!.distanceM,
  `${(twoVias.route!.distanceM / 1000).toFixed(1)} km vs. ${(swapped.route!.distanceM / 1000).toFixed(1)} km`,
);
check(
  'keine Varianten bei Zwischenzielen',
  twoVias.routes.length === 1,
  `${twoVias.routes.length} Route(n)`,
);

/* ------------------------------------------------------------------ */

console.log('\nOhne Zwischenziel unverändert');
const plain = routeVia(graph, [hbf, uni], 'car', { alternatives: 3 });
check('Varianten bleiben möglich', plain.routes.length > 1, `${plain.routes.length} Varianten`);
check('keine Abschnittsliste ohne Zwischenziel', plain.route?.legs === undefined);

console.log('\nZwischenziel auf einem Stichweg');
{
  // Genau dieser Punkt kam aus einem Kartenklick im Browser: Er fängt sich auf
  // einem 43-m-Stummel im Bürgerpark, von dem für Autos kein Weg wegführt.
  // Ohne Ausweichkanten meldete die App „Keine Verbindung gefunden".
  const stub: Coords = { lat: 53.0996, lon: 8.8481 };
  const t = Date.now();
  const r = routeVia(graph, [hbf, stub, uni], 'car');
  check('Route trotzdem gefunden', r.status === 'ok', `${r.status}, ${Date.now() - t} ms`);
  check('und schnell', Date.now() - t < 1000, `${Date.now() - t} ms`);
  const near = r.route?.waypoints?.[0];
  check(
    'das Zwischenziel liegt noch in der Nähe des Klicks',
    !!near && distanceM(near.lat, near.lon, stub.lat, stub.lon) < 300,
    near && `${Math.round(distanceM(near.lat, near.lon, stub.lat, stub.lon))} m`,
  );
}

console.log('\nZwischenziel außerhalb des Netzes');
const off = routeVia(graph, [hbf, { lat: 48.14, lon: 11.58 }, uni], 'car');
check('wird als solches gemeldet', off.status === 'via-off-grid', off.status);
check('mit der richtigen Nummer', off.offGridVia === 0, `${off.offGridVia}`);

/* ------------------------------------------------------------------ */

console.log('\nZu Fuß');
const foot = routeVia(graph, [hbf, neustadt, uni], 'foot');
check('Route gefunden', foot.status === 'ok', foot.status);
check('Abschnitte vorhanden', foot.route?.legs?.length === 2);

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen\n` : '\nAlle Prüfungen bestanden\n');
process.exit(failed ? 1 : 0);
