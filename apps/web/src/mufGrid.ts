import type { HfMufGrid } from '@lagebild/shared';
import { corners, renderMercator } from './gridImage.js';

/**
 * Das MUF-Gitter als Bild für die Karte.
 *
 * MapLibre legt eine `image`-Quelle über vier Eckpunkte und verteilt die Pixel
 * dazwischen **in Mercator-Koordinaten**. Das Gitter kommt aber in gleichen
 * Gradschritten — deshalb wird beim Zeichnen zeilenweise die zur Bildzeile
 * gehörende Breite zurückgerechnet, sonst wäre die Karte in Nord-Süd-Richtung
 * verzogen.
 */

/** Farbskala nach MUF in MHz — die Schwellen sind die Amateurfunkbänder. */
export const MUF_SCALE: { min: number; color: string; band: string }[] = [
  { min: 0, color: '#3b4a7a', band: '80 m' },
  { min: 7, color: '#2f6fa8', band: '40 m' },
  { min: 10, color: '#2c8f6a', band: '30 m' },
  { min: 14, color: '#7fa22c', band: '20 m' },
  { min: 18, color: '#d0a71a', band: '17 m' },
  { min: 21, color: '#e07b12', band: '15 m' },
  { min: 24, color: '#cf4a1f', band: '12 m' },
  { min: 28, color: '#a4218c', band: '10 m' },
];

/** Deckkraft der Fläche — die Karte darunter soll lesbar bleiben. */
const ALPHA = 145;
/** Mercator endet vor den Polen. */
const MAX_LAT = 85.0511;
/** Ecken der Bildquelle im Uhrzeigersinn ab Nordwest. */
export const MUF_BOUNDS = corners(-180, -MAX_LAT, 180, MAX_LAT);

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Farbe zu einem MUF-Wert (mit weichem Übergang zwischen den Stufen). */
function colorFor(muf: number): [number, number, number] {
  let i = MUF_SCALE.length - 1;
  while (i > 0 && muf < MUF_SCALE[i]!.min) i--;
  const lower = MUF_SCALE[i]!;
  const upper = MUF_SCALE[Math.min(i + 1, MUF_SCALE.length - 1)]!;
  const span = Math.max(1, upper.min - lower.min);
  const t = Math.max(0, Math.min(1, (muf - lower.min) / span));
  const a = rgb(lower.color);
  const b = rgb(upper.color);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Bilinear aus dem Gitter lesen (Länge läuft rundherum). */
function sample(grid: HfMufGrid, lat: number, lon: number): number {
  const { cols, rows, cellDeg, values } = grid;
  const y = (90 - lat) / cellDeg;
  const x = (((lon + 180) % 360) + 360) / cellDeg;
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(y)));
  const y1 = Math.min(rows - 1, y0 + 1);
  const x0 = Math.floor(x) % cols;
  const x1 = (x0 + 1) % cols;
  const fy = y - y0;
  const fx = x - Math.floor(x);
  const v00 = values[y0 * cols + x0]!;
  const v01 = values[y0 * cols + x1]!;
  const v10 = values[y1 * cols + x0]!;
  const v11 = values[y1 * cols + x1]!;
  return (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
}

/** Erzeugt das Overlay als Data-URL (Breite × Höhe in Pixeln). */
export function mufToDataUrl(grid: HfMufGrid, width = 720, height = 720): string | null {
  if (!grid.values.length) return null;
  return renderMercator({
    width,
    height,
    north: MAX_LAT,
    south: -MAX_LAT,
    west: -180,
    east: 180,
    valueAt: (lat, lon) => sample(grid, lat, lon),
    color: (v) => {
      const [r, g, b] = colorFor(v);
      return [r, g, b, ALPHA];
    },
  });
}

/** Welche Bänder sind bei diesem MUF-Wert brauchbar? */
export function bandsFor(muf: number): string {
  const open = MUF_SCALE.filter((s) => s.min <= muf).map((s) => s.band);
  return open.length ? `bis ${open[open.length - 1]}` : 'kaum Ausbreitung';
}
