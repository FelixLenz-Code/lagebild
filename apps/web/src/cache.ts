import { db } from './db.js';

export interface Cached<T> {
  value: T;
  /** true, wenn der Wert offline aus dem lokalen Speicher kam (Netz-Fehler). */
  fromCache: boolean;
  /** Zeitpunkt (ms) des letzten erfolgreichen Abrufs dieses Schlüssels. */
  savedAt: number;
}

/**
 * Offline-first: Erst live laden und den frischen Wert lokal speichern.
 * Schlägt das Netz fehl, wird der zuletzt gespeicherte Stand zurückgegeben.
 */
export async function withCache<T>(key: string, loader: () => Promise<T>): Promise<Cached<T>> {
  try {
    const value = await loader();
    const savedAt = Date.now();
    await db.cache.put({ key, value, savedAt });
    return { value, fromCache: false, savedAt };
  } catch (err) {
    const hit = await db.cache.get(key);
    if (hit) return { value: hit.value as T, fromCache: true, savedAt: hit.savedAt };
    throw err;
  }
}
