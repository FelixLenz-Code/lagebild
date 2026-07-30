import type { Coords } from '@lagebild/shared';

/**
 * Grobe Bounding-Boxes je Bundesland [west, süd, ost, nord] — nur genau genug,
 * um zu bestimmen, welche heruntergeladene Region einen Punkt enthält.
 */
export const STATE_BOUNDS: Record<string, [number, number, number, number]> = {
  '01': [7.8, 53.3, 11.4, 55.1], // Schleswig-Holstein
  '02': [9.7, 53.4, 10.35, 53.75], // Hamburg
  '03': [6.6, 51.3, 11.6, 53.9], // Niedersachsen
  '04': [8.4, 53.0, 9.0, 53.65], // Bremen
  '05': [5.8, 50.3, 9.5, 52.6], // Nordrhein-Westfalen
  '06': [7.7, 49.4, 10.25, 51.7], // Hessen
  '07': [6.1, 48.9, 8.55, 50.95], // Rheinland-Pfalz
  '08': [7.5, 47.5, 10.5, 49.8], // Baden-Württemberg
  '09': [8.9, 47.2, 13.9, 50.6], // Bayern
  '10': [6.3, 49.1, 7.45, 49.65], // Saarland
  '11': [13.05, 52.3, 13.8, 52.7], // Berlin
  '12': [11.2, 51.3, 14.8, 53.6], // Brandenburg
  '13': [10.5, 53.1, 14.45, 54.7], // Mecklenburg-Vorpommern
  '14': [11.8, 50.1, 15.1, 51.7], // Sachsen
  '15': [10.5, 50.9, 13.3, 53.05], // Sachsen-Anhalt
  '16': [9.8, 50.2, 12.7, 51.65], // Thüringen
};

export function inStateBounds(c: Coords, code: string): boolean {
  const b = STATE_BOUNDS[code];
  if (!b) return false;
  return c.lon >= b[0] && c.lon <= b[2] && c.lat >= b[1] && c.lat <= b[3];
}
