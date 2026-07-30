import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { layers, GRAYSCALE, DARK, type Flavor } from '@protomaps/basemaps';

/**
 * Online-Standardquelle der Vektor-Basiskarte (Protomaps-PMTiles, per
 * HTTP-Range gelesen). In der Produktion über VITE_MAP_PMTILES_URL auf die
 * eigene, gehostete Deutschland-PMTiles zeigen; im Dev die Protomaps-Demo.
 */
export const ONLINE_PMTILES_URL: string =
  import.meta.env.VITE_MAP_PMTILES_URL ?? 'https://demo-bucket.protomaps.com/v4.pmtiles';

// Schriften & Symbole der Protomaps-Basemap (für Offline später mit einbetten).
const ASSETS = 'https://protomaps.github.io/basemaps-assets';

let registered = false;
/** Registriert das pmtiles://-Protokoll bei MapLibre (nur einmal nötig). */
export function registerPmtiles(): void {
  if (registered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}

/** Baut einen MapLibre-Style über einer PMTiles-Quelle (URL oder pmtiles-Handle). */
export function buildStyle(pmtilesUrl: string, dark: boolean): StyleSpecification {
  const flavor: Flavor = dark ? DARK : GRAYSCALE;
  return {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/${dark ? 'dark' : 'grayscale'}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${pmtilesUrl}`,
        attribution: '© OpenStreetMap-Mitwirkende',
      },
    },
    layers: layers('protomaps', flavor, { lang: 'de' }),
  };
}
