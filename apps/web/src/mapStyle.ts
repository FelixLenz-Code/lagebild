import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { Protocol, PMTiles, FileSource } from 'pmtiles';
import { layers, GRAYSCALE, DARK, type Flavor } from '@protomaps/basemaps';
import { MAPS_BASE } from './offlineMaps.js';

/**
 * Feste Vorgabe für die Basiskarte (VITE_MAP_PMTILES_URL) — etwa eine eigene,
 * gehostete Deutschland- oder Planet-Datei. Ohne diese Angabe nimmt die App
 * die PMTiles, die der eigene Server unter /api/maps ausliefert; welche, das
 * entscheidet der Standort.
 *
 * Hier stand einmal die Protomaps-Demodatei. Als Vorgabe taugt sie nicht: Sie
 * beantwortet den CORS-Vorabruf des Browsers mit 403 (und den Bau
 * `v4.pmtiles` gibt es dort inzwischen gar nicht mehr). Die Karte blieb damit
 * leer, während alle Fachebenen darüber ordentlich erschienen — ein Bild, das
 * schwer zu deuten ist.
 */
export const PMTILES_OVERRIDE: string | null =
  import.meta.env.VITE_MAP_PMTILES_URL ?? null;

/**
 * URL einer Region, die der eigene Server ausliefert. PMTiles holt daraus per
 * HTTP-Range nur die Kacheln, die gerade gebraucht werden — die Datei muss
 * also **nicht** erst heruntergeladen werden. Absolut, weil MapLibre die
 * Adresse hinter `pmtiles://` unverändert weiterreicht.
 */
export function serverPmtilesUrl(code: string): string {
  return new URL(`${MAPS_BASE}/${code}.pmtiles`, location.href).toString();
}

/**
 * Schriften und Symbole der Basiskarte.
 *
 * Sie liegen im eigenen Bundle (`public/basemaps`, geholt von
 * `scripts/fetch-basemap-assets.mjs`) — nur dann hat eine offline gestartete
 * App auch Beschriftungen. Fehlen sie, weil das Skript nie lief, greift die
 * Karte auf das Verzeichnis von Protomaps zurück; dann steht sie ohne Netz
 * eben stumm da, statt gar nicht zu erscheinen.
 */
const LOCAL_ASSETS = '/basemaps';
const REMOTE_ASSETS = 'https://protomaps.github.io/basemaps-assets';
let ASSETS = LOCAL_ASSETS;

/**
 * Einmal nachsehen, ob die mitgelieferten Dateien wirklich da sind. Wird beim
 * Start aufgerufen, bevor die erste Karte gebaut wird — ein Kopf-Abruf gegen
 * die eigene Herkunft, den der Service Worker offline aus dem Vorrat
 * beantwortet.
 */
export async function resolveMapAssets(): Promise<void> {
  try {
    const res = await fetch(`${LOCAL_ASSETS}/sprites/v4/grayscale.json`, { method: 'HEAD' });
    ASSETS = res.ok ? LOCAL_ASSETS : REMOTE_ASSETS;
  } catch {
    ASSETS = REMOTE_ASSETS;
  }
}

const glyphs = () => `${ASSETS}/fonts/{fontstack}/{range}.pbf`;
const sprite = (dark: boolean) => `${ASSETS}/sprites/v4/${dark ? 'dark' : 'grayscale'}`;

let protocol: Protocol | null = null;
/** Registriert das pmtiles://-Protokoll bei MapLibre (nur einmal nötig). */
export function registerPmtiles(): void {
  if (protocol) return;
  protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
}

/**
 * Registriert eine lokale (OPFS-)PMTiles-Datei beim Protokoll und gibt den
 * Quell-Key zurück, der als `pmtiles://<key>` im Style referenziert wird.
 */
export function addLocalPmtiles(file: File): string {
  registerPmtiles();
  protocol!.add(new PMTiles(new FileSource(file)));
  return file.name;
}

/**
 * Bis zu dieser Zoomstufe zeichnet die grobe Weltkarte, darüber die
 * ausführliche Quelle. Sechs, weil die Weltkarte bis Stufe 5 gebaut wird und
 * MapLibre die letzte Stufe noch eine Weile hochskalieren kann.
 */
export const WORLD_SPLIT_ZOOM = 6;

/**
 * Baut einen MapLibre-Style über einer PMTiles-Quelle (URL oder pmtiles-Handle).
 *
 * Liegt zusätzlich eine **Weltkarte** vor, entsteht ein Stil mit zwei
 * Quellen: unten herum die grobe Welt, ab Zoomstufe sechs die ausführliche
 * Karte. So bleibt auch weit draußen etwas zu sehen — ein Bundesland-Ausschnitt
 * endet an seiner Grenze, und die halbe Erdkugel wäre sonst schwarz.
 *
 * Ohne jede Quelle (`pmtilesUrl` = null, etwa solange die Regionenliste des
 * Servers noch unterwegs ist) kommt ein Stil mit reinem Hintergrund heraus.
 * Er muss **gültig** sein, denn die Fachebenen werden darauf gelegt: ein
 * abgewiesener Stil nähme auch sie mit.
 */
export function buildStyle(
  pmtilesUrl: string | null,
  dark: boolean,
  worldUrl?: string | null,
): StyleSpecification {
  const flavor: Flavor = dark ? DARK : GRAYSCALE;
  const empty = {
    version: 8 as const,
    glyphs: glyphs(),
    sprite: sprite(dark),
    sources: {},
    layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': flavor.background } }],
  };
  // Nur die Welt, keine ausführliche Karte? Dann ist die Welt die Karte.
  if (!pmtilesUrl) {
    if (!worldUrl) return empty;
    pmtilesUrl = worldUrl;
    worldUrl = null;
  }
  const detail = layers('protomaps', flavor, { lang: 'de' });
  const sources: StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`,
      attribution: '© OpenStreetMap-Mitwirkende',
    },
  };
  // Dieselbe Datei zweimal einzuhängen brächte nichts als doppelte Abrufe.
  if (!worldUrl || worldUrl === pmtilesUrl)
    return { version: 8, glyphs: glyphs(), sprite: sprite(dark), sources, layers: detail };

  sources.welt = {
    type: 'vector',
    url: `pmtiles://${worldUrl}`,
    attribution: '© OpenStreetMap-Mitwirkende',
  };
  // Beide Sätze tragen dieselben Ebenen-Kennungen; die der Welt bekommen
  // deshalb ein Präfix. Vorhandene Zoom-Grenzen bleiben erhalten und werden nur
  // zusätzlich beschnitten.
  //
  // Wichtig: Ebenen, die dabei leer ausgehen, müssen **raus**. Ein Haus
  // erscheint erst ab Stufe 12; gäbe man ihm hier ein maxzoom von 6, stünde
  // sein minzoom über dem maxzoom — MapLibre weist den ganzen Stil zurück, und
  // die Karte bliebe schwarz.
  const world = layers('welt', flavor, { lang: 'de' })
    .filter((l) => (l.minzoom ?? 0) < WORLD_SPLIT_ZOOM)
    .map((l) => ({
      ...l,
      id: `welt-${l.id}`,
      maxzoom: Math.min(l.maxzoom ?? 24, WORLD_SPLIT_ZOOM),
    }));
  return {
    version: 8,
    glyphs: glyphs(),
    sprite: sprite(dark),
    sources,
    layers: [
      ...world,
      ...detail
        .filter((l) => (l.maxzoom ?? 24) > WORLD_SPLIT_ZOOM)
        .map((l) => ({ ...l, minzoom: Math.max(l.minzoom ?? 0, WORLD_SPLIT_ZOOM) })),
    ],
  };
}
