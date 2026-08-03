/**
 * Prüflauf für die Höhenpakete:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-terrain.mts [ordner] [code]
 *
 * Geprüft wird gegen bekannte Höhen (Bremer Marschland, Weserufer, Nordsee)
 * bzw. gegen die Mittelgebirge, wenn ein Paket für Hessen daliegt — und vor
 * allem, dass die Rechnung Länge/Breite → Rasterpunkt stimmt. Ein Versatz von
 * einer halben Kachel fällt sonst erst am fertigen Profil auf.
 */

import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { Container, HEADER_PROBE_BYTES, parseHeader } from '../apps/web/src/offline/container.js';
import { Terrain, elevationProfile } from '../apps/web/src/offline/terrain.js';

const dir = process.argv[2] ?? 'apps/api/maps';

let failed = 0;
const check = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

function load(path: string): Terrain {
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
  return new Terrain(new Container({ ...header, deflate: false }, merged.buffer));
}

/* ------------------------------------------------------------------ */

const bremenPath = join(dir, '04.terrain');
if (!existsSync(bremenPath)) {
  console.log(`Kein Höhenpaket unter ${bremenPath} — erst bauen:`);
  console.log('  node scripts/build-terrain.mjs --out ' + dir + ' 04');
  process.exit(0);
}

console.log('Bremen (04)');
const bremen = load(bremenPath);
console.log(`  Raster ${bremen.meta.width}×${bremen.meta.height}, Zoom ${bremen.meta.zoom}`);

/** Bekannte Orte mit ihrer ungefähren Höhe über NN. */
const spots: [string, number, number, number, number][] = [
  // Name, lat, lon, erwartet, erlaubte Abweichung
  ['Bremen Hbf', 53.0836, 8.8137, 6, 12],
  ['Bremen Marktplatz', 53.0758, 8.8072, 8, 12],
  ['Weserwehr Hastedt', 53.0629, 8.8672, 5, 12],
  ['Bremerhaven Hafen', 53.5396, 8.5809, 3, 12],
  ['Nordsee westlich Bremerhaven', 53.55, 8.45, 0, 15],
];
for (const [name, lat, lon, expected, tolerance] of spots) {
  const got = bremen.elevationAt(lat, lon);
  check(
    name,
    got != null && Math.abs(got - expected) <= tolerance,
    got == null ? 'kein Wert' : `${got.toFixed(1)} m (erwartet ~${expected} m)`,
  );
}

check('außerhalb des Rasters gibt es nichts', bremen.elevationAt(48.14, 11.58) === null);
check('Abdeckung wird gemeldet', bremen.covers(53.0836, 8.8137) && !bremen.covers(48.14, 11.58));

/* Nachbarpunkte dürfen nicht springen — das zeigt einen Versatz im Gitter. */
{
  let biggest = 0;
  for (let i = 0; i < 200; i++) {
    const lat = 53.05 + (i % 20) * 0.002;
    const lon = 8.75 + Math.floor(i / 20) * 0.002;
    const a = bremen.elevationAt(lat, lon);
    const b = bremen.elevationAt(lat + 0.0005, lon);
    if (a != null && b != null) biggest = Math.max(biggest, Math.abs(a - b));
  }
  check('benachbarte Punkte hängen zusammen', biggest < 20, `größter Sprung ${biggest.toFixed(1)} m auf 55 m`);
}

/* ------------------------------------------------------------------ */

console.log('\nProfil');
{
  // Eine Linie quer durch Bremen: flach, also darf kaum etwas zusammenkommen.
  const line: [number, number][] = [];
  for (let i = 0; i <= 40; i++) line.push([8.75 + i * 0.004, 53.05 + i * 0.002]);
  const profile = elevationProfile(line, bremen)!;
  check('Profil entsteht', !!profile && profile.points.length > 2, `${profile?.points.length} Punkte`);
  check('erster Punkt bei 0', profile.points[0]!.distanceM === 0);
  // Die Linie ist knapp 14 km lang (0,16° Länge und 0,08° Breite bei 53° N).
  const end = profile.points[profile.points.length - 1]!.distanceM;
  check('letzter Punkt am Ende', Math.abs(end - 13900) < 300, `${Math.round(end)} m`);
  check('Abstände wachsen streng', profile.points.every((p, i, a) => i === 0 || p.distanceM > a[i - 1]!.distanceM));
  check('Quelle ist das Raster', profile.source === 'terrain');
  check(
    'flaches Land ergibt wenig Höhenmeter',
    profile.gainM < 60,
    `${profile.gainM} m Anstieg / ${profile.lossM} m Abstieg, ${profile.minM}–${profile.maxM} m`,
  );

  // Höhen aus der Datei haben Vorrang und ergeben genau die Vorgabe.
  const own = line.map((_, i) => 100 + i * 10);
  const fromFile = elevationProfile(line, bremen, own)!;
  check('Datei-Höhen werden bevorzugt', fromFile.source === 'file');
  check(
    'Anstieg entspricht der Vorgabe',
    Math.abs(fromFile.gainM - 400) < 25 && fromFile.lossM === 0,
    `${fromFile.gainM} m statt 400 m`,
  );
  check('Spanne stimmt', fromFile.minM === 100 && fromFile.maxM === 500, `${fromFile.minM}–${fromFile.maxM}`);

  check('zu kurze Linie ergibt kein Profil', elevationProfile([[8.8, 53.07]], bremen) === null);
  check('ohne Raster und ohne Höhen kein Profil', elevationProfile(line, null) === null);
}

/* ------------------------------------------------------------------ */

const hessenPath = join(dir, '06.terrain');
if (existsSync(hessenPath)) {
  console.log('\nHessen (06) — Mittelgebirge');
  const hessen = load(hessenPath);
  const peaks: [string, number, number, number, number][] = [
    ['Großer Feldberg (Taunus)', 50.2325, 8.4553, 878, 60],
    ['Wasserkuppe (Rhön)', 50.4981, 9.9394, 950, 60],
    ['Frankfurt Hbf', 50.1069, 8.6634, 100, 25],
    ['Rhein bei Rüdesheim', 49.9786, 7.9256, 80, 30],
  ];
  for (const [name, lat, lon, expected, tolerance] of peaks) {
    const got = hessen.elevationAt(lat, lon);
    check(
      name,
      got != null && Math.abs(got - expected) <= tolerance,
      got == null ? 'kein Wert' : `${got.toFixed(0)} m (erwartet ~${expected} m)`,
    );
  }

  // Über den Feldberg: hier müssen echte Höhenmeter zusammenkommen.
  const line: [number, number][] = [];
  for (let i = 0; i <= 30; i++) line.push([8.38 + i * 0.005, 50.20 + i * 0.0025]);
  const profile = elevationProfile(line, hessen)!;
  check(
    'Anstieg über den Taunuskamm',
    profile.gainM > 150 && profile.maxM! > 500,
    `${profile.gainM} m Anstieg, Gipfel ${profile.maxM} m`,
  );
} else {
  console.log('\n(Kein Paket für Hessen — Mittelgebirgsprüfung übersprungen.)');
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen\n` : '\nAlle Prüfungen bestanden\n');
process.exit(failed ? 1 : 0);
