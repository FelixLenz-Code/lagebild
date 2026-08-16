/**
 * Prüflauf für Erreichbarkeit, Fahrzeiten und Schattenwurf — gegen die echten
 * Paketdateien, ohne Browser:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-reach.mts [ordner] [code]
 *
 * Geprüft wird nicht nur „läuft durch", sondern ob die Zahlen stimmen: Ein
 * größeres Zeitbudget muss ein größeres Netz ergeben, die Fahrzeit zu einem
 * Ziel muss zu der Route dorthin passen, und der Schatten muss zur Tageszeit
 * wandern.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { Container, HEADER_PROBE_BYTES, parseHeader } from '../apps/web/src/offline/container.js';
import { RouteGraph, distanceM } from '../apps/web/src/offline/graph.js';
import { reachable, route, travelTimes } from '../apps/web/src/offline/router.js';
import { Terrain, renderShadow } from '../apps/web/src/offline/terrain.js';

const dir = process.argv[2] ?? 'apps/api/maps';
const code = process.argv[3] ?? '04';

let failed = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

function loadContainer(path: string): Container {
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
  return new Container({ ...header, deflate: false }, merged.buffer);
}

const graph = RouteGraph.fromContainer(loadContainer(join(dir, `${code}.route`)));
const hbf = { lat: 53.0836, lon: 8.8137 }; // Bremen Hbf

/* ---------- Erreichbarkeit ---------- */

const t0 = Date.now();
const zehn = reachable(graph, hbf, 'car', 600);
const dreissig = reachable(graph, hbf, 'car', 1800);
const ms = Date.now() - t0;

check('10-Minuten-Netz gefunden', zehn.status === 'ok' && zehn.edges.length > 100, `${zehn.edges.length} Abschnitte`);
// Verglichen wird die Streckenlänge, nicht die Zahl der Abschnitte: Bei
// größeren Budgets werden kleine Wege für die Karte weggelassen, die Zahl kann
// also sinken, während das erreichte Netz wächst.
check(
  '30 Minuten erreichen mehr als 10',
  dreissig.networkM > zehn.networkM * 1.5,
  `${Math.round(zehn.networkM / 1000)} → ${Math.round(dreissig.networkM / 1000)} km`,
);
check('Netzlänge wächst mit', dreissig.networkM > zehn.networkM, `${Math.round(zehn.networkM / 1000)} → ${Math.round(dreissig.networkM / 1000)} km`);
// Ausgewiesen wird die reine Fahrzeit (ohne Kreuzungsaufschläge), gesucht wurde
// mit ihnen — sie kann also nur kleiner sein als das Budget, nie größer.
check('keine Fahrzeit über dem Budget', dreissig.edges.every((e) => e.seconds <= 1800));
check('beide Läufe zusammen unter 5 s', ms < 5000, `${ms} ms`);

// Eine volle Stunde im Auto deckt die ganze Region ab. Die Ausgabe wird dann
// ausgedünnt — aber die Suche darf nicht abbrechen, sonst hätte das Ergebnis
// eine erfundene Kante als Rand.
const weitest30 = Math.max(
  ...dreissig.edges.map((e) => distanceM(hbf.lat, hbf.lon, e.coordinates[0]![1], e.coordinates[0]![0])),
);
const stunde = reachable(graph, hbf, 'car', 3600);
check('60 Minuten reichen weiter als 30', stunde.networkM > dreissig.networkM, `${Math.round(stunde.networkM / 1000)} km`);
check('Ausgabe bleibt zeichenbar', stunde.edges.length <= 25_000, `${stunde.edges.length} Abschnitte`);
const weitest60 = Math.max(
  ...stunde.edges.map((e) => distanceM(hbf.lat, hbf.lon, e.coordinates[0]![1], e.coordinates[0]![0])),
);
// Wie weit es tatsächlich reicht, gibt der Auszug vor (04 ist die Stadt Bremen,
// nicht das Umland) — geprüft wird deshalb, dass der Umriss überhaupt wächst.
check('Umriss wächst gegenüber 30 Minuten', weitest60 > weitest30 * 1.2, `${Math.round(weitest30 / 1000)} → ${Math.round(weitest60 / 1000)} km`);

// Jeder Abschnitt muss eine Geometrie mit mindestens zwei Punkten haben, sonst
// zeichnet MapLibre nichts.
check('alle Abschnitte haben eine Linie', dreissig.edges.every((e) => e.coordinates.length >= 2));

// Der weiteste Punkt im 10-Minuten-Netz darf nicht weiter weg liegen, als man
// in zehn Minuten überhaupt fahren kann (grob: 120 km/h Luftlinie = 20 km).
const weitest = Math.max(
  ...zehn.edges.map((e) => distanceM(hbf.lat, hbf.lon, e.coordinates[0]![1], e.coordinates[0]![0])),
);
check('10-Minuten-Netz bleibt im Plausiblen', weitest < 20_000, `${Math.round(weitest / 1000)} km weitester Punkt`);

/*
 * Zu Fuß muss ein **kleineres Gebiet** ergeben. Verglichen wird der Radius, nicht
 * die Streckenlänge: In der Innenstadt liegen auf wenigen Quadratkilometern
 * hunderte Kilometer Wege, die Netzlänge sagt darum nichts über die Reichweite.
 */
const fuss = reachable(graph, hbf, 'foot', 1800);
const radius = (r: typeof fuss) =>
  Math.max(...r.edges.map((e) => distanceM(hbf.lat, hbf.lon, e.coordinates[0]![1], e.coordinates[0]![0])));
check(
  'zu Fuß kommt weniger weit als mit dem Auto',
  radius(fuss) < radius(dreissig) / 3,
  `${(radius(fuss) / 1000).toFixed(1)} km zu Fuß gegen ${(radius(dreissig) / 1000).toFixed(1)} km im Auto`,
);
check('zu Fuß bleibt im Plausiblen (30 min ≈ 2,5 km)', radius(fuss) < 4000, `${Math.round(radius(fuss))} m`);

/* Startpunkt weit außerhalb des Netzes (Nordsee) wird erkannt. */
const see = reachable(graph, { lat: 54.2, lon: 7.5 }, 'car', 900);
check('Startpunkt ohne Netz wird gemeldet', see.status === 'start-off-grid', see.status);

/* ---------- Fahrzeiten zu mehreren Zielen ---------- */

/*
 * Die Ziele werden **aus dem Netz selbst** genommen (Knoten in 2, 5 und 10 km
 * Entfernung). Von Hand gewählte Koordinaten liegen sonst leicht in einer Lücke
 * des Auszugs, und dann prüft der Lauf die eigene Ortskenntnis statt des Codes.
 */
function nodeAt(km: number): { lat: number; lon: number } {
  let best = { lat: hbf.lat, lon: hbf.lon };
  let diff = Infinity;
  for (const n of graph.nodesNear(hbf.lat, hbf.lon, 4000, 20_000)) {
    const lat = graph.nodeLat(n);
    const lon = graph.nodeLon(n);
    const d = Math.abs(distanceM(hbf.lat, hbf.lon, lat, lon) - km * 1000);
    if (d < diff) {
      diff = d;
      best = { lat, lon };
    }
  }
  return best;
}
const ziele = [nodeAt(2), nodeAt(5), nodeAt(10)];
const zeiten = travelTimes(graph, hbf, ziele, 'car', 1800);
check('alle drei Ziele erreicht', zeiten.every((z) => z != null), zeiten.join(' / '));

// Gegenprobe: die einzeln gerechnete Route zum ersten Ziel muss ungefähr
// dieselbe Fahrzeit ergeben. „Ungefähr", weil die Erreichbarkeit an der
// nächstgelegenen Kante abliest und nicht exakt an der Hausnummer.
const einzeln = route(graph, hbf, ziele[0]!, 'car');
const abweichung = Math.abs((einzeln?.durationS ?? 0) - (zeiten[0] ?? 0));
check(
  'Fahrzeit passt zur einzeln gerechneten Route',
  einzeln != null && abweichung < 45,
  `Route ${Math.round((einzeln?.durationS ?? 0) / 60)} min, Erreichbarkeit ${Math.round((zeiten[0] ?? 0) / 60)} min`,
);

// Ein Ziel außerhalb des Budgets bekommt keine erfundene Zeit.
const weit = travelTimes(graph, hbf, [{ lat: 53.55, lon: 8.58 }], 'car', 300);
check('unerreichbares Ziel bleibt ohne Zeit', weit[0] == null);

/* ---------- Schattenwurf ---------- */

/*
 * Für den Schatten braucht es **Relief**. Bremen ist flach — dort ist die
 * richtige Antwort „kein Schatten", und damit ließe sich nichts prüfen. Genommen
 * wird deshalb das erste Geländepaket mit Bergen, in der Regel Hessen (06).
 */
const RELIEF = process.env.RELIEF_CODE ?? '06';
let terrain: Terrain | null = null;
let terrainCode = '';
for (const c of [RELIEF, code]) {
  try {
    terrain = new Terrain(loadContainer(join(dir, `${c}.terrain`)));
    terrainCode = c;
    break;
  } catch {
    /* nächstes probieren */
  }
}
if (!terrain) console.log('  --   Schattenwurf übersprungen (kein Geländepaket vorhanden)');
else console.log(`       (Schatten geprüft an Region ${terrainCode})`);

if (terrain) {
  const morgens = renderShadow(terrain, 12, 100, 512); // Sonne tief im Osten
  const abends = renderShadow(terrain, 12, 260, 512); // Sonne tief im Westen
  const mittags = renderShadow(terrain, 60, 180, 512);
  const nachts = renderShadow(terrain, -5, 90, 512);

  const anteil = (img: { rgba: Uint8ClampedArray }) => {
    let n = 0;
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i]! > 0) n++;
    return n / (img.rgba.length / 4);
  };

  check('Bild hat die erwartete Größe', morgens.width > 0 && morgens.height > 0, `${morgens.width}×${morgens.height}`);
  check('Nacht ist vollständig dunkel', nachts.night && anteil(nachts) === 1);
  check('mittags weniger Schatten als morgens', anteil(mittags) < anteil(morgens), `${(anteil(mittags) * 100).toFixed(1)} % vs. ${(anteil(morgens) * 100).toFixed(1)} %`);

  // Morgens und abends steht die Sonne gleich hoch, aber auf der anderen Seite:
  // Die Schattenflächen müssen sich unterscheiden, sonst wird der Azimut nicht
  // ausgewertet.
  let gleich = 0;
  for (let i = 3; i < morgens.rgba.length; i += 4) {
    if ((morgens.rgba[i]! > 0) === (abends.rgba[i]! > 0)) gleich++;
  }
  const anteilGleich = gleich / (morgens.rgba.length / 4);
  check('Sonnenrichtung wirkt sich aus', anteilGleich < 0.999, `${(anteilGleich * 100).toFixed(2)} % gleich`);
  // Hessen ist Mittelgebirge, kein Hochgebirge: Bei 12° Sonnenhöhe liegt gut ein
// halbes Prozent der Fläche im Schlagschatten der Hänge. Geprüft wird, dass
// überhaupt etwas gefunden wird — und weiter oben, dass es mittags weniger ist.
check('morgens liegt Schatten', anteil(morgens) > 0.002, `${(anteil(morgens) * 100).toFixed(2)} %`);
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
process.exit(failed ? 1 : 0);
