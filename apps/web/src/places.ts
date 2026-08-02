import type { GeoResult } from '@lagebild/shared';

/** Ein gespeicherter oder ausgewählter Ort. */
export type Place = GeoResult;

const KEY = 'lagebild.favorites';

export function loadFavorites(): Place[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Place[]) : [];
  } catch {
    return [];
  }
}

export function saveFavorites(favorites: Place[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(favorites));
  } catch {
    /* Speicher nicht verfügbar → ignorieren */
  }
}

/**
 * Liegt ein Punkt in einer GeoJSON-Fläche?
 *
 * Strahlverfahren (ray casting) über alle Ringe: Ein Punkt liegt innen, wenn
 * ein Strahl nach Osten die Umrandung ungerade oft schneidet. Löcher im
 * Polygon kippen das Ergebnis dabei von selbst wieder, weil ihre Ringe
 * mitgezählt werden.
 */
export function pointInGeometry(
  point: { lat: number; lon: number },
  geometry: { type?: string; coordinates?: unknown },
): boolean {
  const rings: [number, number][][] = [];
  const collect = (node: unknown, depth: number): void => {
    if (!Array.isArray(node)) return;
    if (depth === 0) {
      rings.push(node as [number, number][]);
      return;
    }
    for (const child of node) collect(child, depth - 1);
  };
  if (geometry.type === 'Polygon') collect(geometry.coordinates, 1);
  else if (geometry.type === 'MultiPolygon') collect(geometry.coordinates, 2);
  else return false;

  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > point.lat !== yj > point.lat) {
        const x = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
        if (point.lon < x) inside = !inside;
      }
    }
  }
  return inside;
}
