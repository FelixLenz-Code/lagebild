/**
 * „Wann erreicht mich der Regen?"
 *
 * Die Radarvorhersage des DWD (RADOLAN-RV über Bright Sky) ist bereits eine
 * echte Vorhersage in Fünf-Minuten-Schritten bis +2 h — und sie wird **um den
 * eigenen Standort herum** angefordert. Damit muss hier nichts geschätzt und
 * keine Zugrichtung aus zwei Bildern gerechnet werden: Es genügt, in jedem
 * Bild in die Mitte zu sehen.
 *
 * Das ist der ehrlichere Weg. Eine selbst geschätzte Verlagerung wäre eine
 * grobe Näherung dessen, was der Wetterdienst mit Windfeldern und
 * Zellverfolgung ohnehin besser rechnet.
 */

import type { RadarForecast } from '@lagebild/shared';
import { inflateGrid } from './radarGrid.js';

/** Umrechnung des Gitterwerts (0,01 mm je 5 min) in mm/h. */
const TO_MM_H = 0.12;

/** Ab hier gilt es als Regen — darunter ist es Nieseln oder Rauschen. */
const RAIN_MM_H = 0.3;

/** Stufen für den Klartext (mm/h). */
const STEPS: [number, string][] = [
  [2.5, 'leichter Regen'],
  [10, 'mäßiger Regen'],
  [50, 'starker Regen'],
  [Infinity, 'sehr starker Regen'],
];

export const rainLabel = (mmH: number): string => STEPS.find(([limit]) => mmH < limit)![1];

export interface NowcastPoint {
  at: number;
  mmH: number;
  forecast: boolean;
}

export interface Nowcast {
  /** Verlauf am eigenen Standort, gemessen und vorhergesagt. */
  points: NowcastPoint[];
  /** Regnet es hier gerade? */
  rainingNow: boolean;
  /** Beginn des nächsten Regens (nur wenn es noch nicht regnet). */
  startsAt: number | null;
  /** Ende des laufenden bzw. kommenden Regens, wenn er im Zeitfenster endet. */
  endsAt: number | null;
  /** Stärkster Wert im Vorhersagefenster und wann. */
  peakMmH: number;
  peakAt: number | null;
  /** Bis wohin die Vorhersage reicht. */
  until: number | null;
}

/**
 * Mittelwert eines kleinen Fensters um den eigenen Standort im Gitter.
 *
 * Ein einzelner Bildpunkt ist ein Quadrat von einem Kilometer; ein Schauer
 * daneben oder ein Störecho darin würde die Aussage kippen. Drei mal drei
 * Punkte glätten das, ohne die Stelle zu verlassen.
 */
function sampleAt(
  grid: Uint16Array,
  width: number,
  height: number,
  at?: { x: number; y: number },
): number {
  const cx = Math.round(at?.x ?? width / 2);
  const cy = Math.round(at?.y ?? height / 2);
  let sum = 0;
  let n = 0;
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const v = grid[y * width + x];
      if (v == null) continue;
      sum += v;
      n++;
    }
  }
  return n ? (sum / n) * TO_MM_H : 0;
}

/** Verlauf und Ankunftszeit am eigenen Standort aus der Radarvorhersage. */
export async function nowcastAt(forecast: RadarForecast): Promise<Nowcast | null> {
  if (!forecast.frames.length) return null;

  const points: NowcastPoint[] = [];
  for (const frame of forecast.frames) {
    try {
      const grid = await inflateGrid(frame.data);
      points.push({
        at: new Date(frame.time).getTime(),
        mmH: sampleAt(grid, forecast.width, forecast.height, forecast.position),
        forecast: frame.forecast,
      });
    } catch {
      // Ein unlesbarer Frame darf den Rest nicht mitnehmen.
    }
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.at - b.at);

  const measured = points.filter((p) => !p.forecast);
  const ahead = points.filter((p) => p.forecast);
  const rainingNow = (measured[measured.length - 1]?.mmH ?? 0) >= RAIN_MM_H;

  let startsAt: number | null = null;
  if (!rainingNow) {
    startsAt = ahead.find((p) => p.mmH >= RAIN_MM_H)?.at ?? null;
  }

  // Ende: der erste trockene Punkt nach dem Beginn des Regens.
  let endsAt: number | null = null;
  const from = rainingNow ? 0 : ahead.findIndex((p) => p.mmH >= RAIN_MM_H);
  if (rainingNow || from >= 0) {
    const rest = ahead.slice(Math.max(0, from));
    const dry = rest.find((p) => p.mmH < RAIN_MM_H);
    endsAt = dry?.at ?? null;
  }

  let peakMmH = 0;
  let peakAt: number | null = null;
  for (const p of ahead) {
    if (p.mmH > peakMmH) {
      peakMmH = p.mmH;
      peakAt = p.at;
    }
  }

  return {
    points,
    rainingNow,
    startsAt,
    endsAt,
    peakMmH,
    peakAt,
    until: points[points.length - 1]?.at ?? null,
  };
}

/**
 * Ein Satz für die Kachel — **nur wenn er etwas zu melden hat**.
 *
 * Bewusst kein „die nächsten zwei Stunden trocken": Das steht mit „Regen 24 h
 * 0 mm" schon in derselben Kachel, nur aus der Stundenvorhersage. Zwei Zeilen
 * für dieselbe Nachricht machen die Kachel voll und die Aussage schwächer.
 *
 * Was die Stundenvorhersage **nicht** kann und diese Zeile deshalb wert ist:
 * den Beginn und das Ende eines einzelnen Schauers auf fünf Minuten genau.
 */
export function nowcastText(n: Nowcast): { text: string; urgent: boolean } | null {
  const clock = (t: number) =>
    new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const inMinutes = (t: number) => Math.max(0, Math.round((t - Date.now()) / 60000));

  if (n.rainingNow) {
    const now = n.points.filter((p) => !p.forecast).at(-1)?.mmH ?? 0;
    return {
      text: n.endsAt
        ? `${rainLabel(Math.max(now, n.peakMmH))} bis gegen ${clock(n.endsAt)}`
        : `${rainLabel(Math.max(now, n.peakMmH))} — hält die nächsten zwei Stunden an`,
      // Auch laufender Starkregen ist eine Meldung, nicht nur ankommender.
      urgent: Math.max(now, n.peakMmH) >= 10,
    };
  }
  if (n.startsAt != null) {
    const minutes = inMinutes(n.startsAt);
    return {
      text: `${rainLabel(n.peakMmH)} ab ${clock(n.startsAt)}${minutes <= 120 ? ` (in ${minutes} min)` : ''}`,
      // Was in einer halben Stunde da ist und kräftig wird, ist eine Meldung
      // und keine Randnotiz.
      urgent: minutes <= 30 || n.peakMmH >= 10,
    };
  }
  return null;
}
