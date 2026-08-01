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
/** Windpfeil mit Schaft — zeigt in die Richtung, in die der Wind weht. */
const WIND_ARROW = 'M16 3 23 14h-4.4v15h-5.2V14H9L16 3Z';
/** Ortsfeste APRS-Station: Antennenmast. */
const MAST = 'M16 6a4 4 0 0 1 4 4c0 1.6-1 3-2.4 3.6L20 27h-3l-1-8-1 8h-3l2.4-13.4A4 4 0 0 1 16 6Z';

const SIZE = 32;
const RATIO = 2;

/**
 * Windstärken-Stufen (km/h in 10 m Höhe), angelehnt an die Beaufort-Skala:
 * schwach, mäßig, frisch, stark, Sturm. Farben und Namen nutzt auch die Legende.
 */
export const WIND_CLASSES = [
  { id: 'calm', max: 12, color: '#7fb4e6', label: 'schwach' },
  { id: 'light', max: 29, color: '#2c7448', label: 'mäßig' },
  { id: 'fresh', max: 50, color: '#c9a70c', label: 'frisch' },
  { id: 'strong', max: 75, color: '#c96f0f', label: 'stark' },
  { id: 'storm', max: Infinity, color: '#a92318', label: 'Sturm' },
] as const;

/** Stufen-Kennung zu einer Windgeschwindigkeit (für `icon-image`). */
export function windClass(speedKmh: number): string {
  return (WIND_CLASSES.find((c) => speedKmh < c.max) ?? WIND_CLASSES[WIND_CLASSES.length - 1]).id;
}

function draw(map: MlMap, id: string, path: string, fill: string, stroke: string): Promise<void> {
  return new Promise((resolve) => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * RATIO}" height="${SIZE * RATIO}" viewBox="0 0 ${SIZE} ${SIZE}">` +
      `<path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
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
  // Wind: Pfeilfarbe nach Stärke (siehe WIND_CLASSES)
  ...Object.fromEntries(
    WIND_CLASSES.map((c) => [`wind-${c.id}`, [WIND_ARROW, c.color, '#ffffff'] as [string, string, string]]),
  ),
  // Amateurfunk (APRS): bewegt, ortsfest, Wetterstation
  'aprs-move': [ARROW, '#6b3fa0', '#ffffff'],
  'aprs-fix': [MAST, '#6b3fa0', '#ffffff'],
  'aprs-wx': [MAST, '#0d8a8a', '#ffffff'],
};

/** Alle Icons in die Karte laden (idempotent, nach jedem Stilwechsel nötig). */
export async function ensureMapIcons(map: MlMap): Promise<void> {
  await Promise.all(
    Object.entries(VARIANTS).map(([id, [path, fill, stroke]]) => draw(map, id, path, fill, stroke)),
  );
}
