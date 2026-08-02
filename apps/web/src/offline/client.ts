/**
 * Zugang zum Offline-Worker: eine Instanz für die ganze App, Anfragen als
 * Versprechen. Der Worker wird erst erzeugt, wenn wirklich etwas gebraucht
 * wird — die meisten Sitzungen laufen ohne Routenplanung.
 */

import type { Coords, GeoResult, RouteOutcome, RouteProfile } from '@lagebild/shared';
import type { WorkerRequest, WorkerResponse } from './worker.js';
import type { HouseNumber } from './search.js';

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
export const routeOffline = (
  codes: string[],
  from: Coords,
  to: Coords,
  profile: RouteProfile,
  options: { alternatives?: number; avoidMotorways?: boolean } = {},
) => call<RouteOutcome>({ type: 'route', codes, from, to, profile, ...options });
