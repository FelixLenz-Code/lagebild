/**
 * Hintergrund-Warnungen — die Seite der App.
 *
 * Die eigentliche Arbeit macht der Service Worker (`public/sw-warnings.js`);
 * hier wird nur an- und abgemeldet und die Liste der beobachteten Orte
 * hinterlegt, die er lesen soll. Der Worker kommt an den localStorage nicht
 * heran, deshalb liegt die Liste in derselben IndexedDB, die auch den
 * Offline-Vorrat hält.
 *
 * **Was das kann und was nicht:** Der Browser weckt die App gelegentlich und
 * lässt sie nachsehen — er entscheidet wann, und er tut es nur, wenn die App
 * installiert ist und regelmäßig benutzt wird. Das ist eine Zugabe, kein
 * Warndienst: Für Warnungen, auf die es ankommt, bleiben Sirene, Rundfunk und
 * die Warn-Apps des Bundes zuständig. Genau so steht es auch in den
 * Einstellungen.
 */

import { db } from './db.js';
import type { WatchedPlace } from './places.js';

/** Wecker-Kennung; dieselbe wie im Service Worker. */
const TAG = 'lagebild-warnungen';
const TARGETS_KEY = 'bg:targets';
/**
 * Wunschabstand zwischen zwei Prüfungen. Der Browser hält sich nicht daran,
 * sondern nimmt ihn als Untergrenze und entscheidet selbst — kürzer anzugeben
 * bringt nichts außer Akkuverbrauch.
 */
const MIN_INTERVAL_MS = 3 * 3600_000;

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

type RegistrationWithSync = ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager };

/** Kennt dieser Browser die Schnittstelle überhaupt? */
export function backgroundSyncSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'periodicSync' in (ServiceWorkerRegistration.prototype as object) &&
    'Notification' in window
  );
}

async function syncManager(): Promise<PeriodicSyncManager | null> {
  if (!backgroundSyncSupported()) return null;
  const reg = (await navigator.serviceWorker.ready) as RegistrationWithSync;
  return reg.periodicSync ?? null;
}

/** Läuft der Wecker gerade? */
export async function backgroundWarningsActive(): Promise<boolean> {
  try {
    const mgr = await syncManager();
    if (!mgr) return false;
    return (await mgr.getTags()).includes(TAG);
  } catch {
    return false;
  }
}

export type EnableResult =
  | 'ok'
  | 'unsupported'
  | 'no-notification-permission'
  | 'not-allowed'
  | 'failed';

/**
 * Einschalten. Scheitern kann das an drei Stellen, und die Oberfläche soll
 * jede einzeln benennen können — „hat nicht geklappt" hilft niemandem weiter.
 */
export async function enableBackgroundWarnings(): Promise<EnableResult> {
  if (!backgroundSyncSupported()) return 'unsupported';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'no-notification-permission';

    // Chromium vergibt das Recht auf Hintergrundarbeit nach eigener Einschätzung
    // („site engagement"): Eine gerade erst installierte App bekommt es oft
    // noch nicht. Deshalb wird der Zustand vorher abgefragt.
    const status = await navigator.permissions
      .query({ name: 'periodic-background-sync' as PermissionName })
      .catch(() => null);
    if (status && status.state === 'denied') return 'not-allowed';

    const mgr = await syncManager();
    if (!mgr) return 'unsupported';
    await mgr.register(TAG, { minInterval: MIN_INTERVAL_MS });
    return 'ok';
  } catch {
    return 'failed';
  }
}

export async function disableBackgroundWarnings(): Promise<void> {
  try {
    const mgr = await syncManager();
    await mgr?.unregister(TAG);
  } catch {
    /* Nicht angemeldet — dann ist auch nichts abzumelden. */
  }
}

/** Ein Ort, an dem im Hintergrund nach Warnungen gesehen wird. */
export interface BgTarget {
  name: string;
  lat: number;
  lon: number;
}

/**
 * Die zu beobachtenden Orte für den Worker hinterlegen: der eigene Standort und
 * die Orte aus „Meine Orte". Mehr als eine Handvoll wäre unhöflich gegenüber
 * dem Server und dem Akku — der Worker nimmt ohnehin nur die ersten acht.
 */
export async function syncBackgroundTargets(
  here: { lat: number; lon: number } | null,
  watched: WatchedPlace[],
): Promise<void> {
  const targets: BgTarget[] = [];
  if (here) targets.push({ name: 'Mein Standort', lat: here.lat, lon: here.lon });
  for (const p of watched) targets.push({ name: p.name, lat: p.lat, lon: p.lon });
  try {
    await db.cache.put({ key: TARGETS_KEY, value: targets.slice(0, 8), savedAt: Date.now() });
  } catch {
    /* Ohne Datenbank kein Hintergrundbetrieb — die App selbst bleibt davon unberührt. */
  }
}
