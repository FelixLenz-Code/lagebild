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
