#!/usr/bin/env node
/**
 * Holt Schriften und Symbole der Basiskarte ins eigene Bundle.
 *
 * Bisher lud die Karte beides von `protomaps.github.io`. Der Service Worker
 * hebt es auf, **nachdem** es einmal geladen wurde — bei einem kalten Start
 * ohne Netz stand die Offline-Karte deshalb ohne einen einzigen Namen da:
 * Länder, Städte, Straßen alles stumm.
 *
 * Deshalb liegen die Dateien jetzt unter `apps/web/public/basemaps/` und
 * wandern beim Bauen in den Vorrat des Service Workers. Sie kommen aus dem
 * Protomaps-Assets-Verzeichnis (Noto Sans, SIL Open Font License; Symbole
 * CC0/MIT — siehe dort).
 *
 * Aufruf:
 *   node scripts/fetch-basemap-assets.mjs            # nur was fehlt
 *   node scripts/fetch-basemap-assets.mjs --force    # alles neu
 *   RANGES=0-255,256-511 node scripts/…              # eigene Zeichenbereiche
 *
 * Das Skript ist absichtlich nachsichtig: Ohne Netz bricht es nicht ab,
 * sondern meldet, was fehlt — die App fällt dann zur Laufzeit auf das
 * Protomaps-Verzeichnis zurück.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://protomaps.github.io/basemaps-assets';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/web/public/basemaps');

/** Die Schriftsätze, die der Kartenstil anfordert. */
const FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];

/**
 * Zeichenbereiche. Voreingestellt ist, was in Europa auf einer Karte vorkommt:
 * Latein mit allen Erweiterungen, Griechisch, Kyrillisch, Satzzeichen. Der
 * ganze Unicode-Raum wären 256 Bereiche je Schriftsatz — dreistellige
 * Megabyte für Schriftzeichen, die auf dieser Karte nie gebraucht werden.
 */
const DEFAULT_RANGES = [
  '0-255',
  '256-511',
  '512-767',
  '768-1023',
  '1024-1279',
  '1280-1535',
  '7680-7935',
  '8192-8447',
];

/** Symbolsätze: je Kartenstil eine Fassung, jeweils einfach und doppelt fein. */
const SPRITES = ['grayscale', 'dark'].flatMap((name) => [
  `sprites/v4/${name}.json`,
  `sprites/v4/${name}.png`,
  `sprites/v4/${name}@2x.json`,
  `sprites/v4/${name}@2x.png`,
]);

const force = process.argv.includes('--force');
const ranges = (process.env.RANGES ?? DEFAULT_RANGES.join(',')).split(',').map((r) => r.trim());

const files = [
  ...FONTSTACKS.flatMap((stack) => ranges.map((r) => `fonts/${stack}/${r}.pbf`)),
  ...SPRITES,
];

let geholt = 0;
let vorhanden = 0;
let bytes = 0;
const fehler = [];

for (const rel of files) {
  const ziel = join(OUT, rel);
  if (!force) {
    try {
      const s = await stat(ziel);
      if (s.size > 0) {
        vorhanden++;
        bytes += s.size;
        continue;
      }
    } catch {
      /* nicht da — also holen */
    }
  }
  // Der Pfad enthält Leerzeichen („Noto Sans Regular"); die URL braucht sie kodiert.
  const url = `${BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(ziel), { recursive: true });
    await writeFile(ziel, data);
    geholt++;
    bytes += data.length;
  } catch (err) {
    fehler.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const mb = (n) => `${(n / 1e6).toFixed(1).replace('.', ',')} MB`;
console.log(`Kartenschriften und -symbole in ${OUT}`);
console.log(`  neu geladen: ${geholt}   schon da: ${vorhanden}   zusammen: ${mb(bytes)}`);
if (fehler.length) {
  console.log(`  nicht erhalten: ${fehler.length}`);
  for (const f of fehler.slice(0, 5)) console.log(`    ${f}`);
  console.log('  Die App nimmt dafür zur Laufzeit das Protomaps-Verzeichnis — dann aber nur online.');
}
