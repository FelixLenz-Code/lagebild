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

/* ------------------------------------------------------------------ */
/* Sichtverbindung                                                      */
/* ------------------------------------------------------------------ */

/** Ein Punkt des Geländeschnitts zwischen zwei Stellen. */
export interface SightPoint {
  distanceM: number;
  /** Geländehöhe. */
  groundM: number | null;
  /** Höhe der Sichtlinie an dieser Stelle (Antenne zu Antenne). */
  lineM: number;
  /** Untere Grenze der ersten Fresnelzone. */
  fresnelM: number;
}

export interface SightResult {
  points: SightPoint[];
  distanceM: number;
  /** Freie Sicht, nur die Fresnelzone angeschnitten, oder verdeckt? */
  verdict: 'frei' | 'angeschnitten' | 'verdeckt';
  /** Stelle des schlimmsten Hindernisses. */
  worst: { distanceM: number; overM: number; lat: number; lon: number } | null;
  /** Wie hoch die Antenne am Anfang stehen müsste, damit es frei wird. */
  neededHeightM: number | null;
  fromEleM: number | null;
  toEleM: number | null;
}

/** Erdradius mit Refraktion (k = 4/3) — so rechnet die Funktechnik. */
const EFFECTIVE_EARTH_M = 6371008.8 * (4 / 3);
/** Lichtgeschwindigkeit in Metern je Sekunde, für die Wellenlänge. */
const C = 299792458;

/**
 * Sieht Punkt A den Punkt B — über das Gelände hinweg?
 *
 * Zwei Dinge, die man ohne Rechnung falsch macht: Die **Erdkrümmung** nimmt
 * über 20 km schon zwanzig Meter weg, und eine Funkstrecke braucht mehr als die
 * nackte Sichtlinie. Um sie herum liegt die **erste Fresnelzone**, ein
 * Rotationsellipsoid; ragt Gelände hinein, dämpft es, auch wenn „man sieht sich"
 * noch stimmt. Deshalb gibt es hier drei Urteile statt zwei.
 *
 * Das Geländemodell kennt weder Wald noch Häuser — im Zweifel steht mehr im Weg
 * als hier steht. Das Blatt sagt das auch.
 */
export function sightLine(
  terrain: Terrain,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  options: { fromHeightM?: number; toHeightM?: number; freqMHz?: number; samples?: number } = {},
): SightResult | null {
  const total = distanceM(from.lat, from.lon, to.lat, to.lon);
  if (total < 1) return null;
  const fromEle = terrain.elevationAt(from.lat, from.lon);
  const toEle = terrain.elevationAt(to.lat, to.lon);
  if (fromEle == null || toEle == null) return null;

  const hFrom = fromEle + (options.fromHeightM ?? 2);
  const hTo = toEle + (options.toHeightM ?? 2);
  const wavelength = options.freqMHz ? C / (options.freqMHz * 1e6) : null;
  const count = Math.max(32, Math.min(options.samples ?? 400, 1200));

  const points: SightPoint[] = [];
  let worst: SightResult['worst'] = null;
  let fresnelCut = false;
  /** Größter Betrag, um den die Sichtlinie angehoben werden müsste. */
  let needed = 0;

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const d = total * t;
    const lat = from.lat + (to.lat - from.lat) * t;
    const lon = from.lon + (to.lon - from.lon) * t;
    const raw = terrain.elevationAt(lat, lon);
    // Die Erde fällt unter der Sehne weg — das hilft der Sicht, deshalb wird
    // die Geländehöhe um diesen Betrag abgesenkt.
    const drop = (d * (total - d)) / (2 * EFFECTIVE_EARTH_M);
    const ground = raw == null ? null : raw - drop;
    const line = hFrom + (hTo - hFrom) * t;
    // Radius der ersten Fresnelzone an dieser Stelle.
    const radius = wavelength ? Math.sqrt((wavelength * d * (total - d)) / total) : 0;
    const fresnel = line - radius * 0.6;

    points.push({
      distanceM: d,
      groundM: ground == null ? null : Math.round(ground * 10) / 10,
      lineM: Math.round(line * 10) / 10,
      fresnelM: Math.round(fresnel * 10) / 10,
    });

    if (ground == null || i === 0 || i === count - 1) continue;
    if (ground > fresnel) fresnelCut = true;
    const over = ground - line;
    if (over > 0 && (!worst || over > worst.overM)) {
      worst = { distanceM: d, overM: Math.round(over * 10) / 10, lat, lon };
    }
    // Wie viel höher müsste A stehen, damit die Linie hier vorbeikommt? Die
    // Linie kippt um B, deshalb der Faktor 1/(1−t).
    if (over > 0 && t < 1) needed = Math.max(needed, over / (1 - t));
  }

  return {
    points,
    distanceM: Math.round(total),
    verdict: worst ? 'verdeckt' : fresnelCut ? 'angeschnitten' : 'frei',
    worst,
    neededHeightM: worst ? Math.ceil(needed) : null,
    fromEleM: Math.round(fromEle),
    toEleM: Math.round(toEle),
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

/* ------------------------------------------------------------------ *
 * Höhenlinien
 * ------------------------------------------------------------------ */

export interface ContourLine {
  eleM: number;
  /** Linienzüge in [lon, lat]. */
  paths: [number, number][][];
}

/** Abstand der Höhenlinien je nach Relief im Ausschnitt. */
export function contourInterval(spanM: number): number {
  if (spanM < 60) return 5;
  if (spanM < 150) return 10;
  if (spanM < 400) return 20;
  if (spanM < 900) return 50;
  return 100;
}

/**
 * Höhenlinien aus dem Raster — **Marching Squares**.
 *
 * Für jede Rasterzelle wird geprüft, welche ihrer vier Ecken über der
 * gesuchten Höhe liegen; daraus ergibt sich ein Muster von 16 Fällen und darin
 * ein oder zwei Liniensegmente. Die Schnittpunkte werden zwischen den Ecken
 * linear interpoliert, sonst bekämen die Linien Treppen.
 *
 * Die Segmente werden anschließend an ihren Enden zu Zügen verkettet — sonst
 * wären es zehntausende Zweipunktlinien, und MapLibre könnte sie weder
 * beschriften noch sauber zeichnen.
 */
export function contourLines(
  terrain: Terrain,
  bbox: { west: number; south: number; east: number; north: number },
  intervalM: number,
  maxCells = 240_000,
): ContourLine[] {
  const { zoom, tileX, tileY, width, height } = terrain.meta;
  const scale = 2 ** zoom;
  // Ausschnitt in Rasterkoordinaten.
  const gx = (lon: number) => (((lon + 180) / 360) * scale - tileX) * 256;
  const gy = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale - tileY) * 256;
  };
  const lonOf = (x: number) => ((x / 256 + tileX) / scale) * 360 - 180;
  const latOf = (y: number) => {
    const n = Math.PI - 2 * Math.PI * ((y / 256 + tileY) / scale);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  const x0 = Math.max(0, Math.floor(gx(bbox.west)) - 1);
  const x1 = Math.min(width - 1, Math.ceil(gx(bbox.east)) + 1);
  const y0 = Math.max(0, Math.floor(gy(bbox.north)) - 1);
  const y1 = Math.min(height - 1, Math.ceil(gy(bbox.south)) + 1);
  if (x1 - x0 < 2 || y1 - y0 < 2) return [];
  // Bei sehr weitem Ausschnitt gröber abtasten, statt gar nichts zu liefern.
  const step = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / maxCells)));

  let min = Infinity;
  let max = -Infinity;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const v = terrain.sample(x, y);
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];

  const out: ContourLine[] = [];
  const first = Math.ceil(min / intervalM) * intervalM;
  for (let level = first; level <= max; level += intervalM) {
    const segments: [number, number, number, number][] = [];
    for (let y = y0; y + step <= y1; y += step) {
      for (let x = x0; x + step <= x1; x += step) {
        const a = terrain.sample(x, y);
        const b = terrain.sample(x + step, y);
        const c = terrain.sample(x + step, y + step);
        const d = terrain.sample(x, y + step);
        if (a == null || b == null || c == null || d == null) continue;

        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (code === 0 || code === 15) continue;

        // Schnittpunkte auf den vier Kanten (oben, rechts, unten, links).
        const mix = (v1: number, v2: number) => (level - v1) / (v2 - v1 || 1e-9);
        const top: [number, number] = [x + step * mix(a, b), y];
        const right: [number, number] = [x + step, y + step * mix(b, c)];
        const bottom: [number, number] = [x + step * mix(d, c), y + step];
        const left: [number, number] = [x, y + step * mix(a, d)];

        const add = (p: [number, number], q: [number, number]) =>
          segments.push([p[0], p[1], q[0], q[1]]);
        switch (code) {
          case 1: case 14: add(left, bottom); break;
          case 2: case 13: add(bottom, right); break;
          case 3: case 12: add(left, right); break;
          case 4: case 11: add(top, right); break;
          case 6: case 9: add(top, bottom); break;
          case 7: case 8: add(left, top); break;
          // Sattelpunkte: zwei getrennte Segmente.
          case 5: add(left, top); add(bottom, right); break;
          case 10: add(top, right); add(left, bottom); break;
          default: break;
        }
      }
    }
    if (!segments.length) continue;

    // Segmente an ihren Enden zu Zügen verketten (Schlüssel gerundet, weil die
    // Schnittpunkte zweier Nachbarzellen nur bis auf Rechengenauigkeit gleich sind).
    const key = (x: number, y: number) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
    const open = new Map<string, [number, number][][]>();
    const push = (k: string, path: [number, number][]) => {
      const list = open.get(k);
      if (list) list.push(path);
      else open.set(k, [path]);
    };
    const take = (k: string, path: [number, number][]) => {
      const list = open.get(k);
      if (!list) return;
      const at = list.indexOf(path);
      if (at >= 0) list.splice(at, 1);
      if (!list.length) open.delete(k);
    };

    const paths: [number, number][][] = [];
    for (const [ax, ay, bx, by] of segments) {
      const ka = key(ax, ay);
      const kb = key(bx, by);
      const before = open.get(ka)?.[0];
      const after = open.get(kb)?.[0];

      if (before && after && before !== after) {
        take(ka, before);
        take(kb, after);
        // Beide Enden passen: die zwei Züge werden einer.
        const joined = [...before, ...after.slice().reverse()];
        const kStart = key(joined[0]![0], joined[0]![1]);
        const kEnd = key(joined[joined.length - 1]![0], joined[joined.length - 1]![1]);
        take(kStart, before);
        take(kEnd, after);
        push(kStart, joined);
        push(kEnd, joined);
        paths.push(joined);
      } else if (before) {
        take(ka, before);
        before.push([bx, by]);
        push(kb, before);
      } else if (after) {
        take(kb, after);
        after.push([ax, ay]);
        push(ka, after);
      } else {
        const path: [number, number][] = [[ax, ay], [bx, by]];
        push(ka, path);
        push(kb, path);
        paths.push(path);
      }
    }

    const geo = paths
      .filter((path) => path.length > 2)
      .map((path) => path.map(([x, y]) => [lonOf(x), latOf(y)] as [number, number]));
    if (geo.length) out.push({ eleM: level, paths: geo });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Schattenwurf                                                         */
/* ------------------------------------------------------------------ */

export interface ShadowImage extends TerrainImage {
  /** Sonnenstand, für den gerechnet wurde. */
  altitudeDeg: number;
  azimuthDeg: number;
  /** true, wenn die Sonne unter dem Horizont steht — dann ist alles Schatten. */
  night: boolean;
}

/**
 * Schattenwurf des Geländes zu einem Sonnenstand.
 *
 * **Verfahren:** Für jede Rasterzelle wäre die naive Frage „steht zwischen mir
 * und der Sonne ein Berg?" ein eigener Strahl — bei Millionen Zellen zu teuer.
 * Stattdessen wird das Raster in Strahlen **in Sonnenrichtung** durchlaufen und
 * dabei ein laufender Horizont mitgeführt: Bei jedem Schritt um die Strecke L
 * sinkt der bisherige Horizont um `L · tan(Höhenwinkel)`, und die Höhe der
 * eben verlassenen Zelle hebt ihn wieder an. Liegt eine Zelle unter diesem
 * Horizont, kommt kein Sonnenlicht mehr an. Damit kostet das ganze Bild einen
 * Durchlauf statt einer Suche je Zelle.
 *
 * Gerechnet wird der **Schlagschatten des Geländes**, nicht die Beleuchtung der
 * Hangneigung — ein Nordhang wird also nicht eingefärbt, solange die Sonne ihn
 * noch streift. Bäume und Häuser stehen nicht im Höhenmodell und werfen hier
 * folglich keinen Schatten; in der Ebene ist das Ergebnis deshalb leer.
 */
export function renderShadow(
  terrain: Terrain,
  altitudeDeg: number,
  azimuthDeg: number,
  maxSize = 1024,
): ShadowImage {
  const { width: srcW, height: srcH, zoom, tileX, tileY } = terrain.meta;
  const step = Math.max(1, Math.ceil(Math.max(srcW, srcH) / maxSize));
  const width = Math.floor(srcW / step);
  const height = Math.floor(srcH / step);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const midLat = tileToLat(tileY + srcH / 512, zoom);
  const cell = ((156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** zoom) * step;

  const bounds: [number, number, number, number] = [
    tileToLon(tileX, zoom),
    tileToLat(tileY + srcH / 256, zoom),
    tileToLon(tileX + srcW / 256, zoom),
    tileToLat(tileY, zoom),
  ];
  const night = altitudeDeg <= 0;

  // Nacht: Es gibt keinen Schattenwurf, sondern gar kein Licht. Die Fläche wird
  // gleichmäßig gelegt, damit die Ebene nicht wortlos leer bleibt.
  if (night) {
    for (let i = 0; i < width * height; i++) {
      const at = i * 4;
      rgba[at] = 22;
      rgba[at + 1] = 30;
      rgba[at + 2] = 58;
      rgba[at + 3] = 90;
    }
    return { width, height, rgba, bounds, altitudeDeg, azimuthDeg, night };
  }

  const sample = (x: number, y: number): number | null =>
    terrain.sample(Math.min(srcW - 1, x * step), Math.min(srcH - 1, y * step));

  // Richtung **zur** Sonne in Rasterkoordinaten (y zeigt nach Süden).
  const rad = (azimuthDeg * Math.PI) / 180;
  const sunX = Math.sin(rad);
  const sunY = -Math.cos(rad);
  // Gelaufen wird von der Sonne weg, damit jede Zelle ihre Vorgänger kennt.
  const dx = -sunX;
  const dy = -sunY;
  const tan = Math.tan((altitudeDeg * Math.PI) / 180);

  const shaded = new Uint8Array(width * height);

  /** Ein Strahl vom Rand aus quer durchs Raster. */
  const walk = (startX: number, startY: number) => {
    let x = startX;
    let y = startY;
    let horizon = -Infinity;
    let prev: number | null = null;
    // Schrittlänge in Metern: ein Schritt in der Hauptachse, schräg entsprechend länger.
    const stepLen = Math.hypot(dx, dy) * cell;
    while (true) {
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
      const z = sample(ix, iy);
      if (z != null) {
        if (prev != null) horizon = Math.max(horizon, prev) - stepLen * tan;
        if (horizon > z) shaded[iy * width + ix] = 1;
        prev = z;
      }
      x += dx;
      y += dy;
    }
  };

  // Startpunkte: die beiden Ränder, aus deren Richtung die Sonne scheint.
  if (dx > 0) for (let y = 0; y < height; y++) walk(0, y);
  if (dx < 0) for (let y = 0; y < height; y++) walk(width - 1, y);
  if (dy > 0) for (let x = 0; x < width; x++) walk(x, 0);
  if (dy < 0) for (let x = 0; x < width; x++) walk(x, height - 1);

  for (let i = 0; i < width * height; i++) {
    const at = i * 4;
    if (!shaded[i]) {
      rgba[at + 3] = 0;
      continue;
    }
    // Kühles Blau statt Grau: Schatten liest sich als Schatten, und die
    // Grundkarte bleibt darunter erkennbar.
    rgba[at] = 30;
    rgba[at + 1] = 42;
    rgba[at + 2] = 78;
    rgba[at + 3] = 120;
  }

  return { width, height, rgba, bounds, altitudeDeg, azimuthDeg, night };
}
