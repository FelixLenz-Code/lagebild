/**
 * Aussehen der eigenen Markierungen: Farben und Symbole.
 *
 * Eine Quelle für beides — die Karte baut daraus ihre Bilder, die Bedienung
 * ihre Auswahl. Sonst driften Farbnamen und Symbolschlüssel auseinander, wie es
 * bei den Ebenen vor `layerCatalog.ts` der Fall war.
 */

/** Standardfarbe, wenn eine Markierung keine eigene trägt (bisheriges Teal). */
export const DRAW_COLOR = '#0d9488';

/**
 * Auswahlpalette. Bewusst wenige, kräftige Töne: Sie müssen auf heller **und**
 * dunkler Karte tragen und sich untereinander auch bei Sonnenlicht
 * unterscheiden. Die Schlüssel wandern in die Bilder-IDs der Karte, deshalb
 * kurz und ohne Sonderzeichen.
 */
export const DRAW_COLORS: { key: string; hex: string; label: string }[] = [
  { key: 'teal', hex: '#0d9488', label: 'Türkis' },
  { key: 'red', hex: '#c02718', label: 'Rot' },
  { key: 'orange', hex: '#d97706', label: 'Orange' },
  { key: 'yellow', hex: '#b59a00', label: 'Gelb' },
  { key: 'green', hex: '#2c7448', label: 'Grün' },
  { key: 'blue', hex: '#1d63a8', label: 'Blau' },
  { key: 'violet', hex: '#7a3fa8', label: 'Violett' },
  { key: 'black', hex: '#33383d', label: 'Schwarz' },
];

const BY_KEY = new Map(DRAW_COLORS.map((c) => [c.key, c]));
const BY_HEX = new Map(DRAW_COLORS.map((c) => [c.hex, c]));

/** Farbschlüssel → Farbwert; unbekannt oder leer ergibt die Standardfarbe. */
export const colorOf = (key: string | undefined): string =>
  (key ? BY_KEY.get(key)?.hex : undefined) ?? DRAW_COLOR;

/** Farbwert → Schlüssel (für Altbestand, der nur den Wert kennt). */
export const colorKeyOf = (hex: string | undefined): string =>
  (hex ? BY_HEX.get(hex)?.key : undefined) ?? 'teal';

/**
 * Symbole für gesetzte Punkte. Die Pfade sind in einem 32×32-Feld gezeichnet
 * und werden von `badge()` weiß auf einen farbigen Kreis gelegt — dieselbe
 * Bildsprache wie Haltestellen, Nachrichten und Notfallpunkte.
 */
export const DRAW_ICONS: { key: string; label: string; path: string }[] = [
  { key: 'dot', label: 'Punkt', path: 'M16 11a5 5 0 1 0 0 10 5 5 0 0 0 0-10z' },
  {
    key: 'flag',
    label: 'Fahne',
    path: 'M11 8h2v17h-2zM13 9h11l-2.6 3.6L24 16H13z',
  },
  {
    key: 'star',
    label: 'Stern',
    path: 'M16 8l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L7.4 14.4l6-.8z',
  },
  {
    key: 'alert',
    label: 'Gefahr',
    path: 'M16 7 4.5 26h23zM15 14h2v7h-2zM15 22.5h2v2h-2z',
  },
  {
    key: 'aid',
    label: 'Erste Hilfe',
    path: 'M13.5 8h5v5.5H24v5h-5.5V24h-5v-5.5H8v-5h5.5z',
  },
  {
    key: 'people',
    label: 'Sammelplatz',
    path: 'M11 13a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zm10 0a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM11 14.5c-3 0-5 1.6-5 3.6V24h10v-5.9c0-2-2-3.6-5-3.6zm10 0c-.9 0-1.7.1-2.4.4 1.5 1 2.4 2.4 2.4 4v5.1h5v-5.9c0-2-2-3.6-5-3.6z',
  },
  {
    key: 'tent',
    label: 'Unterkunft',
    path: 'M16 7 4 25h9l3-6 3 6h9zM16 15.5 13 21h6z',
  },
  {
    key: 'water',
    label: 'Wasser',
    path: 'M16 6c5 6.5 7.5 10.6 7.5 13.5A7.5 7.5 0 0 1 16 27a7.5 7.5 0 0 1-7.5-7.5C8.5 16.6 11 12.5 16 6z',
  },
  {
    key: 'fire',
    label: 'Feuer',
    path: 'M17 5c.6 4-2.4 5.2-3.9 7.6-1.7 2.7-1 5.2.6 6.6-.6-1.9.4-3.6 1.7-4.6-.3 2.6 1.6 3.7 2.2 5.4.5 1.4 0 2.7-.7 3.5 3.3-.9 5.4-3.6 5.4-6.9C22.3 12 19.4 8.6 17 5z',
  },
  {
    key: 'car',
    label: 'Fahrzeug',
    path: 'M8.5 15 10 10h12l1.5 5H26v7h-3v2h-3v-2h-8v2h-3v-2H8v-7zM11 17.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  },
  {
    key: 'antenna',
    label: 'Antenne',
    path: 'M15 12h2l3 14h-2.4L16 19.6 14.4 26H12zM16 6a3.2 3.2 0 0 0-1.6 6h3.2A3.2 3.2 0 0 0 16 6z',
  },
  {
    key: 'block',
    label: 'Sperre',
    path: 'M16 6a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3c1.6 0 3 .5 4.2 1.3L10.3 20.2A7 7 0 0 1 16 9zm0 14a7 7 0 0 1-4.2-1.4l9.9-9.9A7 7 0 0 1 16 23z',
  },
];

const ICON_BY_KEY = new Map(DRAW_ICONS.map((i) => [i.key, i]));

export const iconOf = (key: string | undefined) => ICON_BY_KEY.get(key ?? '') ?? DRAW_ICONS[0]!;

/** Bild-ID auf der Karte für ein Symbol in einer Farbe. */
export const drawIconId = (icon: string | undefined, color: string | undefined): string =>
  `dp-${iconOf(icon).key}-${color && BY_KEY.has(color) ? color : 'teal'}`;
