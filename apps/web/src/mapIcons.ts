import type { Map as MlMap } from 'maplibre-gl';

/**
 * Symbole für Flugzeuge und Schiffe als Karten-Icons. MapLibre braucht dafür
 * Bilddaten — die SVGs werden einmal je Kartenstil in ein Canvas gezeichnet
 * und registriert. Beide Motive zeigen nach oben (0° = Norden), die Drehung
 * übernimmt später `icon-rotate` aus der Kurs-Eigenschaft.
 */

/** Verkehrsflugzeug von oben (gepfeilte Flügel), Nase nach Norden. */
const PLANE =
  'M16 2.6c1 0 1.7 1.2 1.7 2.6v5.1l10.7 6.1v2.7l-10.7-3.3v6.1l3.4 2.4v2.2L16 25.6l-5.1 1-.0-2.2 3.4-2.4v-6.1L3.6 19.1v-2.7l10.7-6.1V5.2c0-1.4.7-2.6 1.7-2.6Z';
/** Kleinflugzeug: gerade Tragflächen, kurzer Rumpf. */
const PLANE_LIGHT =
  'M16 3.4c.9 0 1.5 1 1.5 2.2v4.8h11.2v2.8H17.5v6.6l3.1 2.2v2L16 22.8l-4.6 1.2v-2l3.1-2.2v-6.6H3.3v-2.8h11.2V5.6c0-1.2.6-2.2 1.5-2.2Z';
/** Großraumflugzeug: breitere Flügel mit Triebwerksnasen. */
const PLANE_HEAVY =
  'M16 2c1.2 0 2 1.4 2 3v5l12 6.6v3l-12-3.6v6.4l3.8 2.8v2.4L16 26.4l-5.8.2v-2.4l3.8-2.8v-6.4L2 18.6v-3L14 9V5c0-1.6.8-3 2-3Z';
/** Drehflügler: Rumpf mit Rotorkreuz. */
const HELI =
  'M15 8h2v13h-2Z M5.5 14.6h21v1.8h-21Z M9 7.7 24.3 23l-1.3 1.3L7.7 9Z M23 7.7 7.7 23 9 24.3 24.3 9Z M13.6 20.5h4.8v2.2h-4.8Z';
/** Segelflugzeug/Ballon: sehr lange, schmale Flügel. */
const GLIDER =
  'M16 3.8c.7 0 1.2.9 1.2 2v4.9l13.4 2.6v1.8l-13.4-1.2v8.6l2.6 2v1.6L16 25.4l-3.8.7v-1.6l2.6-2v-8.6L1.4 15.1v-1.8l13.4-2.6V5.8c0-1.1.5-2 1.2-2Z';
/** Schiffsrumpf von oben, Bug nach Norden. */
const SHIP = 'M16 2.4c2.6 3 4.2 6.6 4.2 10.6v12.8c0 2.1-1.5 3.8-4.2 3.8s-4.2-1.7-4.2-3.8V13c0-4 1.6-7.6 4.2-10.6Z';
/** Pfeilspitze für bewegte APRS-Ziele (Fahrtrichtung nach Norden). */
const ARROW = 'M16 3.5 25 27l-9-5.4L7 27 16 3.5Z';
/** Ortsfeste APRS-Station: Antennenmast. */
const MAST = 'M16 6a4 4 0 0 1 4 4c0 1.6-1 3-2.4 3.6L20 27h-3l-1-8-1 8h-3l2.4-13.4A4 4 0 0 1 16 6Z';
/* Haltestellen-Symbole: weißes Piktogramm auf farbigem Kreis — das trägt auch
   bei 10 Pixeln noch, anders als feine Strichzeichnungen. */
const GLYPH_BUS =
  'M11.2 9.6h9.6c1 0 1.7.8 1.7 1.7v8.3c0 .7-.4 1.3-1 1.6v1.3h-2.1v-1.1h-6.8v1.1h-2.1v-1.3c-.6-.3-1-.9-1-1.6v-8.3c0-.9.7-1.7 1.7-1.7Zm.3 2.2v3.7h9v-3.7Zm1 5.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm7 0a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z';
const GLYPH_TRAM =
  'M15.4 5.4h1.2v3.6h-1.2ZM11.4 9.4h9.2c1 0 1.8.8 1.8 1.8v8.2c0 .8-.5 1.4-1.2 1.7l1.2 2h-2.1l-1-1.7h-6.6l-1 1.7h-2.1l1.2-2c-.7-.3-1.2-.9-1.2-1.7v-8.2c0-1 .8-1.8 1.8-1.8Zm.2 2.3v3.7h8.8v-3.7Zm.9 5.2a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm7 0a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z';
const GLYPH_RAIL =
  'M16 8c-3.7 0-6.2.5-6.2 3.6v6.2c0 1.2.9 2.2 2.1 2.4l-1.7 2.6h2l1.1-1.8h5.4l1.1 1.8h2l-1.7-2.6c1.2-.2 2.1-1.2 2.1-2.4v-6.2C22.2 8.5 19.7 8 16 8Zm-4.4 3.8h8.8v3.6h-8.8Zm1.2 5.2a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm6.4 0a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z';
const GLYPH_FERRY =
  'M13.2 8.6h5.6v2.2h3.1l1.7 5.5c-.9.8-2 1.3-3.2 1.3-1.3 0-2.4-.6-3.2-1.4-.9.8-2 1.4-3.3 1.4-1.2 0-2.3-.5-3.2-1.3l1.7-5.5h3.1Zm-3.4 10c1 .8 2.2 1.3 3.5 1.3 1.3 0 2.4-.5 3.3-1.3.9.8 2 1.3 3.3 1.3 1.3 0 2.5-.5 3.5-1.3l-1 3.4c-.8.4-1.6.6-2.5.6-1.2 0-2.3-.4-3.3-1-.9.6-2 1-3.3 1-.9 0-1.7-.2-2.5-.6Z';

const SIZE = 32;
const RATIO = 2;

/**
 * Windstärken-Stufen (km/h in 10 m Höhe), angelehnt an die Beaufort-Skala:
 * schwach, mäßig, frisch, stark, Sturm. Die Farben nutzen Strömungsbild und
 * Legende gemeinsam.
 */
export const WIND_CLASSES = [
  { id: 'calm', max: 12, color: '#7fb4e6', label: 'schwach' },
  { id: 'light', max: 29, color: '#2c7448', label: 'mäßig' },
  { id: 'fresh', max: 50, color: '#c9a70c', label: 'frisch' },
  { id: 'strong', max: 75, color: '#c96f0f', label: 'stark' },
  { id: 'storm', max: Infinity, color: '#a92318', label: 'Sturm' },
] as const;


function draw(map: MlMap, id: string, path: string, fill: string, stroke: string): Promise<void> {
  return drawSvg(
    map,
    id,
    `<path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/>`,
  );
}

/** Farbiger Kreis mit weißem Piktogramm — für Haltestellen. */
function badge(glyph: string, color: string): string {
  return (
    `<circle cx="16" cy="16" r="13" fill="${color}" stroke="#ffffff" stroke-width="2.4"/>` +
    `<path d="${glyph}" fill="#ffffff" fill-rule="evenodd"/>`
  );
}

function drawSvg(map: MlMap, id: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * RATIO}" height="${SIZE * RATIO}" viewBox="0 0 ${SIZE} ${SIZE}">` +
      `${body}</svg>`;
    const img = new Image(SIZE * RATIO, SIZE * RATIO);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE * RATIO;
      canvas.height = SIZE * RATIO;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (map.hasImage(id)) map.removeImage(id);
        map.addImage(id, data, { pixelRatio: RATIO });
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
  });
}

/**
 * Flugzeug-Silhouetten nach Musterklasse — ein Kleinflugzeug soll auf der Karte
 * anders aussehen als ein Airliner oder ein Hubschrauber.
 */
const PLANE_SHAPES: Record<string, string> = {
  jet: PLANE,
  light: PLANE_LIGHT,
  heavy: PLANE_HEAVY,
  helicopter: HELI,
  glider: GLIDER,
  other: PLANE,
};
/** Zustandsfarben: in der Luft, am Boden, Notfall-Transpondercode. */
const PLANE_STATES: Record<string, string> = {
  air: '#1d4e73',
  ground: '#8a8a8f',
  alert: '#a92318',
};

/** Icon-Name → Füll-/Randfarbe. Die Namen tauchen so in den Layer-Ausdrücken auf. */
const VARIANTS: Record<string, [string, string, string]> = {
  ...Object.fromEntries(
    Object.entries(PLANE_SHAPES).flatMap(([cls, path]) =>
      Object.entries(PLANE_STATES).map(([state, color]) => [`ac-${cls}-${state}`, [path, color, '#ffffff']]),
    ),
  ),
  // Schiffe nach Art
  'ship-cargo': [SHIP, '#2c7448', '#ffffff'],
  'ship-tanker': [SHIP, '#a92318', '#ffffff'],
  'ship-passenger': [SHIP, '#1d4e73', '#ffffff'],
  'ship-tug': [SHIP, '#c96f0f', '#ffffff'],
  'ship-fishing': [SHIP, '#6c2790', '#ffffff'],
  'ship-other': [SHIP, '#5b5b60', '#ffffff'],
  // Amateurfunk (APRS): bewegt, ortsfest, Wetterstation
  'aprs-move': [ARROW, '#6b3fa0', '#ffffff'],
  'aprs-fix': [MAST, '#6b3fa0', '#ffffff'],
  'aprs-wx': [MAST, '#0d8a8a', '#ffffff'],
};

/* Nachrichten-Symbole: je Kategorie ein Piktogramm auf farbigem Kreis.
   Gefahrenmeldungen sollen auf der Karte sofort ins Auge fallen. */
const GLYPH_DANGER =
  'M16 6.5 27 25.5H5Zm-1.1 6.4v6.6h2.2v-6.6Zm0 8.2v2.2h2.2v-2.2Z';
const GLYPH_SHIELD =
  'M16 5.5 25 8.6v6.6c0 5-3.7 9.4-9 11-5.3-1.6-9-6-9-11V8.6Zm-1 12.1-2.7-2.7-1.6 1.6 4.3 4.3 7-7-1.6-1.6Z';
const GLYPH_CAR =
  'M9.6 12.2 11 8.6h10l1.4 3.6h1.7c.9 0 1.6.7 1.6 1.6v6.4c0 .6-.4 1.1-1 1.3v1.9h-2.4v-1.8H9.7v1.8H7.3v-1.9c-.6-.2-1-.7-1-1.3v-6.4c0-.9.7-1.6 1.6-1.6Zm2.6-1.4-.7 1.9h13l-.7-1.9Zm-1.9 5.4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm11.4 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z';
const GLYPH_CLOUD =
  'M11.5 22.5a5.5 5.5 0 0 1-.6-11 7 7 0 0 1 13.2 2.2 4.4 4.4 0 0 1-.9 8.8Z';
const GLYPH_CROSS = 'M13.6 6.5h4.8v7.1h7.1v4.8h-7.1v7.1h-4.8v-7.1H6.5v-4.8h7.1Z';
const GLYPH_BUILDING =
  'M16 5.5 27 11v2.2H5V11Zm-8.4 9.7h2.6v7.6H7.6Zm5.1 0h2.6v7.6h-2.6Zm5.1 0h2.6v7.6h-2.6Zm5.1 0h2.6v7.6h-2.6ZM6 24.4h20v2.1H6Z';
const GLYPH_CHART = 'M7 20h4v6.5H7Zm7-6h4v12.5h-4Zm7-8h4v20.5h-4Z';
const GLYPH_BALL =
  'M16 5.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21Zm0 2.6 4.6 3.3-1.8 5.4h-5.6l-1.8-5.4Z';
const GLYPH_NOTE =
  'M13.5 6.5 24 8.9v3.3l-8-1.8v9.4a4 4 0 1 1-2.5-3.7Z';
const GLYPH_PAPER =
  'M7 7h14a1.5 1.5 0 0 1 1.5 1.5V24a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 24V8.5A1.5 1.5 0 0 1 7 7Zm2 3.4v3.2h10v-3.2Zm0 5.2v1.8h10v-1.8Zm0 3.6v1.8h6.5v-1.8ZM24 12h1.8c.4 0 .7.3.7.7V24a1.5 1.5 0 0 1-2.5 1.1Z';

/**
 * Kategorie einer Meldung → Symbol, Farbe und Bezeichnung. Wird auf der Karte
 * und in den Listen benutzt, damit beides zusammenpasst.
 */
export const NEWS_STYLE: Record<string, { path: string; color: string; label: string }> = {
  danger: { path: GLYPH_DANGER, color: '#a92318', label: 'Gefahr' },
  crime: { path: GLYPH_SHIELD, color: '#6b3fa0', label: 'Polizei & Justiz' },
  traffic: { path: GLYPH_CAR, color: '#c96f0f', label: 'Verkehr' },
  weather: { path: GLYPH_CLOUD, color: '#2f6fa8', label: 'Wetter' },
  health: { path: GLYPH_CROSS, color: '#0d8a8a', label: 'Gesundheit' },
  politics: { path: GLYPH_BUILDING, color: '#4a5560', label: 'Politik' },
  economy: { path: GLYPH_CHART, color: '#2c7448', label: 'Wirtschaft' },
  sport: { path: GLYPH_BALL, color: '#6f9e2e', label: 'Sport' },
  culture: { path: GLYPH_NOTE, color: '#b4478f', label: 'Kultur' },
  other: { path: GLYPH_PAPER, color: '#5b5b60', label: 'Nachricht' },
};

/** Haltestellen-Symbole: Art → farbiger Kreis mit Piktogramm. */
const STOP_BADGES: Record<string, [string, string]> = {
  bus: [GLYPH_BUS, '#1d4e73'],
  tram: [GLYPH_TRAM, '#6c2790'],
  rail: [GLYPH_RAIL, '#a92318'],
  ferry: [GLYPH_FERRY, '#0d8a8a'],
  other: [GLYPH_BUS, '#5b5b60'],
};

/** Art einer Haltestelle → Icon-Name in den Layer-Ausdrücken. */
export const STOP_ICON: Record<string, string> = {
  bus: 'stop-bus',
  tram: 'stop-tram',
  rail: 'stop-rail',
  ferry: 'stop-ferry',
  other: 'stop-other',
};

/** Farbe je Haltestellenart — auch für Legende und Sheet. */
export const STOP_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(STOP_BADGES).map(([kind, [, color]]) => [kind, color]),
);

/** Alle Icons in die Karte laden (idempotent, nach jedem Stilwechsel nötig). */
export async function ensureMapIcons(map: MlMap): Promise<void> {
  await Promise.all([
    ...Object.entries(VARIANTS).map(([id, [path, fill, stroke]]) => draw(map, id, path, fill, stroke)),
    ...Object.entries(STOP_BADGES).map(([kind, [glyph, color]]) =>
      drawSvg(map, STOP_ICON[kind]!, badge(glyph, color)),
    ),
    ...Object.entries(NEWS_STYLE).map(([cat, { path, color }]) =>
      drawSvg(map, `news-${cat}`, badge(path, color)),
    ),
  ]);
}
