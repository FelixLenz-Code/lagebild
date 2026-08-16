/**
 * Das Lagebild einer Strecke: **Raum mal Zeit**.
 *
 * Alle Ebenen der App beantworten die Frage „was ist dort?". Wer fährt, hat
 * aber eine andere: „was ist dort, wenn ich ankomme?". Eine Route trägt eine
 * Zeitachse — aus Länge und Dauer je Abschnitt steht für jeden Punkt fest, wann
 * man ihn passiert. Damit lassen sich dieselben Daten raumzeitlich auswerten:
 * die Gewitterzelle, die den Weg in 40 Minuten kreuzt, die Warnung, die erst ab
 * dem Nachmittag gilt, der Sonnenuntergang bei Kilometer 60.
 *
 * Gerechnet wird ausschließlich hier auf dem Gerät, aus Daten, die ohnehin
 * geladen sind. Nichts davon geht an einen Dienst.
 */

import type {
  CivilWarning,
  RadarForecast,
  RouteResult,
  TrafficIncident,
  WarningFeature,
  WindField,
} from '@lagebild/shared';
import { gridPositionAt, inflateGrid, rateAt } from './radarGrid.js';
import { WindGrid } from './windField.js';
import { pointInGeometry } from './places.js';
import { distance } from './geo.js';
import { sunAltitude } from './sun.js';

export type RouteEventKind = 'warning' | 'civil' | 'rain' | 'wind' | 'traffic' | 'dark';
/** note = zur Kenntnis, warn = beachten, alarm = das ändert die Fahrt. */
export type RouteEventLevel = 'note' | 'warn' | 'alarm';

export interface RouteEvent {
  kind: RouteEventKind;
  level: RouteEventLevel;
  /** Streckenmeter, ab wo es gilt. */
  fromM: number;
  /** Streckenmeter, bis wo — bei punktuellen Ereignissen gleich `fromM`. */
  toM: number;
  /** Zeitpunkt (ms), zu dem man `fromM` erreicht. */
  atMs: number;
  title: string;
  detail?: string;
  /** Ort für den Kartensprung. */
  lat: number;
  lon: number;
}

export interface RouteSituation {
  events: RouteEvent[];
  /** Bis zu welchem Streckenmeter die Radarvorhersage etwas wusste. */
  rainCoveredM: number;
  /** Länge der Strecke — damit die Anzeige „nur bis km X geprüft" sagen kann. */
  lengthM: number;
  /** Ankunft (ms). */
  arrivalMs: number;
}

export interface SituationInput {
  route: RouteResult;
  /** Abfahrt; ohne Angabe jetzt. */
  departMs?: number;
  warnings?: WarningFeature[];
  civil?: CivilWarning[];
  traffic?: TrafficIncident[];
  wind?: WindField | null;
  radar?: RadarForecast | null;
}

/** Abstand zweier Proben entlang der Strecke. */
const STEP_M = 250;
/** Mehr Proben lohnen nicht — bei sehr langen Routen wird der Abstand größer. */
const MAX_SAMPLES = 600;

/** Ab hier gilt es als Regen (mm/h). */
const RAIN_MIN = 0.3;
/** Böen ab hier sind eine Meldung wert (km/h). */
const WIND_MIN = 45;
/** So nah muss eine Verkehrsmeldung an der Strecke liegen, um zu zählen. */
const TRAFFIC_NEAR_M = 400;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** „bei km 42" bzw. „ab km 42" — Meter sind auf der Strecke nicht die Einheit. */
export const kmLabel = (m: number): string =>
  m < 1000 ? `${Math.round(m / 100) * 100} m` : `km ${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')}`;

/**
 * Weg-Zeit-Verlauf der Route.
 *
 * Jede Anweisung nennt den Geometriepunkt, an dem sie steht, dazu Länge und
 * Dauer bis zur nächsten. Daraus wird eine stückweise lineare Abbildung
 * Streckenmeter → Sekunden; sie ist genauer als eine Durchschnittsgeschwindigkeit,
 * weil sie Autobahn und Ortsdurchfahrt auseinanderhält.
 */
function timeline(route: RouteResult): {
  cum: number[];
  at: (m: number) => number;
} {
  const coords = route.coordinates;
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1]! + distance(coords[i - 1]!, coords[i]!));
  }
  const total = cum[cum.length - 1] ?? 0;

  // Stützstellen: Streckenmeter → Sekunden ab Abfahrt.
  const marks: { m: number; s: number }[] = [{ m: 0, s: 0 }];
  let s = 0;
  for (const step of route.steps) {
    s += step.durationS;
    const m = cum[Math.min(step.index, cum.length - 1)] ?? 0;
    // Die Dauer eines Schrittes gilt bis zur *nächsten* Anweisung.
    marks.push({ m: Math.min(total, m + step.distanceM), s });
  }
  marks.sort((a, b) => a.m - b.m);

  const at = (m: number): number => {
    if (m <= 0) return 0;
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1]!;
      const b = marks[i]!;
      if (m <= b.m) {
        const span = b.m - a.m;
        return span > 0 ? a.s + ((m - a.m) / span) * (b.s - a.s) : a.s;
      }
    }
    return route.durationS;
  };
  return { cum, at };
}

/** Punkt auf der Strecke bei Streckenmeter `m`. */
function pointAt(coords: [number, number][], cum: number[], m: number): [number, number] {
  if (m <= 0) return coords[0]!;
  for (let i = 1; i < cum.length; i++) {
    if (m <= cum[i]!) {
      const span = cum[i]! - cum[i - 1]!;
      const t = span > 0 ? (m - cum[i - 1]!) / span : 0;
      const a = coords[i - 1]!;
      const b = coords[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return coords[coords.length - 1]!;
}

/** Gilt eine Warnung zu diesem Zeitpunkt? Fehlende Zeiten heißen „gilt". */
function validAt(onset: string | null | undefined, expires: string | null | undefined, ms: number): boolean {
  const from = onset ? new Date(onset).getTime() : NaN;
  const to = expires ? new Date(expires).getTime() : NaN;
  if (!Number.isNaN(from) && ms < from) return false;
  if (!Number.isNaN(to) && ms > to) return false;
  return true;
}

const LEVEL_OF_SEVERITY: Record<string, RouteEventLevel> = {
  minor: 'note',
  moderate: 'note',
  severe: 'warn',
  extreme: 'alarm',
};

/**
 * Zusammenhängende Abschnitte aus einer Reihe von Proben.
 *
 * Regen und Wind sind keine Punkte, sondern Strecken: „ab km 12 bis km 19".
 * Kurze Lücken (eine Probe) werden überbrückt, sonst zerfällt ein Schauer in
 * ein Dutzend Meldungen.
 */
function stretches<T>(
  samples: (T | null)[],
  key: (v: T) => string,
): { from: number; to: number; values: T[] }[] {
  const out: { from: number; to: number; values: T[] }[] = [];
  let cur: { from: number; to: number; values: T[]; key: string } | null = null;
  let gap = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v == null) {
      if (cur && ++gap > 1) {
        out.push({ from: cur.from, to: cur.to, values: cur.values });
        cur = null;
      }
      continue;
    }
    const k = key(v);
    if (cur && cur.key === k) {
      cur.to = i;
      cur.values.push(v);
      gap = 0;
    } else {
      if (cur) out.push({ from: cur.from, to: cur.to, values: cur.values });
      cur = { from: i, to: i, values: [v], key: k };
      gap = 0;
    }
  }
  if (cur) out.push({ from: cur.from, to: cur.to, values: cur.values });
  return out;
}

const LEVEL_RANK: Record<RouteEventLevel, number> = { note: 0, warn: 1, alarm: 2 };

/** Regenstärke → Stufe und Wort. */
function rainLevel(mmH: number): { level: RouteEventLevel; word: string } {
  if (mmH >= 10) return { level: 'alarm', word: 'starker Regen' };
  if (mmH >= 2.5) return { level: 'warn', word: 'mäßiger Regen' };
  return { level: 'note', word: 'leichter Regen' };
}

/** Böenstärke → Stufe und Wort. */
function windLevel(kmh: number): { level: RouteEventLevel; word: string } {
  if (kmh >= 90) return { level: 'alarm', word: 'orkanartige Böen' };
  if (kmh >= 70) return { level: 'warn', word: 'schwere Sturmböen' };
  return { level: 'note', word: 'starke Böen' };
}

/**
 * Das Lagebild der Strecke.
 *
 * Asynchron nur wegen des Radars: Jeder Vorhersage-Frame muss ausgepackt
 * werden, und gebraucht werden nur die, in deren Zeitfenster die Fahrt fällt.
 */
export async function routeSituation(input: SituationInput): Promise<RouteSituation> {
  const { route } = input;
  const depart = input.departMs ?? Date.now();
  const coords = route.coordinates;
  const { cum, at } = timeline(route);
  const lengthM = cum[cum.length - 1] ?? route.distanceM;
  const arrivalMs = depart + route.durationS * 1000;

  const stepM = Math.max(STEP_M, Math.ceil(lengthM / MAX_SAMPLES));
  const marks: { m: number; ms: number; lon: number; lat: number }[] = [];
  for (let m = 0; m <= lengthM; m += stepM) {
    const [lon, lat] = pointAt(coords, cum, m);
    marks.push({ m, ms: depart + at(m) * 1000, lon, lat });
  }

  const events: RouteEvent[] = [];
  const add = (e: RouteEvent) => events.push(e);

  /* --- Amtliche Warnungen: gelten sie dort und dann? --- */
  for (const w of input.warnings ?? []) {
    const hits = marks.map((p) =>
      validAt(w.onset, w.expires, p.ms) && pointInGeometry({ lat: p.lat, lon: p.lon }, w.geometry) ? p : null,
    );
    for (const s of stretches(hits, () => w.id)) {
      const a = marks[s.from]!;
      add({
        kind: 'warning',
        level: LEVEL_OF_SEVERITY[w.severity] ?? 'warn',
        fromM: a.m,
        toM: marks[s.to]!.m,
        atMs: a.ms,
        title: w.headline,
        detail: `DWD${w.regionName ? ` · ${w.regionName}` : ''}`,
        lat: a.lat,
        lon: a.lon,
      });
    }
  }

  /* --- Behördenwarnungen: seltener, dafür immer ernst zu nehmen. --- */
  for (const w of input.civil ?? []) {
    const hits = marks.map((p) =>
      validAt(w.onset, w.expires, p.ms) && pointInGeometry({ lat: p.lat, lon: p.lon }, w.geometry) ? p : null,
    );
    for (const s of stretches(hits, () => w.id)) {
      const a = marks[s.from]!;
      add({
        kind: 'civil',
        level: w.urgent ? 'alarm' : 'warn',
        fromM: a.m,
        toM: marks[s.to]!.m,
        atMs: a.ms,
        title: w.headline,
        detail: w.channel,
        lat: a.lat,
        lon: a.lon,
      });
    }
  }

  /* --- Wind: die Böe zählt, nicht das Mittel. --- */
  const grid = input.wind ? new WindGrid(input.wind) : null;
  if (grid?.valid) {
    const gusts = marks.map((p) => {
      const v = grid.gustAt(p.lat, p.lon);
      return v >= WIND_MIN ? { p, v } : null;
    });
    for (const s of stretches(gusts, (g) => windLevel(g.v).level)) {
      const peak = Math.max(...s.values.map((g) => g.v));
      const { level, word } = windLevel(peak);
      const a = marks[s.from]!;
      add({
        kind: 'wind',
        level,
        fromM: a.m,
        toM: marks[s.to]!.m,
        atMs: a.ms,
        title: `${word} bis ${Math.round(peak)} km/h`,
        detail: 'Windvorhersage, 10 m über Grund',
        lat: a.lat,
        lon: a.lon,
      });
    }
  }

  /* --- Regen: der eigentliche Grund für dieses Lagebild. --- */
  let rainCoveredM = 0;
  const forecast = input.radar;
  if (forecast?.frames.length && forecast.corners.length === 4) {
    const frames = forecast.frames
      .map((f) => ({ ...f, ms: new Date(f.time).getTime() }))
      .sort((a, b) => a.ms - b.ms);
    const cache = new Map<string, Uint16Array | null>();
    const gridOf = async (data: string): Promise<Uint16Array | null> => {
      if (!cache.has(data)) {
        try {
          cache.set(data, await inflateGrid(data));
        } catch {
          cache.set(data, null);
        }
      }
      return cache.get(data) ?? null;
    };

    const rain: ({ p: (typeof marks)[number]; mmH: number } | null)[] = [];
    for (const p of marks) {
      const pos = gridPositionAt(forecast.corners, forecast.width, forecast.height, p.lat, p.lon);
      if (!pos) {
        rain.push(null);
        continue;
      }
      // Der Frame, dessen Zeitpunkt der Durchfahrt am nächsten liegt. Liegt die
      // Durchfahrt hinter dem letzten Frame, weiß das Radar nichts mehr —
      // ehrlicher als den letzten Stand fortzuschreiben.
      const frame = frames.reduce((best, f) =>
        Math.abs(f.ms - p.ms) < Math.abs(best.ms - p.ms) ? f : best,
      );
      if (Math.abs(frame.ms - p.ms) > 20 * 60 * 1000) {
        rain.push(null);
        continue;
      }
      rainCoveredM = p.m;
      const g = await gridOf(frame.data);
      if (!g) {
        rain.push(null);
        continue;
      }
      const mmH = rateAt(g, forecast.width, forecast.height, pos);
      rain.push(mmH >= RAIN_MIN ? { p, mmH } : null);
    }

    for (const s of stretches(rain, (r) => rainLevel(r.mmH).level)) {
      const peak = Math.max(...s.values.map((r) => r.mmH));
      const { level, word } = rainLevel(peak);
      const a = marks[s.from]!;
      const b = marks[s.to]!;
      add({
        kind: 'rain',
        level,
        fromM: a.m,
        toM: b.m,
        atMs: a.ms,
        title: `${word}${peak >= 2.5 ? ` (${peak.toFixed(peak < 10 ? 1 : 0).replace('.', ',')} mm/h)` : ''}`,
        detail:
          a.m === b.m
            ? `gegen ${clock(a.ms)}`
            : `${clock(a.ms)} bis ${clock(b.ms)} · Radarvorhersage`,
        lat: a.lat,
        lon: a.lon,
      });
    }
  }

  /* --- Verkehrsmeldungen in Streckennähe. --- */
  for (const t of input.traffic ?? []) {
    const c = t.coordinates;
    if (!c) continue;
    let best = Infinity;
    let bestIndex = 0;
    for (let i = 0; i < marks.length; i++) {
      const d = distance([c.lon, c.lat], [marks[i]!.lon, marks[i]!.lat]);
      if (d < best) {
        best = d;
        bestIndex = i;
      }
    }
    if (best > TRAFFIC_NEAR_M) continue;
    const p = marks[bestIndex]!;
    add({
      kind: 'traffic',
      level: t.kind === 'closure' ? 'alarm' : t.kind === 'jam' ? 'warn' : 'note',
      fromM: p.m,
      toM: p.m,
      atMs: p.ms,
      title: t.title,
      detail: `${t.road} · ${
        { roadworks: 'Baustelle', closure: 'Sperrung', warning: 'Gefahr', jam: 'Stau' }[t.kind]
      }`,
      lat: c.lat,
      lon: c.lon,
    });
  }

  /* --- Dunkelheit: bei Rad und zu Fuß entscheidet sie über die Tour. --- */
  const dark = marks.map((p) => (sunAltitude(new Date(p.ms), p.lat, p.lon) < -0.833 ? p : null));
  const firstDark = dark.findIndex((p) => p != null);
  if (firstDark > 0) {
    const p = marks[firstDark]!;
    add({
      kind: 'dark',
      level: route.profile === 'car' ? 'note' : 'warn',
      fromM: p.m,
      toM: lengthM,
      atMs: p.ms,
      title: `Ab hier im Dunkeln (Sonnenuntergang ${clock(p.ms)})`,
      detail: `noch ${kmLabel(lengthM - p.m)} bis zum Ziel`,
      lat: p.lat,
      lon: p.lon,
    });
  }

  events.sort((a, b) => a.fromM - b.fromM || LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  return { events, rainCoveredM, lengthM, arrivalMs };
}

/** Die schwerste Stufe im Lagebild — für die Überschrift. */
export function worstLevel(events: RouteEvent[]): RouteEventLevel | null {
  let worst: RouteEventLevel | null = null;
  for (const e of events) if (!worst || LEVEL_RANK[e.level] > LEVEL_RANK[worst]) worst = e.level;
  return worst;
}
