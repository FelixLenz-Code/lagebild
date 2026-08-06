import { config } from '../config.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/**
 * Obergrenze für die Zahl der Einträge.
 *
 * Ohne Grenze wächst der Cache monoton: Die Schlüssel enthalten Koordinaten und
 * Kartenausschnitte, also praktisch unendlich viele Varianten. Im Alltag würde
 * das nur langsam volllaufen — auf einem öffentlich erreichbaren Server genügt
 * es, mit wechselnden Koordinaten anzufragen, um den Speicher zu füllen, bis
 * der Dienst stirbt. Einzelne Antworten sind dabei über ein Megabyte groß
 * (Lawinenregionen, Radarbilder).
 */
const MAX_EINTRAEGE = 500;

/**
 * Abgelaufene Einträge wegräumen; reicht das nicht, die ältesten. Eine `Map`
 * behält die Einfügefolge, das älteste steht also vorn — mehr Verdrängungslogik
 * braucht es für einen Cache dieser Größe nicht.
 */
function aufraeumen(): void {
  if (store.size < MAX_EINTRAEGE) return;
  const jetzt = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= jetzt) store.delete(k);
  for (const k of store.keys()) {
    if (store.size < MAX_EINTRAEGE) break;
    store.delete(k);
  }
}

/**
 * Kleiner Speicher-Cache mit TTL. Hält Antworten externer APIs kurz vor,
 * um Rate-Limits zu schonen. Der eigentliche Offline-Speicher liegt im Browser.
 */
export function cached<T>(key: string, ttlSeconds = config.cacheTtlSeconds): {
  hit: T | undefined;
  set: (value: T) => T;
} {
  const existing = store.get(key) as Entry<T> | undefined;
  const hit = existing && existing.expiresAt > Date.now() ? existing.value : undefined;
  return {
    hit,
    set(value: T) {
      aufraeumen();
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return value;
    },
  };
}

/** Nur für Prüfläufe. */
export function cacheSize(): number {
  return store.size;
}
