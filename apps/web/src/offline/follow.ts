/**
 * Der Route folgen: wo auf der Linie steht man gerade, wie weit ist es noch,
 * und welche Anweisung kommt als Nächstes.
 *
 * Reine Geometrie, damit die Navigationsansicht nichts rechnen muss.
 */

import type { Coords, RouteResult } from '@lagebild/shared';
import { distanceM } from './graph.js';

export interface RouteProgress {
  /** Punkt auf der Route, der der Position am nächsten liegt. */
  snapped: Coords;
  /** Abstand der Position zur Route in Metern. */
  offRouteM: number;
  /** Index des Routenpunkts direkt vor der Position. */
  coordIndex: number;
  /** Bereits zurückgelegte bzw. verbleibende Strecke. */
  traveledM: number;
  remainingM: number;
  /** Verbleibende Fahrzeit in Sekunden (anteilig zur Reststrecke). */
  remainingS: number;
  /** Aktueller Abschnitt: dieser Schritt wird gerade abgearbeitet. */
  stepIndex: number;
  /** Entfernung bis zur nächsten Anweisung. */
  distanceToManeuverM: number;
  /** Fahrtrichtung entlang der Route an dieser Stelle (Grad). */
  bearing: number;
}

/** Aufsummierte Streckenlängen je Routenpunkt (pro Route einmal gerechnet). */
const cumulativeCache = new WeakMap<RouteResult, Float64Array>();

export function cumulativeDistances(route: RouteResult): Float64Array {
  const hit = cumulativeCache.get(route);
  if (hit) return hit;
  const c = route.coordinates;
  const out = new Float64Array(c.length);
  for (let i = 1; i < c.length; i++) {
    out[i] = out[i - 1]! + distanceM(c[i - 1]![1], c[i - 1]![0], c[i]![1], c[i]![0]);
  }
  cumulativeCache.set(route, out);
  return out;
}

function bearingAt(route: RouteResult, i: number): number {
  const c = route.coordinates;
  const a = c[Math.min(i, c.length - 2)] ?? c[0]!;
  const b = c[Math.min(i + 1, c.length - 1)] ?? c[c.length - 1]!;
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const Δλ = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Sucht die Position auf der Route. `hint` ist der zuletzt bekannte Index —
 * damit wird nur ein Fenster geprüft, statt jedes Mal die ganze Linie.
 */
export function follow(route: RouteResult, pos: Coords, hint = 0): RouteProgress {
  const c = route.coordinates;
  const cum = cumulativeDistances(route);
  const total = cum[cum.length - 1] ?? 0;

  const scan = (from: number, to: number) => {
    let bestI = from;
    let bestD = Infinity;
    let bestLat = pos.lat;
    let bestLon = pos.lon;
    let bestAlong = cum[from] ?? 0;
    for (let i = from; i < to - 1; i++) {
      const alat = c[i]![1];
      const alon = c[i]![0];
      const blat = c[i + 1]![1];
      const blon = c[i + 1]![0];
      const kx = Math.cos((alat * Math.PI) / 180);
      const dx = (blon - alon) * kx;
      const dy = blat - alat;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(1, (((pos.lon - alon) * kx) * dx + (pos.lat - alat) * dy) / len2),
            );
      const plat = alat + (blat - alat) * t;
      const plon = alon + (blon - alon) * t;
      const d = distanceM(pos.lat, pos.lon, plat, plon);
      if (d < bestD) {
        bestD = d;
        bestI = i;
        bestLat = plat;
        bestLon = plon;
        bestAlong = cum[i]! + (cum[i + 1]! - cum[i]!) * t;
      }
    }
    return { bestI, bestD, bestLat, bestLon, bestAlong };
  };

  // Erst im Fenster um die letzte Position suchen, sonst die ganze Route.
  const from = Math.max(0, hint - 20);
  const to = Math.min(c.length, hint + 400);
  let best = scan(from, to);
  if (best.bestD > 60 && (from > 0 || to < c.length)) {
    const global = scan(0, c.length);
    if (global.bestD < best.bestD) best = global;
  }

  // Nächste Anweisung suchen: der erste Schritt hinter der aktuellen Stelle.
  let stepIndex = 0;
  for (let s = 0; s < route.steps.length; s++) {
    if (route.steps[s]!.index <= best.bestI) stepIndex = s;
  }
  const nextStep = route.steps[Math.min(stepIndex + 1, route.steps.length - 1)]!;
  const maneuverAt = cum[nextStep.index] ?? total;

  const remainingM = Math.max(0, total - best.bestAlong);
  return {
    snapped: { lat: best.bestLat, lon: best.bestLon },
    offRouteM: best.bestD,
    coordIndex: best.bestI,
    traveledM: best.bestAlong,
    remainingM,
    remainingS: total > 0 ? (route.durationS * remainingM) / total : 0,
    stepIndex,
    distanceToManeuverM: Math.max(0, maneuverAt - best.bestAlong),
    bearing: bearingAt(route, best.bestI),
  };
}
