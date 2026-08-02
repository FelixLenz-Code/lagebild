import type { LayerRowId } from './layerCatalog.js';

/**
 * „Karten": gespeicherte Ebenen-Zusammenstellungen und ihre Diashow.
 *
 * Gedacht für einen großen Monitor: mehrere Karten in eine Reihenfolge
 * bringen, je eine Standzeit festlegen und laufen lassen. Alles liegt im
 * localStorage — kein Konto, keine Verbindung nötig.
 */

export interface MapPreset {
  id: string;
  name: string;
  /** Ebenen, die diese Karte einschaltet (alle übrigen gehen aus). */
  layers: LayerRowId[];
  /** Standzeit in Sekunden. */
  seconds: number;
}

export interface SlideshowSettings {
  /** Nur die Karte zeigen, Kachelspalte ausblenden. */
  mapOnly: boolean;
  /** Nach der letzten Karte wieder von vorn. */
  loop: boolean;
}

export const DEFAULT_SLIDESHOW: SlideshowSettings = { mapOnly: true, loop: true };

/** Vorschlag für neue Karten. */
export const DEFAULT_SECONDS = 20;

const KEY = 'lagebild.presets';

interface Stored {
  presets: MapPreset[];
  slideshow: SlideshowSettings;
}

export function loadPresets(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { presets: [], slideshow: { ...DEFAULT_SLIDESHOW } };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      presets: Array.isArray(parsed.presets)
        ? parsed.presets.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.layers))
        : [],
      slideshow: { ...DEFAULT_SLIDESHOW, ...parsed.slideshow },
    };
  } catch {
    return { presets: [], slideshow: { ...DEFAULT_SLIDESHOW } };
  }
}

export function savePresets(value: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* voller Speicher darf die App nicht anhalten */
  }
}

/** Kurze, im Browser eindeutige Kennung. */
export const newPresetId = (): string =>
  `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
