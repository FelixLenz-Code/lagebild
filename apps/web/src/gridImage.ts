/**
 * Gitterdaten als Bild für MapLibre-`image`-Quellen.
 *
 * MapLibre spannt so ein Bild zwischen vier Eckpunkten auf und verteilt die
 * Pixel **in Mercator-Koordinaten**. Gitter kommen aber in gleichen
 * Gradschritten — deshalb wird je Bildzeile die zugehörige geografische Breite
 * zurückgerechnet, sonst wäre alles in Nord-Süd-Richtung verzogen.
 */

export interface MercatorImage {
  width: number;
  height: number;
  north: number;
  south: number;
  west: number;
  east: number;
  /** Wert an einer Stelle; `null` bleibt durchsichtig. */
  valueAt: (lat: number, lon: number) => number | null;
  /** Wert → Farbe als [r, g, b, a]. */
  color: (value: number) => [number, number, number, number];
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

export function renderMercator(o: MercatorImage): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(o.width, o.height);
  const top = mercY(o.north);
  const bottom = mercY(o.south);

  for (let py = 0; py < o.height; py++) {
    const y = top - ((py + 0.5) / o.height) * (top - bottom);
    const lat = (Math.atan(Math.sinh(y)) * 180) / Math.PI;
    for (let px = 0; px < o.width; px++) {
      const lon = o.west + ((px + 0.5) / o.width) * (o.east - o.west);
      const value = o.valueAt(lat, lon);
      const offset = (py * o.width + px) * 4;
      if (value == null) continue;
      const [r, g, b, a] = o.color(value);
      img.data[offset] = r;
      img.data[offset + 1] = g;
      img.data[offset + 2] = b;
      img.data[offset + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Ecken einer Bildquelle im Uhrzeigersinn ab Nordwest. */
export const corners = (
  west: number,
  south: number,
  east: number,
  north: number,
): [[number, number], [number, number], [number, number], [number, number]] => [
  [west, north],
  [east, north],
  [east, south],
  [west, south],
];
