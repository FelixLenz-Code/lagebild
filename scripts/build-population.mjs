#!/usr/bin/env node
/**
 * Baut die **Bevölkerungspakete** (`<code>.pop`) je Bundesland.
 *
 *   node scripts/build-population.mjs [--csv <datei>] [--out apps/api/maps] [codes…]
 *
 * Quelle ist das **Bevölkerungsgitter des Zensus 2022** (Statistisches
 * Bundesamt, Datenlizenz Deutschland Namensnennung 2.0):
 * `Zensus2022_Bevoelkerungszahl.zip` → `Zensus2022_Bevoelkerungszahl_100m-Gitter.csv`
 * mit 3,09 Millionen bewohnten Zellen, Spalten `GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner`.
 *
 * **Warum das Gitter unverändert übernommen wird:** Es liegt in EPSG:3035
 * (ETRS89-LAEA), und diese Projektion ist *flächentreu* — eine Zelle ist
 * überall gleich groß. In Web Mercator wäre eine Zelle in Flensburg deutlich
 * größer als eine in München, und eine Summe über eine gezeichnete Fläche
 * hinge davon ab, wo man zeichnet. Gerechnet wird deshalb im Gitter selbst;
 * die App rechnet nur die Abfragegeometrie hinein.
 *
 * Herausgeschrieben wird ein dichtes Uint16-Raster je Bundesland. Dicht klingt
 * verschwenderisch — die allermeisten Zellen sind unbewohnt und damit null —,
 * aber genau das packt deflate auf einen Bruchteil zusammen, und die App kann
 * ohne jede Suchstruktur direkt in das Raster greifen.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeContainer } from './lib/container.mjs';
import { toLaea, fromLaea } from './lib/laea.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kantenlänge einer Gitterzelle in Metern. */
const CELL = 100;
/** Sicherheitsrand um das Bundesland-Rechteck (Meter). */
const MARGIN = 5000;

async function loadBounds() {
  const src = await readFile(join(HERE, '..', 'apps', 'web', 'src', 'stateBounds.ts'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/'(\d{2})':\s*\[([-\d.,\s]+)\]/g)) {
    const nums = m[2].split(',').map((n) => Number(n.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite)) out[m[1]] = nums;
  }
  return out;
}

/**
 * Umschließendes Rechteck eines Länder-Rechtecks in LAEA.
 *
 * Ein Rechteck in Grad ist in LAEA **kein** Rechteck — die Ränder sind leicht
 * gekrümmt. Deshalb wird der Rand abgetastet und nicht nur die vier Ecken
 * genommen; sonst fehlten in der Mitte der langen Seiten ein paar hundert Meter.
 */
function laeaBox([west, south, east, north]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const fx = west + ((east - west) * i) / steps;
    const fy = south + ((north - south) * i) / steps;
    for (const [lat, lon] of [
      [south, fx],
      [north, fx],
      [fy, west],
      [fy, east],
    ]) {
      const [x, y] = toLaea(lat, lon);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const snap = (v, dir) => (dir < 0 ? Math.floor((v - MARGIN) / CELL) : Math.ceil((v + MARGIN) / CELL)) * CELL;
  return { x0: snap(x0, -1), y0: snap(y0, -1), x1: snap(x1, 1), y1: snap(y1, 1) };
}

/** Die ganze CSV einmal in kompakte Felder lesen (rund 31 MB). */
async function readGrid(csvPath) {
  const xs = [];
  const ys = [];
  const ps = [];
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      if (/GITTER_ID/i.test(line)) continue;
    }
    if (!line) continue;
    // GITTER_ID;x_mp;y_mp;Einwohner — die Kennung selbst wird nicht gebraucht,
    // die Mittelpunktkoordinaten stehen ohnehin daneben.
    const a = line.indexOf(';');
    const b = line.indexOf(';', a + 1);
    const c = line.indexOf(';', b + 1);
    if (a < 0 || b < 0 || c < 0) continue;
    const x = Number(line.slice(a + 1, b));
    const y = Number(line.slice(b + 1, c));
    const p = Number(line.slice(c + 1));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p) || p <= 0) continue;
    xs.push(x);
    ys.push(y);
    ps.push(p);
  }
  return {
    x: Int32Array.from(xs),
    y: Int32Array.from(ys),
    p: Uint16Array.from(ps.map((v) => Math.min(65535, v))),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let csvPath = process.env.ZENSUS_CSV ?? '/tmp/Zensus2022_Bevoelkerungszahl_100m-Gitter.csv';
  let outDir = 'apps/api/maps';
  const codes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--csv') csvPath = args[++i];
    else if (args[i] === '--out') outDir = args[++i];
    else if (/^\d{2}$/.test(args[i])) codes.push(args[i]);
  }

  try {
    await stat(csvPath);
  } catch {
    console.error(
      `Gitterdatei nicht gefunden: ${csvPath}\n` +
        'Herunterladen und entpacken:\n' +
        '  curl -sLo /tmp/zensus.zip https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip\n' +
        '  unzip -o /tmp/zensus.zip Zensus2022_Bevoelkerungszahl_100m-Gitter.csv -d /tmp',
    );
    process.exit(1);
  }

  const bounds = await loadBounds();
  const list = codes.length ? codes : Object.keys(bounds).sort();
  await mkdir(outDir, { recursive: true });

  console.log(`Gitter lesen: ${csvPath}`);
  const t0 = Date.now();
  const grid = await readGrid(csvPath);
  console.log(`  ${grid.p.length.toLocaleString('de-DE')} bewohnte Zellen in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  for (const code of list) {
    const bbox = bounds[code];
    if (!bbox) {
      console.warn(`  ${code}: kein Rechteck bekannt — übersprungen`);
      continue;
    }
    const box = laeaBox(bbox);
    const width = (box.x1 - box.x0) / CELL;
    const height = (box.y1 - box.y0) / CELL;
    const raster = new Uint16Array(width * height);

    let people = 0;
    let cells = 0;
    for (let i = 0; i < grid.p.length; i++) {
      const x = grid.x[i];
      const y = grid.y[i];
      if (x < box.x0 || x >= box.x1 || y < box.y0 || y >= box.y1) continue;
      const cx = Math.floor((x - box.x0) / CELL);
      // Zeile 0 liegt im **Norden**, wie bei den anderen Rastern des Projekts.
      const cy = Math.floor((box.y1 - y) / CELL);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      raster[cy * width + cx] = grid.p[i];
      people += grid.p[i];
      cells++;
    }

    const [southLat, westLon] = fromLaea(box.x0, box.y0);
    const [northLat, eastLon] = fromLaea(box.x1, box.y1);
    const path = join(outDir, `${code}.pop`);
    await writeContainer(
      path,
      {
        format: 'pop',
        code,
        crs: 'EPSG:3035',
        cell: CELL,
        x0: box.x0,
        y0: box.y0,
        width,
        height,
        people,
        cells,
        // Grobe Ausdehnung in Grad, nur zur Anzeige.
        bbox: [westLon, southLat, eastLon, northLat],
        source: 'Zensus 2022, Statistisches Bundesamt (dl-de/by-2-0)',
      },
      [{ name: 'pop', data: raster }],
    );
    const size = (await stat(path)).size;
    console.log(
      `  ${code}: ${width}×${height} Zellen, ${people.toLocaleString('de-DE')} Einwohner in ` +
        `${cells.toLocaleString('de-DE')} Zellen → ${(size / 1024 / 1024).toFixed(2)} MB`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
