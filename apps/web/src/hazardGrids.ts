import type { AuroraGrid, FireDangerGrid } from '@lagebild/shared';
import { corners, renderMercator } from './gridImage.js';

/**
 * Flächen für Polarlicht und Waldbrandgefahr — beide werden aus einem Gitter
 * gezeichnet, genau wie die MUF-Ebene.
 */

/* ---------- Waldbrandgefahr (DWD, Stufe 1–5) ---------- */

export const FIRE_LEVELS = [
  { min: 1, color: '#3f8f4a', label: '1 sehr gering' },
  { min: 2, color: '#a8bb2e', label: '2 gering' },
  { min: 3, color: '#e3b505', label: '3 mittel' },
  { min: 4, color: '#e07b12', label: '4 hoch' },
  { min: 5, color: '#a92318', label: '5 sehr hoch' },
];

const FIRE_ALPHA = 120;

function fireColor(value: number): [number, number, number, number] {
  let i = FIRE_LEVELS.length - 1;
  while (i > 0 && value < FIRE_LEVELS[i]!.min) i--;
  const lower = FIRE_LEVELS[i]!;
  const upper = FIRE_LEVELS[Math.min(i + 1, FIRE_LEVELS.length - 1)]!;
  const t = Math.max(0, Math.min(1, value - lower.min));
  const mix = (a: string, b: string, at: number) => {
    const p = (h: string, o: number) => parseInt(h.slice(o, o + 2), 16);
    return [
      Math.round(p(a, 1) + (p(b, 1) - p(a, 1)) * at),
      Math.round(p(a, 3) + (p(b, 3) - p(a, 3)) * at),
      Math.round(p(a, 5) + (p(b, 5) - p(a, 5)) * at),
    ] as [number, number, number];
  };
  const [r, g, b] = mix(lower.color, upper.color, t);
  return [r, g, b, FIRE_ALPHA];
}

export function fireBounds(grid: FireDangerGrid) {
  const south = grid.north - (grid.rows - 1) * grid.cellDeg;
  const east = grid.west + (grid.cols - 1) * grid.cellDeg;
  return corners(grid.west, south, east, grid.north);
}

/** Gefahrenstufe an einem Ort (nächste Gitterzelle), `null` außerhalb. */
export function fireDangerAt(grid: FireDangerGrid, lat: number, lon: number): number | null {
  const col = Math.round((lon - grid.west) / grid.cellDeg);
  const row = Math.round((grid.north - lat) / grid.cellDeg);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;
  const v = grid.values[row * grid.cols + col];
  return v == null || v <= 0 ? null : v;
}

export function fireToDataUrl(grid: FireDangerGrid, width = 512, height = 640): string | null {
  if (!grid.values.length) return null;
  const south = grid.north - (grid.rows - 1) * grid.cellDeg;
  const east = grid.west + (grid.cols - 1) * grid.cellDeg;
  return renderMercator({
    width,
    height,
    north: grid.north,
    south,
    west: grid.west,
    east,
    valueAt: (lat, lon) => {
      const y = (grid.north - lat) / grid.cellDeg;
      const x = (lon - grid.west) / grid.cellDeg;
      if (y < 0 || y > grid.rows - 1 || x < 0 || x > grid.cols - 1) return null;
      const y0 = Math.floor(y);
      const x0 = Math.floor(x);
      const y1 = Math.min(grid.rows - 1, y0 + 1);
      const x1 = Math.min(grid.cols - 1, x0 + 1);
      const fy = y - y0;
      const fx = x - x0;
      const v00 = grid.values[y0 * grid.cols + x0]!;
      const v01 = grid.values[y0 * grid.cols + x1]!;
      const v10 = grid.values[y1 * grid.cols + x0]!;
      const v11 = grid.values[y1 * grid.cols + x1]!;
      const v = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
      // Außerhalb der Stationsreichweite steht 0 — dort nichts zeichnen.
      return v < 0.5 ? null : v;
    },
    color: fireColor,
  });
}

/* ---------- Polarlicht (NOAA OVATION, Prozent) ---------- */

const AURORA_MAX_LAT = 85.0511;
export const AURORA_BOUNDS = corners(-180, -AURORA_MAX_LAT, 180, AURORA_MAX_LAT);

/** Unter dieser Wahrscheinlichkeit lohnt die Anzeige nicht. */
const AURORA_MIN = 2;

export function auroraToDataUrl(grid: AuroraGrid, width = 720, height = 720): string | null {
  if (!grid.values.length) return null;
  return renderMercator({
    width,
    height,
    north: AURORA_MAX_LAT,
    south: -AURORA_MAX_LAT,
    west: -180,
    east: 180,
    // Bilinear: das Gitter hat 1° Schrittweite — ohne Glättung stünden dort
    // Rechtecke statt eines Ovals.
    valueAt: (lat, lon) => {
      const y = 90 - lat;
      const x = ((lon % 360) + 360) % 360;
      if (y < 0 || y > grid.rows - 1) return null;
      const y0 = Math.floor(y);
      const y1 = Math.min(grid.rows - 1, y0 + 1);
      const x0 = Math.floor(x) % grid.cols;
      const x1 = (x0 + 1) % grid.cols;
      const fy = y - y0;
      const fx = x - Math.floor(x);
      const at = (r: number, c: number) => grid.values[r * grid.cols + c] ?? 0;
      const v =
        (at(y0, x0) * (1 - fx) + at(y0, x1) * fx) * (1 - fy) +
        (at(y1, x0) * (1 - fx) + at(y1, x1) * fx) * fy;
      return v < AURORA_MIN ? null : v;
    },
    // Grün wie das Polarlicht selbst, mit der Wahrscheinlichkeit kräftiger.
    // Die Deckkraft beginnt an der Schwelle bei null — sonst zöge sich eine
    // harte Kante quer über die Karte, wo die Fläche einfach aufhört.
    color: (v) => {
      const t = Math.min(1, v / 60);
      return [
        Math.round(40 + 60 * t),
        Math.round(180 + 60 * t),
        Math.round(120 + 40 * t),
        Math.round(Math.min(205, (v - AURORA_MIN) * 9)),
      ];
    },
  });
}
