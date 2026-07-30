/** Eigene Markierungen des Nutzers (Punkte/POIs und Flächen), lokal gespeichert. */

export type DrawGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

export interface DrawFeature {
  id: string;
  name: string;
  kind: 'point' | 'area';
  geometry: DrawGeometry;
}

const KEY = 'lagebild.draw';

export function loadDraw(): DrawFeature[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DrawFeature[]) : [];
  } catch {
    return [];
  }
}

export function saveDraw(features: DrawFeature[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(features));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
