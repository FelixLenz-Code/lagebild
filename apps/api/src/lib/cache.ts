import { config } from '../config.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

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
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return value;
    },
  };
}
