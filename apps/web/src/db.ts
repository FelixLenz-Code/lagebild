import Dexie, { type Table } from 'dexie';

/** Eine zwischengespeicherte Proxy-Antwort, damit die App offline den
 *  letzten bekannten Stand zeigen kann. */
export interface CacheRow {
  key: string;
  value: unknown;
  savedAt: number;
}

class LagebildDB extends Dexie {
  cache!: Table<CacheRow, string>;
  constructor() {
    super('lagebild');
    this.version(1).stores({ cache: 'key' });
  }
}

export const db = new LagebildDB();
