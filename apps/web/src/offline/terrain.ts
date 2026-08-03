/**
 * Höhenraster einer Region (Paketdatei `<code>.terrain`).
 *
 * Das Raster liegt im Kachelgitter der Quelle (Web Mercator, feste Zoomstufe),
 * gespeichert als Int16 in Metern mit **zeilenweisen Differenzen** — Nachbarn
 * unterscheiden sich um wenige Meter, dadurch packt der Container das Raster
 * um ein Vielfaches besser. Beim Laden wird einmal aufsummiert.
 *
 * Läuft im Worker (siehe worker.ts) und kommt ohne Browser-Bezug aus, damit es
 * sich in Node prüfen lässt.
 */

import type { Container } from './container.js';

export interface TerrainMeta {
  code: string;
  zoom: number;
  /** Kachel links oben. */
  tileX: number;
  tileY: number;
  width: number;
  height: number;
  noData: number;
}

/** Ein Punkt eines Höhenprofils. */
export interface ElevationPoint {
  /** Entfernung vom Anfang der Linie in Metern. */
  distanceM: number;
  /** Höhe in Metern, `null` wo das Raster nichts weiß. */
  eleM: number | null;
}

export interface ElevationProfile {
  points: ElevationPoint[];
  /** Summe aller Anstiege bzw. Abstiege in Metern. */
  gainM: number;
  lossM: number;
  minM: number | null;
  maxM: number | null;
  /** Woher die Höhen stammen. */
  source: 'terrain' | 'file';
}

export class Terrain {
  readonly meta: TerrainMeta;
  private grid: Int16Array;

  constructor(container: Container) {
    const meta = container.meta as unknown as TerrainMeta;
    this.meta = meta;
    const delta = container.section('elevation') as Int16Array;
    // Differenzen zurückrechnen. Der Überlauf beim Schreiben ist eindeutig,
    // weil die Summe wieder im Int16-Bereich landet.
    const grid = new Int16Array(delta.length);
    for (let y = 0; y < meta.height; y++) {
      let value = 0;
      const row = y * meta.width;
      for (let x = 0; x < meta.width; x++) {
        value = (value + delta[row + x]!) << 16 >> 16;
        grid[row + x] = value;
      }
    }
    this.grid = grid;
  }

  /** Rasterpunkt (x, y) — außerhalb und ohne Daten: null. */
  private at(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x >= this.meta.width || y >= this.meta.height) return null;
    const value = this.grid[y * this.meta.width + x]!;
    return value === this.meta.noData ? null : value;
  }

  /**
   * Höhe an einem Ort, bilinear zwischen den vier Nachbarn. Fehlt einer
   * (Rand der Abdeckung), zählt der nächstgelegene vorhandene Wert — sonst
   * bekäme eine Küstenlinie Löcher.
   */
  elevationAt(lat: number, lon: number): number | null {
    const scale = 2 ** this.meta.zoom;
    const gx = (((lon + 180) / 360) * scale - this.meta.tileX) * 256 - 0.5;
    const r = (lat * Math.PI) / 180;
    const gy =
      (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale - this.meta.tileY) * 256 - 0.5;

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const corners = [
      { v: this.at(x0, y0), w: (1 - fx) * (1 - fy) },
      { v: this.at(x0 + 1, y0), w: fx * (1 - fy) },
      { v: this.at(x0, y0 + 1), w: (1 - fx) * fy },
      { v: this.at(x0 + 1, y0 + 1), w: fx * fy },
    ];
    let sum = 0;
    let weight = 0;
    for (const c of corners) {
      if (c.v == null) continue;
      sum += c.v * c.w;
      weight += c.w;
    }
    return weight > 0 ? sum / weight : null;
  }

  /** Deckt das Raster diesen Punkt ab? */
  covers(lat: number, lon: number): boolean {
    return this.elevationAt(lat, lon) != null;
  }
}

/** Abstand zweier Punkte in Metern (Haversine). */
function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const RAD = Math.PI / 180;
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Höchstzahl der Profilpunkte — mehr als das zeigt kein Bildschirm. */
const MAX_SAMPLES = 300;
/**
 * Anstiege unter dieser Schwelle zählen nicht.
 *
 * Ohne sie summiert sich das Rauschen des Rasters zu Fantasiewerten: Eine
 * flache Fahrt durch Bremen käme sonst auf dreistellige Höhenmeter, weil
 * jeder Rasterpunkt um ein, zwei Meter schwankt.
 */
const NOISE_M = 4;

/**
 * Höhenprofil einer Linie. Abgetastet wird in gleichen Abständen, damit die
 * Kurve nicht dort dicht wird, wo zufällig viele Stützpunkte liegen.
 *
 * `own` sind Höhen aus der Datei selbst (GPX bringt oft welche mit) — die
 * haben Vorrang vor dem Raster, weil sie am Gerät gemessen wurden.
 */
export function elevationProfile(
  line: [number, number][],
  terrain: Terrain | null,
  own?: (number | undefined)[],
): ElevationProfile | null {
  if (line.length < 2) return null;

  const cum = [0];
  for (let i = 1; i < line.length; i++) {
    cum.push(cum[i - 1]! + distanceM(line[i - 1]![1], line[i - 1]![0], line[i]![1], line[i]![0]));
  }
  const total = cum[cum.length - 1]!;
  if (total <= 0) return null;

  const useOwn = !!own && own.filter((e) => e != null).length >= line.length / 2;
  if (!useOwn && !terrain) return null;

  const count = Math.min(MAX_SAMPLES, Math.max(2, line.length));
  const points: ElevationPoint[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (cursor < line.length - 2 && cum[cursor + 1]! < target) cursor++;
    const span = cum[cursor + 1]! - cum[cursor]!;
    const t = span > 0 ? (target - cum[cursor]!) / span : 0;
    const a = line[cursor]!;
    const b = line[cursor + 1] ?? a;
    const lon = a[0] + (b[0] - a[0]) * t;
    const lat = a[1] + (b[1] - a[1]) * t;
    let ele: number | null;
    if (useOwn) {
      const ea = own![cursor];
      const eb = own![cursor + 1] ?? ea;
      ele = ea == null ? null : eb == null ? ea : ea + (eb - ea) * t;
    } else {
      ele = terrain!.elevationAt(lat, lon);
    }
    points.push({ distanceM: target, eleM: ele == null ? null : Math.round(ele * 10) / 10 });
  }

  let gainM = 0;
  let lossM = 0;
  let minM: number | null = null;
  let maxM: number | null = null;
  let reference: number | null = null;
  for (const p of points) {
    if (p.eleM == null) continue;
    if (minM == null || p.eleM < minM) minM = p.eleM;
    if (maxM == null || p.eleM > maxM) maxM = p.eleM;
    if (reference == null) {
      reference = p.eleM;
      continue;
    }
    const change = p.eleM - reference;
    if (change > NOISE_M) {
      gainM += change;
      reference = p.eleM;
    } else if (change < -NOISE_M) {
      lossM -= change;
      reference = p.eleM;
    }
  }

  return {
    points,
    gainM: Math.round(gainM),
    lossM: Math.round(lossM),
    minM: minM == null ? null : Math.round(minM),
    maxM: maxM == null ? null : Math.round(maxM),
    source: useOwn ? 'file' : 'terrain',
  };
}
