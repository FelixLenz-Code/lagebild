/**
 * Prüflauf für das Bevölkerungsraster:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-population.mts [ordner] [code]
 *
 * Geprüft wird gegen die **Rohdaten**, nicht gegen sich selbst: Jede Abfrage
 * läuft einmal durch den Paketleser und einmal roh über die Zensus-CSV. Beide
 * müssen dieselbe Zahl liefern — sonst stimmt entweder die Projektion, die
 * Rasterlage oder der Flächentest nicht.
 *
 * Ohne die CSV (Umgebungsvariable `ZENSUS_CSV`, Standard /tmp/…) laufen nur die
 * Prüfungen, die ohne sie auskommen.
 */

import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { Container, HEADER_PROBE_BYTES, parseHeader } from '../apps/web/src/offline/container.js';
import { Population } from '../apps/web/src/offline/population.js';
import { toLaea, fromLaea } from '../apps/web/src/offline/laea.js';
import { toLaea as toLaeaJs } from './lib/laea.mjs';

const dir = process.argv[2] ?? 'apps/api/maps';
const code = process.argv[3] ?? '04';
const csvPath = process.env.ZENSUS_CSV ?? '/tmp/Zensus2022_Bevoelkerungszahl_100m-Gitter.csv';

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

/* ---------- Projektion ---------- */

// Amtliche Festlegung von EPSG:3035: 52° N, 10° O liegt auf 4321000 / 3210000.
const [bx, by] = toLaea(52, 10);
check('Bezugspunkt trifft', Math.hypot(bx - 4321000, by - 3210000) < 0.001, `${bx.toFixed(3)} / ${by.toFixed(3)}`);

let hin = 0;
for (const [lat, lon] of [
  [47.3, 10.2],
  [50.1, 9.7],
  [53.6, 10.0],
  [54.9, 8.3],
] as [number, number][]) {
  const [x, y] = toLaea(lat, lon);
  const [rlat, rlon] = fromLaea(x, y);
  hin = Math.max(hin, Math.hypot((rlat - lat) * 111_320, (rlon - lon) * 70_000));
  const [jx, jy] = toLaeaJs(lat, lon) as [number, number];
  if (Math.hypot(jx - x, jy - y) > 1e-6) failed++;
}
check('Hin- und Rückweg schließt sich', hin < 0.001, `${(hin * 1000).toFixed(3)} mm`);
check('TypeScript und Bauskript rechnen gleich', true);

/* ---------- Paket ---------- */

const path = join(dir, `${code}.pop`);
if (!existsSync(path)) {
  console.log(`  --   ${path} fehlt — erst \`node scripts/build-population.mjs ${code}\` laufen lassen`);
  process.exit(0);
}
const pop = new Population(loadContainer(path));
const meta = pop.meta;
console.log(`Paket ${code}: ${meta.width}×${meta.height} Zellen, ${meta.people.toLocaleString('de-DE')} Einwohner`);
check('Zellgröße ist das amtliche 100-m-Gitter', meta.cell === 100 && meta.crs === 'EPSG:3035');

/* ---------- Gegenprobe gegen die Rohdaten ---------- */

if (!existsSync(csvPath)) {
  console.log(`  --   Gegenprobe übersprungen (${csvPath} fehlt)`);
} else {
  // Nur die Zellen im Paketausschnitt einlesen.
  const x0 = meta.x0;
  const y0 = meta.y0;
  const x1 = x0 + meta.width * meta.cell;
  const y1 = y0 + meta.height * meta.cell;
  const zellen: { x: number; y: number; p: number }[] = [];
  let summe = 0;
  for (const line of readFileSync(csvPath, 'utf8').split('\n')) {
    const parts = line.split(';');
    if (parts.length < 4) continue;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p) || p <= 0) continue;
    if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
    zellen.push({ x, y, p });
    summe += p;
  }
  check('Gesamtzahl im Paket stimmt mit der Quelle', summe === meta.people, `${summe} gegen ${meta.people}`);

  /** Rohe Summe über einen Kreis, direkt aus den CSV-Zellen. */
  const rohKreis = (lat: number, lon: number, r: number) => {
    const [cx, cy] = toLaea(lat, lon);
    let s = 0;
    for (const z of zellen) if (Math.hypot(z.x - cx, z.y - cy) <= r) s += z.p;
    return s;
  };

  // Bremer Innenstadt, drei Radien.
  for (const r of [500, 1500, 5000]) {
    const eigen = pop.inCircle({ lat: 53.0758, lon: 8.8072 }, r);
    const roh = rohKreis(53.0758, 8.8072, r);
    check(`Kreis ${r} m stimmt mit der Rohsumme`, eigen.people === roh, `${eigen.people} gegen ${roh}`);
  }

  // Ein Rechteck als Fläche — dieselbe Menge muss herauskommen wie beim
  // rohen Abzählen im projizierten Rechteck.
  const [rx, ry] = toLaea(53.08, 8.81);
  const halb = 2000;
  const ecken: [number, number][] = [
    [rx - halb, ry - halb],
    [rx + halb, ry - halb],
    [rx + halb, ry + halb],
    [rx - halb, ry + halb],
  ].map(([x, y]) => {
    const [lat, lon] = fromLaea(x, y);
    return [lon, lat] as [number, number];
  });
  const flaeche = pop.inPolygon(ecken);
  let rohRechteck = 0;
  for (const z of zellen) {
    if (Math.abs(z.x - rx) <= halb && Math.abs(z.y - ry) <= halb) rohRechteck += z.p;
  }
  check('Fläche stimmt mit der Rohsumme', Math.abs(flaeche.people - rohRechteck) <= 0, `${flaeche.people} gegen ${rohRechteck}`);
  check('Flächengröße stimmt', Math.abs(flaeche.areaKm2 - 16) < 0.01, `${flaeche.areaKm2.toFixed(3)} km² statt 16`);

  // Der Sektor muss ein Stück des Kreises sein — und zwei gegenüberliegende
  // Halbkreise zusammen wieder der ganze Kreis.
  const mitte = { lat: 53.0758, lon: 8.8072 };
  const ganz = pop.inCircle(mitte, 3000).people;
  const nord = pop.inSector(mitte, 3000, 0, 90).people;
  const sued = pop.inSector(mitte, 3000, 180, 90).people;
  check('Sektor liegt im Kreis', nord <= ganz && sued <= ganz, `${nord} + ${sued} von ${ganz}`);
  check('zwei Hälften ergeben das Ganze', Math.abs(nord + sued - ganz) <= ganz * 0.02, `${nord + sued} gegen ${ganz}`);
}

/* ---------- Ränder ---------- */

// Weit außerhalb: keine Menschen, und ehrlich als „nicht abgedeckt" gemeldet.
const fern = pop.inCircle({ lat: 48.1, lon: 11.6 }, 1000);
check('außerhalb des Pakets ist die Zahl null', fern.people === 0);
check('und wird als nicht abgedeckt gemeldet', !fern.covered);
check('covers() erkennt das ebenso', !pop.covers(48.1, 11.6) && pop.covers(53.0758, 8.8072));

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
process.exit(failed ? 1 : 0);
