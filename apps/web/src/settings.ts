import type { LayerRowId } from './layerCatalog.js';

/**
 * Einstellungen der App — bewusst klein gehalten und im localStorage, damit sie
 * ohne Konto und ohne Netz überleben. Neue Einstellungen kommen einfach als
 * weiteres Feld dazu; `loadSettings` füllt fehlende mit dem Standard auf.
 */
export interface Settings {
  /** Ebenen, die im Karten-Menü gar nicht erst auftauchen sollen. */
  hiddenLayers: LayerRowId[];
  /** Selbsttätig alle Daten neu holen (Minuten; 0 = aus). */
  autoRefreshMin: number;
  /** Beim Start automatisch orten. */
  locateOnStart: boolean;
  /** Ansagen während der Zielführung. */
  voiceGuidance: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  hiddenLayers: [],
  autoRefreshMin: 0,
  locateOnStart: true,
  voiceGuidance: true,
};

/** Erlaubte Werte für das selbsttätige Aktualisieren. */
export const REFRESH_CHOICES = [0, 5, 15, 30] as const;

const KEY = 'lagebild.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      hiddenLayers: Array.isArray(parsed.hiddenLayers) ? parsed.hiddenLayers : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* voller oder gesperrter Speicher darf die App nicht anhalten */
  }
}
