/**
 * Bahndaten als eigenes, herunterladbares Paket — und die Überflugrechnung
 * darauf.
 *
 * Die Elemente sind klein (ein paar Dutzend Kilobyte) und gelten Tage. Deshalb
 * werden sie **einmal geholt und behalten**, nicht bei jedem Blick neu: Danach
 * sagt die App auch ohne Netz voraus, wann was über den Horizont kommt. Alt
 * werden sie trotzdem, und das steht in der Oberfläche — nach einer Woche
 * liegen die Zeiten schon Minuten daneben.
 */

import type { SatelliteSet } from '@lagebild/shared';
import { db } from './db.js';
import { initSat, observe, type Satrec } from './sgp4.js';

const KEY = 'sat:tle';

export interface StoredSatSet {
  set: SatelliteSet;
  /** Wann heruntergeladen. */
  savedAt: number;
  /** Wie viele Bytes die Elemente belegen (roh geschätzt). */
  bytes: number;
  groups: string[];
}

export const SAT_GROUPS: { id: string; label: string; hint: string }[] = [
  { id: 'stations', label: 'Raumstationen', hint: 'ISS, Tiangong' },
  { id: 'weather', label: 'Wetter', hint: 'NOAA, Meteor — APT-Empfang' },
  { id: 'amateur', label: 'Amateurfunk', hint: 'Relais im Orbit' },
  { id: 'visual', label: 'Sichtbar', hint: 'mit bloßem Auge' },
];

/** Gespeichertes Paket lesen (oder `null`). */
export async function loadSatSet(): Promise<StoredSatSet | null> {
  const row = await db.cache.get(KEY);
  if (!row) return null;
  const value = row.value as StoredSatSet | undefined;
  return value?.set?.satellites?.length ? value : null;
}

/** Paket herunterladen und behalten. */
export async function downloadSatSet(groups: string[]): Promise<StoredSatSet> {
  const res = await fetch(`/api/sat/tle?groups=${encodeURIComponent(groups.join(','))}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Bahndaten nicht erhalten (HTTP ${res.status})`);
  const body = (await res.json()) as { data: SatelliteSet };
  const set = body.data;
  if (!set?.satellites?.length) throw new Error('Das Paket kam leer an.');
  const stored: StoredSatSet = {
    set,
    savedAt: Date.now(),
    bytes: set.satellites.reduce((n, s) => n + s.name.length + s.line1.length + s.line2.length + 3, 0),
    groups,
  };
  await db.cache.put({ key: KEY, value: stored, savedAt: stored.savedAt });
  return stored;
}

export async function deleteSatSet(): Promise<void> {
  await db.cache.delete(KEY);
}

/* ------------------------------------------------------------------ */
/* Auswahl: welche Satelliten liegen auf der Karte?                     */
/* ------------------------------------------------------------------ */

const SELECTION_KEY = 'lagebild.sat.gewaehlt';

/**
 * Bahnen sind teuer zu rechnen und die Karte wird schnell unleserlich —
 * deshalb liegt nicht das ganze Paket auf der Karte, sondern eine Auswahl.
 * Sie überlebt den Neustart, damit die eigenen Satelliten beim nächsten Mal
 * wieder da sind.
 */
export function loadSatSelection(): string[] {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSatSelection(ids: string[]): void {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
  } catch {
    /* voller Speicher darf nichts anhalten */
  }
}

/**
 * Aufbereitete Bahnen, nach der ersten Zeile des TLE gemerkt.
 *
 * Die Karte rechnet alle paar Sekunden neu; die Aufbereitung jedes Mal zu
 * wiederholen wäre der teuerste Teil daran — die Elemente ändern sich aber
 * nur, wenn ein neues Paket geladen wird.
 */
const prepared = new Map<string, Satrec | null>();

export function satrecOf(tle: { name: string; line1: string; line2: string }): Satrec | null {
  const key = tle.line1;
  if (!prepared.has(key)) prepared.set(key, initSat(tle));
  return prepared.get(key) ?? null;
}

export interface SatPosition {
  id: string;
  name: string;
  group?: string;
  /** Punkt unter dem Satelliten. */
  lat: number;
  lon: number;
  altitudeKm: number;
  /** Vom Beobachter aus: über dem Horizont? */
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
}

/** Aktuelle Position der gewählten Satelliten. */
export function positionsAt(
  set: SatelliteSet,
  ids: string[],
  ms: number,
  observer: { lat: number; lon: number },
): SatPosition[] {
  const wanted = new Set(ids);
  const out: SatPosition[] = [];
  for (const tle of set.satellites) {
    const sat = satrecOf(tle);
    if (!sat || !wanted.has(sat.id)) continue;
    const look = observe(sat, ms, observer);
    if (!look) continue;
    out.push({
      id: sat.id,
      name: tle.name,
      group: tle.group,
      lat: look.subLat,
      lon: look.subLon,
      altitudeKm: Math.round(look.altitudeKm),
      elevationDeg: Math.round(look.elevationDeg * 10) / 10,
      azimuthDeg: Math.round(look.azimuthDeg),
      rangeKm: Math.round(look.rangeKm),
    });
  }
  return out;
}

/**
 * Die Bodenspur: wo der Satellit war und wo er hinzieht.
 *
 * Zurückgegeben werden **mehrere** Linienzüge, weil die Spur am Datumswechsel
 * um 360 Grad springt — als eine Linie gezeichnet liefe sie einmal quer über
 * die ganze Karte.
 */
export function groundTrack(
  tle: { name: string; line1: string; line2: string },
  ms: number,
  options: { backMin?: number; aheadMin?: number; stepS?: number } = {},
): [number, number][][] {
  const sat = satrecOf(tle);
  if (!sat) return [];
  // Ohne Vorgabe je eine halbe Umlaufzeit vor und zurück — das ist genau der
  // Bogen, den man auf der Karte im Zusammenhang sieht.
  const back = options.backMin ?? sat.periodMin / 2;
  const ahead = options.aheadMin ?? sat.periodMin / 2;
  const step = (options.stepS ?? 20) * 1000;
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  let lastLon: number | null = null;
  for (let t = ms - back * 60000; t <= ms + ahead * 60000; t += step) {
    const look = observe(sat, t, { lat: 0, lon: 0 });
    if (!look) continue;
    if (lastLon != null && Math.abs(look.subLon - lastLon) > 180) {
      if (current.length > 1) lines.push(current);
      current = [];
    }
    current.push([look.subLon, look.subLat]);
    lastLon = look.subLon;
  }
  if (current.length > 1) lines.push(current);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Überflüge                                                           */
/* ------------------------------------------------------------------ */

export interface Pass {
  name: string;
  id: string;
  group?: string;
  /** Aufgang über den Horizont. */
  startMs: number;
  /** Untergang. */
  endMs: number;
  /** Höchststand. */
  peakMs: number;
  maxElevationDeg: number;
  startAzimuthDeg: number;
  peakAzimuthDeg: number;
  endAzimuthDeg: number;
  /** Kürzeste Entfernung im Überflug. */
  minRangeKm: number;
}

export interface PassOptions {
  /** Beginn des Zeitfensters (Vorgabe: jetzt). */
  fromMs?: number;
  /** Länge des Fensters in Stunden. */
  hours?: number;
  /** Nur Überflüge, die mindestens so hoch steigen. */
  minElevationDeg?: number;
  /** Höchstzahl der Ergebnisse. */
  limit?: number;
}

/** Schrittweite der Grobsuche — ein Überflug dauert Minuten, das reicht. */
const STEP_MS = 60000;
/** Genauigkeit, auf die Auf- und Untergang eingegrenzt werden. */
const REFINE_MS = 2000;

/** Zeitpunkt des Horizontdurchgangs zwischen zwei Proben einschachteln. */
function crossing(
  sat: Satrec,
  observer: { lat: number; lon: number; altKm?: number },
  loMs: number,
  hiMs: number,
): number {
  let lo = loMs;
  let hi = hiMs;
  while (hi - lo > REFINE_MS) {
    const mid = (lo + hi) / 2;
    const el = observe(sat, mid, observer)?.elevationDeg ?? -90;
    if (el < 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Alle Überflüge eines Satelliten im Zeitfenster.
 *
 * Grob abtasten, bis die Höhe über den Horizont steigt, dann Auf- und Untergang
 * einschachteln und dazwischen den Höchststand suchen. Mehr Aufwand lohnt
 * nicht: Bahnelemente von gestern tragen ohnehin schon Sekunden Unsicherheit.
 */
export function passesOf(
  sat: Satrec,
  observer: { lat: number; lon: number; altKm?: number },
  options: PassOptions = {},
): Pass[] {
  const from = options.fromMs ?? Date.now();
  const until = from + (options.hours ?? 24) * 3600000;
  const minEl = options.minElevationDeg ?? 10;
  const out: Pass[] = [];

  let prevEl = observe(sat, from, observer)?.elevationDeg ?? -90;
  let riseMs: number | null = prevEl > 0 ? from : null;
  let peakEl = prevEl;
  let peakMs = from;

  for (let t = from + STEP_MS; t <= until; t += STEP_MS) {
    const look = observe(sat, t, observer);
    const el = look?.elevationDeg ?? -90;
    if (el > peakEl) {
      peakEl = el;
      peakMs = t;
    }
    if (prevEl <= 0 && el > 0) {
      riseMs = crossing(sat, observer, t - STEP_MS, t);
      peakEl = el;
      peakMs = t;
    } else if (prevEl > 0 && el <= 0 && riseMs != null) {
      const setMs = crossing(sat, observer, t, t - STEP_MS);
      // Höchststand feiner suchen: zehn Proben über den Überflug.
      let bestMs = peakMs;
      let bestEl = peakEl;
      const span = setMs - riseMs;
      for (let i = 0; i <= 20; i++) {
        const ms = riseMs + (span * i) / 20;
        const e = observe(sat, ms, observer)?.elevationDeg ?? -90;
        if (e > bestEl) {
          bestEl = e;
          bestMs = ms;
        }
      }
      if (bestEl >= minEl) {
        const a = observe(sat, riseMs, observer);
        const b = observe(sat, bestMs, observer);
        const c = observe(sat, setMs, observer);
        out.push({
          name: sat.name,
          id: sat.id,
          startMs: riseMs,
          endMs: setMs,
          peakMs: bestMs,
          maxElevationDeg: Math.round(bestEl * 10) / 10,
          startAzimuthDeg: Math.round(a?.azimuthDeg ?? 0),
          peakAzimuthDeg: Math.round(b?.azimuthDeg ?? 0),
          endAzimuthDeg: Math.round(c?.azimuthDeg ?? 0),
          minRangeKm: Math.round(b?.rangeKm ?? 0),
        });
      }
      riseMs = null;
      peakEl = -90;
    }
    prevEl = el;
  }
  return out;
}

/**
 * Überflüge aller Satelliten des Pakets, nach Zeit sortiert.
 *
 * Rechnet in Häppchen und gibt zwischendurch den Faden frei — bei dreihundert
 * Satelliten über zwei Tage sind das einige Millionen Bahnpunkte, und die
 * Oberfläche soll dabei nicht stehen.
 */
export async function nextPasses(
  set: SatelliteSet,
  observer: { lat: number; lon: number; altKm?: number },
  options: PassOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<Pass[]> {
  const all: Pass[] = [];
  const total = set.satellites.length;
  for (let i = 0; i < total; i++) {
    const tle = set.satellites[i]!;
    const sat = satrecOf(tle);
    if (sat) {
      for (const p of passesOf(sat, observer, options)) all.push({ ...p, group: tle.group });
    }
    // Alle zwanzig Satelliten einen Atemzug lang zurück an den Browser.
    if (i % 20 === 19) {
      onProgress?.(i + 1, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  all.sort((a, b) => a.startMs - b.startMs);
  return options.limit ? all.slice(0, options.limit) : all;
}
