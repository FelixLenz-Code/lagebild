/**
 * Wetterfenster: „Wann kann ich raus?"
 *
 * Die Stundenvorhersage beantwortet die Frage nur mittelbar — man liest 48
 * Zeilen und rechnet im Kopf zusammen, welche Stunden am Stück brauchbar sind.
 * Hier wird genau das gemacht: Jede Stunde wird gegen ein paar Bedingungen
 * geprüft, die zusammenhängenden guten Stunden werden zu Fenstern verkettet.
 *
 * Rechnet vollständig im Gerät aus der Vorhersage, die ohnehin schon geladen
 * ist — kein zusätzlicher Abruf, funktioniert also auch offline mit dem letzten
 * Stand.
 */

import type { Coords, WeatherForecastStep } from '@lagebild/shared';
import { sunAltitude } from './sun.js';

export interface WindowCriteria {
  /** Höchste Niederschlagsmenge je Stunde (mm). */
  maxRainMm: number;
  /** Höchste Regenwahrscheinlichkeit (%). */
  maxRainProbPct: number;
  /** Höchste Windgeschwindigkeit bzw. Böe (km/h). */
  maxWindKmh: number;
  /** Temperaturbereich (°C). */
  minTempC: number;
  maxTempC: number;
  /** Nur Stunden, in denen die Sonne über dem Horizont steht. */
  daylightOnly: boolean;
}

export const DEFAULT_CRITERIA: WindowCriteria = {
  maxRainMm: 0.2,
  maxRainProbPct: 30,
  maxWindKmh: 30,
  minTempC: -5,
  maxTempC: 32,
  daylightOnly: true,
};

export interface WeatherWindow {
  start: string;
  end: string;
  /** Länge in Stunden (die Endstunde zählt mit). */
  hours: number;
  /** Höchste Temperatur im Fenster. */
  maxTempC: number | null;
  /** Stärkster Wind (Böe, wenn gemeldet) im Fenster. */
  maxWindKmh: number | null;
  /** Höchste Regenwahrscheinlichkeit im Fenster. */
  maxRainProbPct: number | null;
}

/** Warum eine Stunde nicht taugt — für den Satz „woran es scheitert". */
export type Blocker = 'rain' | 'wind' | 'cold' | 'heat' | 'dark';

export const BLOCKER_DE: Record<Blocker, string> = {
  rain: 'Niederschlag',
  wind: 'Wind',
  cold: 'zu kalt',
  heat: 'zu warm',
  dark: 'Dunkelheit',
};

/**
 * Prüft eine Stunde und nennt **alle** Gründe, die dagegen sprechen — nicht nur
 * den ersten. Sonst verschwindet der starke Wind hinter dem Regen, und wer die
 * Regenschwelle lockert, sieht immer noch kein Fenster.
 */
function blockers(
  step: WeatherForecastStep,
  criteria: WindowCriteria,
  coords: Coords,
): Blocker[] {
  const out: Blocker[] = [];
  if ((step.precipitationMm ?? 0) > criteria.maxRainMm) out.push('rain');
  else if ((step.precipitationProbabilityPct ?? 0) > criteria.maxRainProbPct) out.push('rain');
  // Böen zählen, wo sie gemeldet sind: Der Mittelwind sagt wenig darüber, ob
  // ein Zelt steht oder eine Leiter hält.
  const wind = Math.max(step.windKmh ?? 0, step.windGustKmh ?? 0);
  if (wind > criteria.maxWindKmh) out.push('wind');
  if (step.tempC != null && step.tempC < criteria.minTempC) out.push('cold');
  if (step.tempC != null && step.tempC > criteria.maxTempC) out.push('heat');
  if (criteria.daylightOnly && sunAltitude(new Date(step.time), coords.lat, coords.lon) < -0.833) {
    out.push('dark');
  }
  return out;
}

export interface WindowResult {
  windows: WeatherWindow[];
  /**
   * Wie oft welcher Grund eine Stunde verhindert hat. Steht in der Oberfläche,
   * wenn gar kein Fenster gefunden wurde — dann weiß man, welche Bedingung man
   * lockern müsste.
   */
  reasons: Record<Blocker, number>;
  /** Wie viele Stunden überhaupt geprüft wurden. */
  checked: number;
}

/**
 * Fenster in der Vorhersage suchen.
 *
 * `minHours` ist die kürzeste Länge, die noch als Fenster zählt — wer zwei
 * Stunden Arbeit vor sich hat, dem hilft eine trockene Stunde nicht.
 */
export function findWindows(
  hourly: WeatherForecastStep[],
  coords: Coords,
  criteria: WindowCriteria,
  minHours = 2,
  fromTime: Date = new Date(),
): WindowResult {
  const reasons: Record<Blocker, number> = { rain: 0, wind: 0, cold: 0, heat: 0, dark: 0 };
  const windows: WeatherWindow[] = [];
  // Die angebrochene Stunde zählt noch mit — sonst fällt „jetzt gleich" weg.
  const from = fromTime.getTime() - 3600_000;

  let run: WeatherForecastStep[] = [];
  let checked = 0;

  const close = () => {
    if (run.length >= minHours) {
      const nums = (pick: (s: WeatherForecastStep) => number | null | undefined) =>
        run.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
      const temps = nums((s) => s.tempC);
      const winds = run
        .map((s) => Math.max(s.windKmh ?? 0, s.windGustKmh ?? 0))
        .filter((v) => v > 0);
      const probs = nums((s) => s.precipitationProbabilityPct);
      windows.push({
        start: run[0]!.time,
        end: run[run.length - 1]!.time,
        hours: run.length,
        maxTempC: temps.length ? Math.max(...temps) : null,
        maxWindKmh: winds.length ? Math.max(...winds) : null,
        maxRainProbPct: probs.length ? Math.max(...probs) : null,
      });
    }
    run = [];
  };

  for (const step of hourly) {
    const t = new Date(step.time).getTime();
    if (!Number.isFinite(t) || t < from) continue;
    checked++;
    const bad = blockers(step, criteria, coords);
    if (bad.length === 0) {
      run.push(step);
      continue;
    }
    for (const b of bad) reasons[b]++;
    close();
  }
  close();

  return { windows, reasons, checked };
}
