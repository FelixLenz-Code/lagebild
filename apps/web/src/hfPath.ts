import type { Coords, HfMufGrid } from '@lagebild/shared';
import { sunAltitude } from './sun.js';

/**
 * Bandampel für eine Funkstrecke.
 *
 * Grundgedanke: Die Kurzwelle wird an der F2-Schicht gespiegelt. Aus dem
 * MUF-Gitter (gültig für einen 3000-km-Sprung) wird entlang des Großkreises der
 * **schwächste Punkt** gesucht — er begrenzt die Verbindung. Aus Streckenlänge
 * und Sprungzahl folgt der Umrechnungsfaktor auf die tatsächliche Sprungweite,
 * und aus dem Sonnenstand entlang des Weges die Dämpfung der unteren Bänder.
 *
 * Das ist eine Faustformel, kein VOACAP: reale Ausbreitung hängt zusätzlich an
 * Antennen, Leistung, Störpegel und Sporadic E.
 */

const RAD = Math.PI / 180;
const R_EARTH = 6371;

/** Amateurfunkbänder mit ihrer Mittenfrequenz in MHz. */
export const HAM_BANDS: { band: string; mhz: number }[] = [
  { band: '160 m', mhz: 1.9 },
  { band: '80 m', mhz: 3.65 },
  { band: '60 m', mhz: 5.36 },
  { band: '40 m', mhz: 7.1 },
  { band: '30 m', mhz: 10.12 },
  { band: '20 m', mhz: 14.2 },
  { band: '17 m', mhz: 18.1 },
  { band: '15 m', mhz: 21.2 },
  { band: '12 m', mhz: 24.9 },
  { band: '10 m', mhz: 28.5 },
  { band: '6 m', mhz: 50.3 },
];

export type BandStatus = 'open' | 'marginal' | 'closed';

export interface BandResult {
  band: string;
  mhz: number;
  status: BandStatus;
  /** Warum offen oder zu — im Klartext, nicht nur als Farbe. */
  reason: string;
}

export interface PathForecast {
  distanceKm: number;
  bearingDeg: number;
  /** Zahl der Sprünge (F2, höchstens ~3500 km je Sprung). */
  hops: number;
  /** Höchste brauchbare Frequenz für diese Strecke. */
  mufMHz: number;
  /** Empfohlene Arbeitsfrequenz (85 % der MUF). */
  fotMHz: number;
  /** Tiefste brauchbare Frequenz — darunter frisst die Dämpfung das Signal. */
  lufMHz: number;
  /** Ort des begrenzenden Punktes. */
  weakest: Coords;
  /** Anteil der Strecke im Tageslicht. */
  dayFraction: number;
  /** Die Strecke läuft durch die Dämmerungszone. */
  greyLine: boolean;
  bands: BandResult[];
  /** Punkte des Großkreises für die Karte ([lon, lat]). */
  line: [number, number][];
}

/** Punkt auf dem Großkreis zwischen a und b (0 ≤ f ≤ 1). */
function interpolate(a: Coords, b: Coords, f: number): Coords {
  const φ1 = a.lat * RAD;
  const λ1 = a.lon * RAD;
  const φ2 = b.lat * RAD;
  const λ2 = b.lon * RAD;
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
      ),
    );
  if (d < 1e-9) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
}

function distanceKm(a: Coords, b: Coords): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a: Coords, b: Coords): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const Δλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/** Bilinear aus dem MUF-Gitter lesen. */
function sampleMuf(grid: HfMufGrid, p: Coords): number {
  const { cols, rows, cellDeg, values } = grid;
  const y = (90 - p.lat) / cellDeg;
  const x = (((p.lon + 180) % 360) + 360) / cellDeg;
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(y)));
  const y1 = Math.min(rows - 1, y0 + 1);
  const x0 = Math.floor(x) % cols;
  const x1 = (x0 + 1) % cols;
  const fy = y - y0;
  const fx = x - Math.floor(x);
  const v00 = values[y0 * cols + x0] ?? 0;
  const v01 = values[y0 * cols + x1] ?? 0;
  const v10 = values[y1 * cols + x0] ?? 0;
  const v11 = values[y1 * cols + x1] ?? 0;
  return (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
}

/**
 * Umrechnung der MUF von der Bezugsweite 3000 km auf die tatsächliche
 * Sprungweite: Ein flacher Abstrahlwinkel (weiter Sprung) erlaubt höhere
 * Frequenzen, ein steiler (kurzer Sprung) nicht.
 */
function hopFactor(hopKm: number): number {
  const table: [number, number][] = [
    [0, 1.0],
    [500, 1.4],
    [1000, 1.9],
    [1500, 2.3],
    [2000, 2.6],
    [2500, 2.9],
    [3000, 3.1],
    [3500, 3.25],
    [4000, 3.4],
  ];
  const km = Math.max(0, Math.min(4000, hopKm));
  for (let i = 1; i < table.length; i++) {
    const [x1, m1] = table[i]!;
    if (km <= x1) {
      const [x0, m0] = table[i - 1]!;
      const t = (km - x0) / Math.max(1, x1 - x0);
      return (m0 + (m1 - m0) * t) / 3.1;
    }
  }
  return 3.4 / 3.1;
}

/**
 * Bandampel für eine Strecke.
 *
 * @param grid MUF-Gitter (aus /api/hf/muf)
 * @param from eigener Standort
 * @param to Gegenstelle
 * @param kIndex geomagnetischer K-Index (erhöht die Dämpfung)
 */
export function forecastPath(
  grid: HfMufGrid,
  from: Coords,
  to: Coords,
  kIndex: number | null,
): PathForecast {
  const steps = 60;
  const total = distanceKm(from, to);
  const now = new Date();

  const line: [number, number][] = [];
  let weakest = from;
  let minMuf = Infinity;
  let daySum = 0;
  let greyLine = false;

  for (let i = 0; i <= steps; i++) {
    const p = interpolate(from, to, i / steps);
    line.push([p.lon, p.lat]);
    // Die Reflexionspunkte liegen zwischen den Enden; Anfang und Ende zählen
    // für die Spiegelung nicht mit.
    const muf = sampleMuf(grid, p);
    if (i > 2 && i < steps - 2 && muf < minMuf) {
      minMuf = muf;
      weakest = p;
    }
    const alt = sunAltitude(now, p.lat, p.lon);
    if (alt > 0) daySum++;
    if (alt > -8 && alt < 2) greyLine = true;
  }
  if (!Number.isFinite(minMuf)) minMuf = sampleMuf(grid, from);

  const hops = Math.max(1, Math.ceil(total / 3500));
  const hopKm = total / hops;
  const muf = minMuf * hopFactor(hopKm);
  const fot = muf * 0.85;

  // Dämpfung: tagsüber schluckt die D-Schicht die unteren Bänder, ein unruhiges
  // Erdmagnetfeld verstärkt das noch.
  const dayFraction = daySum / (steps + 1);
  const luf = 2 + 5.5 * dayFraction + (kIndex ?? 0) * 0.35 + (total > 3000 ? 0.7 : 0);

  const bands: BandResult[] = HAM_BANDS.map(({ band, mhz }) => {
    if (mhz > 45) {
      return {
        band,
        mhz,
        status: 'closed' as BandStatus,
        reason: 'nur bei Sporadic E oder Aurora',
      };
    }
    if (mhz > muf) return { band, mhz, status: 'closed', reason: `über der MUF (${muf.toFixed(1)} MHz)` };
    if (mhz < luf * 0.8) return { band, mhz, status: 'closed', reason: 'Dämpfung zu stark' };
    if (mhz < luf) return { band, mhz, status: 'marginal', reason: 'nahe an der Dämpfungsgrenze' };
    if (mhz > fot) return { band, mhz, status: 'marginal', reason: 'dicht unter der MUF, unbeständig' };
    return { band, mhz, status: 'open', reason: 'im nutzbaren Bereich' };
  });

  return {
    distanceKm: Math.round(total),
    bearingDeg: Math.round(bearing(from, to)),
    hops,
    mufMHz: Math.round(muf * 10) / 10,
    fotMHz: Math.round(fot * 10) / 10,
    lufMHz: Math.round(luf * 10) / 10,
    weakest,
    dayFraction,
    greyLine,
    bands,
    line,
  };
}
