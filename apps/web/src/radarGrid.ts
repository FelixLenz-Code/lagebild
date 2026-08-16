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
 * Umkehrung der Eckpunkt-Verortung: zu einem Ort die Stelle im Gitter.
 *
 * Die vier Ecken (NW, NO, SO, SW) spannen das Bild bilinear auf. Die Hinrichtung
 * ist eine einfache Formel, die Rückrichtung eine quadratische Gleichung —
 * gelöst wird sie deshalb mit ein paar Newton-Schritten. Über einem Ausschnitt
 * von zweihundert Kilometern ist die Abbildung fast affin; nach fünf Schritten
 * liegt der Fehler weit unter einer Gitterzelle.
 *
 * Ergebnis in Bildpunkten (x nach Osten, y nach Süden), `null` außerhalb.
 */
export function gridPositionAt(
  corners: [number, number][],
  width: number,
  height: number,
  lat: number,
  lon: number,
): { x: number; y: number } | null {
  const [nw, ne, se, sw] = corners;
  if (!nw || !ne || !se || !sw) return null;
  // P(u,v) = NW + u·(NE−NW) + v·(SW−NW) + u·v·(NW−NE+SE−SW)
  const ex = [ne[0] - nw[0], ne[1] - nw[1]];
  const fy = [sw[0] - nw[0], sw[1] - nw[1]];
  const g = [nw[0] - ne[0] + se[0] - sw[0], nw[1] - ne[1] + se[1] - sw[1]];
  let u = 0.5;
  let v = 0.5;
  for (let i = 0; i < 6; i++) {
    const rx = nw[0] + u * ex[0]! + v * fy[0]! + u * v * g[0]! - lon;
    const ry = nw[1] + u * ex[1]! + v * fy[1]! + u * v * g[1]! - lat;
    // Jacobi-Matrix der Abbildung an der Stelle (u, v).
    const a = ex[0]! + v * g[0]!;
    const b = fy[0]! + u * g[0]!;
    const c = ex[1]! + v * g[1]!;
    const d = fy[1]! + u * g[1]!;
    const det = a * d - b * c;
    if (!det) return null;
    u -= (d * rx - b * ry) / det;
    v -= (a * ry - c * rx) / det;
  }
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  return { x: u * (width - 1), y: v * (height - 1) };
}

/**
 * Niederschlagsrate (mm/h) an einer Gitterstelle, gemittelt über die neun
 * benachbarten Bildpunkte — ein einzelner Punkt ist ein Kilometer und kann ein
 * Störecho sein.
 */
export function rateAt(
  grid: Uint16Array,
  width: number,
  height: number,
  at: { x: number; y: number },
): number {
  const cx = Math.round(at.x);
  const cy = Math.round(at.y);
  let sum = 0;
  let n = 0;
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      sum += grid[y * width + x] ?? 0;
      n++;
    }
  }
  return n ? (sum / n) * MM_PER_HOUR : 0;
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
