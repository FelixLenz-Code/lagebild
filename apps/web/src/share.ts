/**
 * Ansicht teilen: Ausschnitt und eingeschaltete Ebenen als Link.
 *
 * Der Zustand steht im **Hash** der Adresse, nicht in der Abfrage — er geht
 * damit nie an den Server, und die App ist und bleibt eine reine
 * Browseranwendung. Format:
 *
 *   #karte=53.0836,8.8137,12.4&ebenen=radar,warnings
 */

import type { LayerRowId } from './layerCatalog.js';

export interface SharedView {
  lat: number;
  lon: number;
  zoom: number;
  layers: LayerRowId[];
}

export function buildShareUrl(view: SharedView, base = window.location.href): string {
  const url = new URL(base);
  url.hash =
    `karte=${view.lat.toFixed(5)},${view.lon.toFixed(5)},${view.zoom.toFixed(1)}` +
    (view.layers.length ? `&ebenen=${view.layers.join(',')}` : '');
  return url.toString();
}

/**
 * Geteilte Ansicht aus dem Hash lesen. Unbekannte Ebenennamen werden
 * durchgereicht — die Karte kennt ihre eigenen und lässt den Rest liegen;
 * eine ältere App soll an einem neueren Link nicht scheitern.
 */
export function readShareUrl(hash = window.location.hash): SharedView | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const map = params.get('karte');
  if (!map) return null;
  const [lat, lon, zoom] = map.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat! < -90 || lat! > 90 || lon! < -180 || lon! > 180) return null;
  const layers = (params.get('ebenen') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as LayerRowId[];
  return { lat: lat!, lon: lon!, zoom: Number.isFinite(zoom) ? zoom! : 11, layers };
}

/** Den Hash wieder entfernen, ohne die Seite neu zu laden. */
export function clearShareUrl(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

/** In die Zwischenablage legen — mit Rückfall für Browser ohne die API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Ohne sicheren Kontext oder Erlaubnis bleibt der alte Weg.
    try {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
