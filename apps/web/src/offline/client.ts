/**
 * Zugang zum Offline-Worker: eine Instanz für die ganze App, Anfragen als
 * Versprechen. Der Worker wird erst erzeugt, wenn wirklich etwas gebraucht
 * wird — die meisten Sitzungen laufen ohne Routenplanung.
 */

import type { Coords, GeoResult, RouteOutcome, RouteProfile } from '@lagebild/shared';
import type { WorkerRequest, WorkerResponse } from './worker.js';
import type { HouseNumber } from './search.js';
import type { ContourLine, ElevationProfile, ShadowImage, SightResult, TerrainImage } from './terrain.js';
import type { TrailResult } from './trails.js';
import type { DangerZone, EscapeOutcome, ReachResult } from './router.js';
import type { PopulationResult } from './population.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Anfrage ohne die vom Client vergebene Kennung (verteilt über die Union). */
type RequestBody<T> = T extends { id: number } ? Omit<T, 'id'> : never;
type WorkerCall = RequestBody<WorkerRequest>;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const res = event.data;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    if (res.ok) entry.resolve(res.data);
    else entry.reject(new Error(res.error ?? 'Offline-Worker meldet einen Fehler'));
  };
  worker.onerror = (event) => {
    for (const [, entry] of pending) entry.reject(new Error(event.message || 'Worker-Fehler'));
    pending.clear();
  };
  return worker;
}

function call<T>(msg: WorkerCall): Promise<T> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...msg, id } as WorkerRequest);
  });
}

/** Suchindex einer Region vorladen (liefert Kennzahlen zurück). */
export const loadSearchIndex = (code: string) =>
  call<{ entries: number; terms: number }>({ type: 'loadSearch', code });

/** Routing-Graph einer oder mehrerer Regionen vorladen (mehrere = ein Netz). */
export const loadRouteGraph = (codes: string[]) =>
  call<{ nodes: number; edges: number; restrictions: number }>({ type: 'loadRoute', codes });

/** Offline-Suche in einer Region. */
export const searchOffline = (code: string, q: string, near?: Coords, limit?: number) =>
  call<GeoResult[]>({ type: 'search', code, q, near, limit });

/** Haltestellen im Ausschnitt (aus dem Suchindex der Region). */
export const stopsOffline = (
  code: string,
  bbox: { west: number; south: number; east: number; north: number },
  limit?: number,
) => call<GeoResult[]>({ type: 'stops', code, bbox, limit });

/**
 * Punkte bestimmter Kategorien im Ausschnitt — für die Notfall-Ebene
 * (Klinik, Apotheke, Polizei, Feuerwehr …) direkt aus dem Offline-Index.
 */
export const poisOffline = (
  code: string,
  categories: string[],
  bbox: { west: number; south: number; east: number; north: number },
  limit?: number,
) => call<GeoResult[]>({ type: 'poi', code, categories, bbox, limit });

/** Hausnummern einer Straße. */
export const houseNumbersOffline = (code: string, entryId: number) =>
  call<HouseNumber[]>({ type: 'houses', code, entryId });

/**
 * Route zwischen zwei Punkten (rein lokal gerechnet). `codes` sind alle
 * Regionen, die auf dem Weg liegen könnten — sie werden zu einem Netz
 * verbunden, damit Routen nicht an der Landesgrenze enden.
 */
/**
 * Höhenprofil einer Linie aus dem Höhenpaket der Region (oder aus den Höhen,
 * die eine eingelesene Datei selbst mitbringt).
 */
export const elevationOffline = (
  codes: string[],
  line: [number, number][],
  own?: (number | undefined)[],
) => call<ElevationProfile | null>({ type: 'elevation', codes, line, own });

/** Wander- und Radwege im Ausschnitt (aus dem Routing-Paket). */
export const trailsOffline = (
  codes: string[],
  bbox: { west: number; south: number; east: number; north: number },
  kinds: number,
  limit?: number,
) => call<TrailResult>({ type: 'trails', codes, bbox, kinds, limit });

/** Höhe eines einzelnen Punktes (Meter über NN) aus dem Geländepaket. */
export const elevationAtOffline = (codes: string[], lat: number, lon: number) =>
  call<number | null>({ type: 'elevationAt', codes, lat, lon });

/** Höhenlinien im Ausschnitt (aus dem Geländepaket). */
export const contoursOffline = (
  codes: string[],
  bbox: { west: number; south: number; east: number; north: number },
  intervalM?: number,
) => call<{ lines: ContourLine[]; intervalM: number }>({ type: 'contours', codes, bbox, intervalM });

/**
 * Sichtverbindung zwischen zwei Punkten: Geländeschnitt mit Erdkrümmung und
 * Fresnelzone. Rechnet allein aus dem Geländepaket im Gerät.
 */
export const sightOffline = (
  codes: string[],
  from: Coords,
  to: Coords,
  options: { fromHeightM?: number; toHeightM?: number; freqMHz?: number } = {},
) => call<SightResult | null>({ type: 'sight', codes, from, to, ...options });

/** Geländebild einer Region (Höhenfarben mit Schummerung) für die Kartenebene. */
export const terrainImageOffline = (code: string, maxSize?: number) =>
  call<TerrainImage | null>({ type: 'terrainImage', code, maxSize });

/**
 * Wie viele Menschen wohnen in dieser Fläche? Aus dem Bevölkerungsraster des
 * Zensus, das als eigenes Paket im Gerät liegt. `null`, wenn für die Gegend
 * keins geladen ist.
 */
export const populationOffline = (
  codes: string[],
  query:
    | { ring: [number, number][] }
    | { center: Coords; radiusM: number; towardDeg?: number; halfAngleDeg?: number },
) => call<(PopulationResult & { code: string }) | null>({ type: 'population', codes, ...query });

/**
 * Schattenwurf des Geländes zu einem Sonnenstand — als Bild, das die Karte
 * über die Region legt.
 */
export const shadowOffline = (
  code: string,
  altitudeDeg: number,
  azimuthDeg: number,
  maxSize?: number,
) => call<ShadowImage | null>({ type: 'shadow', code, altitudeDeg, azimuthDeg, maxSize });

/**
 * Erreichbarkeit: das Straßennetz, das in der gegebenen Zeit befahrbar ist —
 * eingefärbt nach Fahrzeit.
 */
export const reachOffline = (codes: string[], from: Coords, profile: RouteProfile, budgetS: number) =>
  call<ReachResult>({ type: 'reach', codes, from, profile, budgetS });

/**
 * Fahrzeiten zu mehreren Zielen in einer Suche — für „welche Anlaufstelle ist
 * wirklich am schnellsten da?" statt der Luftlinie.
 */
export const travelTimesOffline = (
  codes: string[],
  from: Coords,
  targets: Coords[],
  profile: RouteProfile,
  budgetS: number,
) => call<(number | null)[]>({ type: 'travelTimes', codes, from, targets, profile, budgetS });

/**
 * Der schnellste Weg **weg von** einer Gefahr — kein Ziel, sondern eine
 * Bedingung: weit genug entfernt und, wenn Wind gemeldet ist, nicht in der
 * Fahne stromab.
 */
export const escapeOffline = (
  codes: string[],
  from: Coords,
  profile: RouteProfile,
  danger: DangerZone,
  options: { minDistanceM?: number; avoidMotorways?: boolean } = {},
) => call<EscapeOutcome>({ type: 'escape', codes, from, profile, danger, ...options });

export const routeOffline = (
  codes: string[],
  from: Coords,
  to: Coords,
  profile: RouteProfile,
  options: { alternatives?: number; avoidMotorways?: boolean; via?: Coords[] } = {},
) => call<RouteOutcome>({ type: 'route', codes, from, to, profile, ...options });
