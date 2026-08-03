#!/usr/bin/env node
/**
 * Baut die **Höhenpakete** (`<code>.terrain`) je Bundesland.
 *
 *   node scripts/build-terrain.mjs [--out apps/api/maps] [--zoom 10] [codes…]
 *
 * Quelle sind die freien **Terrain Tiles** aus dem AWS-Open-Data-Programm
 * (`elevation-tiles-prod`, „terrarium"-Kodierung, aus SRTM/3DEP/GMTED u. a.).
 * Sie sind gewöhnliche PNG: Höhe = (R·256 + G + B/256) − 32768 Meter.
 *
 * Herausgeschrieben wird ein Höhenraster im **Kachelgitter selbst** (Web
 * Mercator, Zoomstufe `--zoom`) als Int16 — dadurch ist keine Umprojektion
 * nötig, und die App rechnet beim Nachschlagen nur Längen-/Breitengrad in
 * Kachelkoordinaten um.
 *
 * Warum überhaupt ein eigenes Paket? Weil das Höhenprofil sonst online sein
 * müsste. Wer keins braucht, lädt es nicht herunter — die Datei steht neben
 * Karte, Routing und Suche und ist einzeln abwählbar.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './lib/png.mjs';
import { writeContainer } from './lib/container.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kachelquelle. Über TERRAIN_BASE austauschbar (z. B. ein eigener Spiegel). */
const BASE = process.env.TERRAIN_BASE ?? 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
/** Kachel-Zwischenlager, damit ein zweiter Lauf nichts erneut lädt. */
const CACHE = process.env.TERRAIN_CACHE ?? '/tmp/lagebild-terrain';
/** Höhe für „kein Wert" (Meer außerhalb der Abdeckung). */
export const NO_DATA = -32768;

/* ------------------------------------------------------------------ *
 * Kachelrechnung (Web Mercator)
 * ------------------------------------------------------------------ */

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/* ------------------------------------------------------------------ *
 * Kacheln holen
 * ------------------------------------------------------------------ */

async function fetchTile(z, x, y) {
  const path = join(CACHE, `${z}`, `${x}`, `${y}.png`);
  try {
    return await readFile(path);
  } catch {
    /* noch nicht im Zwischenlager */
  }
  const url = `${BASE}/${z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'lagebild-build/1.0' } });
      if (res.status === 404) return null; // außerhalb der Abdeckung
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buf);
      return buf;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Ein Bundesland bauen
 * ------------------------------------------------------------------ */

async function buildRegion(code, bbox, zoom, outDir) {
  const [west, south, east, north] = bbox;
  const x0 = Math.floor(lonToTileX(west, zoom));
  const x1 = Math.floor(lonToTileX(east, zoom));
  const y0 = Math.floor(latToTileY(north, zoom)); // Norden = kleines y
  const y1 = Math.floor(latToTileY(south, zoom));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const width = cols * 256;
  const height = rows * 256;
  const grid = new Int16Array(width * height).fill(NO_DATA);

  process.stdout.write(`  ${code}: ${cols}×${rows} Kacheln (${width}×${height} Punkte) `);
  let loaded = 0;
  let missing = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const png = await fetchTile(zoom, tx, ty);
      if (!png) {
        missing++;
        continue;
      }
      const { width: tw, height: th, channels, data } = decodePng(png);
      if (tw !== 256 || th !== 256) throw new Error(`Kachel ${tx}/${ty} ist ${tw}×${th}`);
      const baseX = (tx - x0) * 256;
      const baseY = (ty - y0) * 256;
      for (let py = 0; py < 256; py++) {
        const row = (baseY + py) * width + baseX;
        for (let px = 0; px < 256; px++) {
          const i = (py * 256 + px) * channels;
          // terrarium: Höhe = R·256 + G + B/256 − 32768. Das Byte B ist der
          // Bruchteil; für ein Höhenprofil reicht der ganze Meter.
          grid[row + px] = data[i] * 256 + data[i + 1] - 32768;
        }
      }
      loaded++;
      if (loaded % 25 === 0) process.stdout.write('.');
    }
  }
  process.stdout.write(` ${loaded} geladen${missing ? `, ${missing} ohne Daten` : ''}\n`);

  // Zeilenweise Differenzen: Nachbarpunkte unterscheiden sich um wenige Meter,
  // dadurch packt deflate das Raster um ein Vielfaches besser.
  const delta = new Int16Array(grid.length);
  for (let y = 0; y < height; y++) {
    let previous = 0;
    for (let x = 0; x < width; x++) {
      const value = grid[y * width + x];
      // Der Überlauf ist gewollt und beim Lesen wieder eindeutig.
      delta[y * width + x] = (value - previous) << 16 >> 16;
      previous = value;
    }
  }

  const path = join(outDir, `${code}.terrain`);
  await writeContainer(
    path,
    {
      format: 'terrain',
      code,
      zoom,
      tileX: x0,
      tileY: y0,
      cols,
      rows,
      width,
      height,
      noData: NO_DATA,
      encoding: 'row-delta',
      source: 'AWS Terrain Tiles (elevation-tiles-prod, terrarium)',
      built: new Date().toISOString(),
    },
    [{ name: 'elevation', data: delta }],
  );
  const size = (await stat(path)).size;
  console.log(`  ${code}: ${path} — ${(size / 1_048_576).toFixed(1)} MB`);
}

/* ------------------------------------------------------------------ *
 * Aufruf
 * ------------------------------------------------------------------ */

/** Die Rechtecke der Bundesländer stehen (einmalig) in stateBounds.ts. */
async function loadBounds() {
  const src = await readFile(join(HERE, '..', 'apps', 'web', 'src', 'stateBounds.ts'), 'utf8');
  const out = {};
  // Zeilen der Form:  '04': [8.49, 53.01, 8.99, 53.63],
  for (const m of src.matchAll(/'(\d{2})':\s*\[([-\d.,\s]+)\]/g)) {
    const nums = m[2].split(',').map((n) => Number(n.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite)) out[m[1]] = nums;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  let outDir = 'apps/api/maps';
  let zoom = 10;
  const codes = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outDir = args[++i];
    else if (args[i] === '--zoom') zoom = Number(args[++i]);
    else codes.push(args[i]);
  }

  const bounds = await loadBounds();
  const list = codes.length ? codes : Object.keys(bounds).sort();
  await mkdir(outDir, { recursive: true });

  console.log(
    `Höhenpakete aus ${BASE} (Zoom ${zoom} ≈ ${Math.round((156543 * Math.cos((51 * Math.PI) / 180)) / 2 ** zoom)} m je Punkt)`,
  );
  for (const code of list) {
    const bbox = bounds[code];
    if (!bbox) {
      console.log(`  ${code}: kein Rechteck bekannt — übersprungen`);
      continue;
    }
    await buildRegion(code, bbox, zoom, outDir);
  }
  console.log('\nQuellenangabe nicht vergessen: AWS Terrain Tiles / Mapzen, Daten u. a. SRTM (NASA) und 3DEP (USGS).');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
