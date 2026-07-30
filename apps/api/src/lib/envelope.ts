import type { ApiEnvelope } from '@lagebild/shared';

/** Baut die Standard-Antworthülle mit Zeitstempel. */
export function envelope<T>(data: T, source: string, stale = false): ApiEnvelope<T> {
  return { data, source, fetchedAt: new Date().toISOString(), stale };
}
