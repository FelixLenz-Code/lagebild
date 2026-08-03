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

/* ------------------------------------------------------------------ *
 * Beobachtete Orte
 * ------------------------------------------------------------------ */

/**
 * Ein Ort, den die App im Auge behält (Zuhause, Arbeit, Eltern …).
 *
 * Bewusst getrennt von den gespeicherten **Zielen**: Ein Ziel fährt man an,
 * einen beobachteten Ort prüft die App auf Warnungen — auch wenn man ganz
 * woanders ist.
 */
export interface WatchedPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const WATCH_KEY = 'lagebild.watched';
/** Jeder Ort kostet zwei Abfragen je Aktualisierung — mehr wird unhöflich. */
export const MAX_WATCHED = 8;

export function loadWatched(): WatchedPlace[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const list = raw ? (JSON.parse(raw) as WatchedPlace[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && Number.isFinite(p.lat)) : [];
  } catch {
    return [];
  }
}

export function saveWatched(places: WatchedPlace[]): void {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(places.slice(0, MAX_WATCHED)));
  } catch {
    /* Speicher nicht verfügbar → ignorieren */
  }
}

export const newPlaceId = (): string =>
  `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
