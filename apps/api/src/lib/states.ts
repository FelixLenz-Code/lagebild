import type { Coords, StateCode } from '@lagebild/shared';
import { FEDERAL_STATE_BOUNDS } from '@lagebild/shared';

/**
 * Bundesländer nach Standort — gemeinsame Grundlage der Nachrichten- und der
 * Blaulicht-Route. Beide brauchen dieselbe Frage beantwortet: „Welches
 * Landesprogramm bzw. welcher Landesfeed passt zu diesem Punkt?"
 */

export const STATE_NAME: Record<StateCode, string> = {
  '01': 'Schleswig-Holstein',
  '02': 'Hamburg',
  '03': 'Niedersachsen',
  '04': 'Bremen',
  '05': 'Nordrhein-Westfalen',
  '06': 'Hessen',
  '07': 'Rheinland-Pfalz',
  '08': 'Baden-Württemberg',
  '09': 'Bayern',
  '10': 'Saarland',
  '11': 'Berlin',
  '12': 'Brandenburg',
  '13': 'Mecklenburg-Vorpommern',
  '14': 'Sachsen',
  '15': 'Sachsen-Anhalt',
  '16': 'Thüringen',
};

export const ALL_STATE_NAMES = new Set(Object.values(STATE_NAME));

function area(code: StateCode): number {
  const b = FEDERAL_STATE_BOUNDS[code];
  return (b[2] - b[0]) * (b[3] - b[1]);
}

/**
 * Welche Länder passen zum Standort? Die Rechtecke überlappen sich (Bremen
 * liegt in Niedersachsen, Wiesbaden im rheinland-pfälzischen Rechteck) — für
 * Meldungen ist das kein Problem, sondern erwünscht: wer in Bremen sitzt,
 * interessiert sich auch für das Umland. Deshalb bis zu zwei Länder, das am
 * besten passende zuerst; kleine Länder gewinnen, ein Stadtstaat ist der
 * nähere Bezug als das umgebende Flächenland.
 *
 * **Nur für Meldungen brauchbar, nicht für Abdeckungsfragen** — dafür sind die
 * groben Rechtecke zu ungenau (siehe Routing: dort entscheidet der Graph).
 */
export function statesOf(point: Coords, limit = 2): StateCode[] {
  const hits: StateCode[] = [];
  for (const [code, b] of Object.entries(FEDERAL_STATE_BOUNDS) as [StateCode, number[]][]) {
    if (point.lon < b[0]! || point.lon > b[2]! || point.lat < b[1]! || point.lat > b[3]!) continue;
    hits.push(code);
  }
  hits.sort((a, b) => area(a) - area(b));
  return hits.slice(0, limit);
}
