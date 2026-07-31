/**
 * Beobachtete APRS-Rufzeichen. Die aprs.fi-API kennt keine Umkreissuche —
 * gezeigt wird also genau das, was hier eingetragen ist (max. 20 pro Abfrage).
 */

const KEY = 'lagebild.aprs';
export const MAX_TARGETS = 20;

/** Grobe Prüfung: Rufzeichen mit optionaler SSID, z.B. „DL1ABC-9". */
export function normalizeCall(raw: string): string | null {
  const call = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,9}(-[A-Z0-9]{1,2})?$/.test(call) ? call : null;
}

export function loadTargets(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveTargets(targets: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(targets));
  } catch {
    /* Speicher nicht verfügbar */
  }
}
