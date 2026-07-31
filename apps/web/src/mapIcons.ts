import type { Map as MlMap } from 'maplibre-gl';

/**
 * Symbole für Flugzeuge und Schiffe als Karten-Icons. MapLibre braucht dafür
 * Bilddaten — die SVGs werden einmal je Kartenstil in ein Canvas gezeichnet
 * und registriert. Beide Motive zeigen nach oben (0° = Norden), die Drehung
 * übernimmt später `icon-rotate` aus der Kurs-Eigenschaft.
 */

/** Flugzeug von oben, Nase nach Norden. */
const PLANE =
  'M16 2.6c1 0 1.7 1.2 1.7 2.6v5.1l10.7 6.1v2.7l-10.7-3.3v6.1l3.4 2.4v2.2L16 25.6l-5.1 1-.0-2.2 3.4-2.4v-6.1L3.6 19.1v-2.7l10.7-6.1V5.2c0-1.4.7-2.6 1.7-2.6Z';
/** Schiffsrumpf von oben, Bug nach Norden. */
const SHIP = 'M16 2.4c2.6 3 4.2 6.6 4.2 10.6v12.8c0 2.1-1.5 3.8-4.2 3.8s-4.2-1.7-4.2-3.8V13c0-4 1.6-7.6 4.2-10.6Z';
/** Pfeilspitze für bewegte APRS-Ziele (Fahrtrichtung nach Norden). */
const ARROW = 'M16 3.5 25 27l-9-5.4L7 27 16 3.5Z';
/** Ortsfeste APRS-Station: Antennenmast. */
const MAST = 'M16 6a4 4 0 0 1 4 4c0 1.6-1 3-2.4 3.6L20 27h-3l-1-8-1 8h-3l2.4-13.4A4 4 0 0 1 16 6Z';

const SIZE = 32;
const RATIO = 2;

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

/** Icon-Name → Füll-/Randfarbe. Die Namen tauchen so in den Layer-Ausdrücken auf. */
const VARIANTS: Record<string, [string, string, string]> = {
  // Flugzeuge: in der Luft, am Boden, mit Notfall-Transpondercode
  'plane-air': [PLANE, '#1d4e73', '#ffffff'],
  'plane-ground': [PLANE, '#8a8a8f', '#ffffff'],
  'plane-alert': [PLANE, '#a92318', '#ffffff'],
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

/** Alle Icons in die Karte laden (idempotent, nach jedem Stilwechsel nötig). */
export async function ensureMapIcons(map: MlMap): Promise<void> {
  await Promise.all(
    Object.entries(VARIANTS).map(([id, [path, fill, stroke]]) => draw(map, id, path, fill, stroke)),
  );
}
