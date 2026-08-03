/**
 * Strecken und Flächen auf der Kugel.
 *
 * Gerechnet wird auf [lon, lat] — so liegen die Koordinaten in GeoJSON und
 * damit in allen Markierungen. Die Fläche kommt aus dem sphärischen Exzess
 * und stimmt deshalb auch bei großen Gebieten; eine ebene Näherung liefe bei
 * einem Bundesland-großen Ring schon um Prozente daneben.
 */

const R = 6371008.8;
const RAD = Math.PI / 180;

/** Abstand zweier Punkte in Metern. */
export function distance(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Länge eines Linienzugs in Metern. */
export function lineLength(coords: [number, number][]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += distance(coords[i - 1]!, coords[i]!);
  return sum;
}

/**
 * Fläche eines Rings in Quadratmetern (Vorzeichen wird verworfen).
 * Formel nach Chamberlain/Duquette — dieselbe, die auch PostGIS benutzt.
 */
export function ringArea(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    total += (b[0] - a[0]) * RAD * (2 + Math.sin(a[1] * RAD) + Math.sin(b[1] * RAD));
  }
  return Math.abs((total * R * R) / 2);
}

/** Mittelpunkt eines Linienzugs — reicht als Ankerpunkt für Namen und Ziele. */
export function midpoint(coords: [number, number][]): [number, number] {
  if (!coords.length) return [0, 0];
  const half = lineLength(coords) / 2;
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const step = distance(coords[i - 1]!, coords[i]!);
    if (walked + step >= half) {
      const t = step > 0 ? (half - walked) / step : 0;
      const a = coords[i - 1]!;
      const b = coords[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    walked += step;
  }
  return coords[coords.length - 1]!;
}

/** Länge im Klartext: unter einem Kilometer in Metern. */
export const formatLength = (m: number): string =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`;

/** Fläche im Klartext: Quadratmeter, Hektar oder Quadratkilometer. */
export function formatArea(m2: number): string {
  if (m2 < 10000) return `${Math.round(m2)} m²`;
  if (m2 < 1_000_000) return `${(m2 / 10000).toFixed(2).replace('.', ',')} ha`;
  return `${(m2 / 1_000_000).toFixed(m2 < 10_000_000 ? 2 : 1).replace('.', ',')} km²`;
}
