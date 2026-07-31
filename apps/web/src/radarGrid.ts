/**
 * DWD-Radarvorhersage (RADOLAN-RV) fürs Kartenlayer aufbereiten.
 *
 * Das Backend reicht jeden Frame so durch, wie Bright Sky ihn liefert:
 * zlib-komprimiertes uint16-Gitter (Little Endian), base64-kodiert, zeilenweise
 * von Nord nach Süd. Ein Wert = 0,01 mm Niederschlag in 5 Minuten.
 * Hier wird daraus ein PNG (Data-URL), das MapLibre als `image`-Quelle über die
 * vier Eckkoordinaten legt.
 */

/** Läuft der Browser auf Big Endian? (Praktisch nie — aber billig zu prüfen.) */
const BIG_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 0;

export function radarSupported(): boolean {
  return typeof DecompressionStream !== 'undefined';
}

/** Base64 → Bytes (die Gitter sind klein genug für den einfachen Weg). */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Einen Frame auspacken → Niederschlagswerte in 0,01 mm / 5 min. */
export async function inflateGrid(base64: string): Promise<Uint16Array> {
  const stream = new Blob([base64ToBytes(base64)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  const values = new Uint16Array(buffer);
  if (BIG_ENDIAN) {
    const view = new DataView(buffer);
    for (let i = 0; i < values.length; i++) values[i] = view.getUint16(i * 2, true);
  }
  return values;
}

/**
 * Farbskala nach Niederschlagsrate (mm/h) — von Nieselregen (hellblau) bis
 * Starkregen/Hagel (rot/violett), angelehnt an gängige Radardarstellungen.
 */
const SCALE: { maxMmPerHour: number; rgba: [number, number, number, number] }[] = [
  { maxMmPerHour: 0.5, rgba: [150, 200, 255, 130] },
  { maxMmPerHour: 1, rgba: [90, 160, 240, 170] },
  { maxMmPerHour: 2, rgba: [40, 115, 210, 195] },
  { maxMmPerHour: 5, rgba: [35, 150, 100, 205] },
  { maxMmPerHour: 10, rgba: [225, 190, 40, 215] },
  { maxMmPerHour: 20, rgba: [230, 130, 30, 225] },
  { maxMmPerHour: 50, rgba: [205, 45, 35, 235] },
  { maxMmPerHour: Infinity, rgba: [150, 35, 140, 240] },
];

/** Ein Gitterwert (0,01 mm/5 min) entspricht 0,12 mm/h. */
const MM_PER_HOUR = 0.12;
/** Darunter ist es faktisch trocken — bleibt transparent. */
const MIN_VALUE = 1;

/** Farbstufen für die Kartenlegende, beschriftet in mm/h. */
export const RADAR_LEGEND = SCALE.map((s, i) => ({
  label:
    s.maxMmPerHour === Infinity
      ? `> ${SCALE[i - 1]!.maxMmPerHour}`
      : `${String(s.maxMmPerHour).replace('.', ',')}`,
  color: `rgb(${s.rgba[0]},${s.rgba[1]},${s.rgba[2]})`,
}));

/** Frame als PNG-Data-URL rendern (transparent, wo es nicht regnet). */
export function gridToDataUrl(grid: Uint16Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(width, height);
  const px = img.data;
  for (let i = 0; i < grid.length; i++) {
    const value = grid[i]!;
    if (value < MIN_VALUE) continue;
    const rate = value * MM_PER_HOUR;
    const step = SCALE.find((s) => rate < s.maxMmPerHour) ?? SCALE[SCALE.length - 1]!;
    const o = i * 4;
    px[o] = step.rgba[0];
    px[o + 1] = step.rgba[1];
    px[o + 2] = step.rgba[2];
    px[o + 3] = step.rgba[3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
