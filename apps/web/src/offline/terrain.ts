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
  sample(x: number, y: number): number | null {
    return this.at(x, y);
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

/* ------------------------------------------------------------------ *
 * Geländebild für die Kartenebene
 * ------------------------------------------------------------------ */

export interface TerrainImage {
  width: number;
  height: number;
  /** RGBA, Zeile für Zeile — wird im Hauptfaden auf eine Leinwand gelegt. */
  rgba: Uint8ClampedArray;
  /** [west, süd, ost, nord] des Rasters. */
  bounds: [number, number, number, number];
}

/** Höhenstufen der Einfärbung (Meter → Farbe), dazwischen wird gemischt. */
const RAMP: [number, [number, number, number]][] = [
  [0, [172, 208, 165]],
  [100, [199, 219, 154]],
  [300, [229, 224, 154]],
  [600, [222, 195, 141]],
  [1000, [196, 158, 121]],
  [1600, [186, 160, 148]],
  [2400, [235, 235, 240]],
  [3500, [255, 255, 255]],
];

function rampColor(ele: number): [number, number, number] {
  if (ele <= RAMP[0]![0]) return RAMP[0]![1];
  for (let i = 1; i < RAMP.length; i++) {
    if (ele > RAMP[i]![0]) continue;
    const [e0, c0] = RAMP[i - 1]!;
    const [e1, c1] = RAMP[i]!;
    const t = (ele - e0) / (e1 - e0);
    return [
      c0[0] + (c1[0] - c0[0]) * t,
      c0[1] + (c1[1] - c0[1]) * t,
      c0[2] + (c1[2] - c0[2]) * t,
    ];
  }
  return RAMP[RAMP.length - 1]![1];
}

const tileToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileToLat = (y: number, z: number) => {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * Geländebild: Höhenfarben plus **Schummerung** (Licht von Nordwesten, 45°
 * hoch — so sind Reliefkarten seit jeher gezeichnet, und das Auge liest die
 * Form dann richtig herum).
 *
 * Das Raster liegt bereits in Web Mercator, also genau in der Projektion, in
 * der MapLibre eine `image`-Quelle aufspannt — es braucht keine Umrechnung je
 * Bildzeile wie bei den Gittern in Länge/Breite.
 */
export function renderTerrain(terrain: Terrain, maxSize = 1024): TerrainImage {
  const { width: srcW, height: srcH, zoom, tileX, tileY } = terrain.meta;
  const step = Math.max(1, Math.ceil(Math.max(srcW, srcH) / maxSize));
  const width = Math.floor(srcW / step);
  const height = Math.floor(srcH / step);
  const rgba = new Uint8ClampedArray(width * height * 4);

  // Kantenlänge einer Zelle in Metern — ohne sie hinge die Steilheit von der
  // geographischen Breite ab und die Alpen sähen flacher aus als der Harz.
  const midLat = tileToLat(tileY + srcH / 512, zoom);
  const cell = ((156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** zoom) * step;

  const raw = (x: number, y: number): number | null => {
    const sx = Math.min(srcW - 1, x * step);
    const sy = Math.min(srcH - 1, y * step);
    return terrain.sample(sx, sy);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = raw(x, y);
      const at = (y * width + x) * 4;
      if (here == null) {
        rgba[at + 3] = 0; // Meer und Randbereiche bleiben durchsichtig
        continue;
      }
      const left = raw(Math.max(0, x - 1), y) ?? here;
      const right = raw(Math.min(width - 1, x + 1), y) ?? here;
      const up = raw(x, Math.max(0, y - 1)) ?? here;
      const down = raw(x, Math.min(height - 1, y + 1)) ?? here;

      // Neigung in x- und y-Richtung; y zeigt nach Süden, deshalb umgekehrt.
      const dzdx = (right - left) / (2 * cell);
      const dzdy = (up - down) / (2 * cell);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      // Sonne aus Nordwesten (315°), 45° über dem Horizont.
      const azimuth = (Math.PI * 5) / 4;
      const zenith = Math.PI / 4;
      const shade =
        Math.cos(zenith) * Math.cos(slope) +
        Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);

      const [r, g, b] = rampColor(here);
      // Die Schummerung hellt auf und dunkelt ab, überzeichnet die Farbe aber
      // nicht — sonst verschwindet die Höhenstufe im Schatten.
      const factor = 0.55 + 0.75 * Math.max(0, Math.min(1, shade));
      rgba[at] = r * factor;
      rgba[at + 1] = g * factor;
      rgba[at + 2] = b * factor;
      rgba[at + 3] = 255;
    }
  }

  return {
    width,
    height,
    rgba,
    bounds: [
      tileToLon(tileX, zoom),
      tileToLat(tileY + srcH / 256, zoom),
      tileToLon(tileX + srcW / 256, zoom),
      tileToLat(tileY, zoom),
    ],
  };
}

/**
 * Was noch vor einem liegt: Anstieg und Abstieg ab einer bestimmten Stelle der
 * Strecke. Während der Fahrt zählt genau das — die Gesamtsumme sagt am Berg
 * nichts mehr.
 */
export function remainingClimb(profile: ElevationProfile, fromM: number): { gainM: number; lossM: number } {
  let gainM = 0;
  let lossM = 0;
  let reference: number | null = null;
  for (const p of profile.points) {
    if (p.distanceM < fromM || p.eleM == null) continue;
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
  return { gainM: Math.round(gainM), lossM: Math.round(lossM) };
}
