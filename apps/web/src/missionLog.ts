/**
 * Einsatz-Logbuch.
 *
 * **Grundregel: Es wird nur aufgezeichnet, solange ein Einsatz läuft.** Ohne
 * laufenden Einsatz tut `logEvent` nichts — die Aufrufe stehen an vielen
 * Stellen der App, aber sie schreiben nichts, sammeln nichts und legen nichts
 * an. Das ist Absicht: Ein Werkzeug, das im Alltag mitschreibt, wo jemand war
 * und was er getan hat, wäre etwas anderes als eines, das man für einen
 * bestimmten Einsatz einschaltet.
 *
 * Ein neuer Einsatz ist immer ein **neues** Logbuch; der vorherige wird dabei
 * geschlossen und bleibt zum Nachlesen und Ausgeben liegen. Alles steht im
 * localStorage des Geräts — nichts geht an den Server, der ohnehin keinen
 * Zustand hält.
 */

import type { Coords } from '@lagebild/shared';
import { formatDegMin } from './coords.js';

const KEY = 'lagebild.missions';
/** Mehr Einsätze hält das Gerät nicht vor; der älteste fällt heraus. */
const MAX_MISSIONS = 20;
/** Obergrenze je Einsatz — schützt den Speicher bei langen Lagen. */
const MAX_ENTRIES = 2000;

/** Art eines Eintrags. Bestimmt Symbol und Farbe in der Liste. */
export type LogKind =
  | 'start'
  | 'end'
  | 'note'
  | 'position'
  | 'route'
  | 'warning'
  | 'mark'
  | 'track';

export const KIND_DE: Record<LogKind, string> = {
  start: 'Einsatzbeginn',
  end: 'Einsatzende',
  note: 'Eintrag',
  position: 'Standort',
  route: 'Fahrt',
  warning: 'Warnung',
  mark: 'Markierung',
  track: 'Spur',
};

export interface LogEntry {
  id: string;
  /** Zeitpunkt (ISO). */
  at: string;
  kind: LogKind;
  text: string;
  lat?: number;
  lon?: number;
  /**
   * Kennzeichen für Ereignisse, die nur einmal je Einsatz eingetragen werden
   * sollen (siehe `logOnce`). Steht als eigenes Feld da und nicht im Text —
   * sonst müsste man es beim Anzeigen wieder herausschneiden.
   */
  key?: string;
}

export interface Mission {
  id: string;
  name: string;
  startedAt: string;
  /** null, solange der Einsatz läuft. */
  endedAt: string | null;
  entries: LogEntry[];
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadMissions(): Mission[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Mission[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  } catch {
    return [];
  }
}

function save(list: Mission[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_MISSIONS)));
  } catch {
    // Speicher voll oder gesperrt: Der laufende Einsatz bleibt im Zustand der
    // Oberfläche erhalten, nur das Sichern über einen Neustart hinweg fällt aus.
  }
  notify();
}

/** Der laufende Einsatz — oder null, und dann wird nichts aufgezeichnet. */
export function activeMission(): Mission | null {
  return loadMissions().find((m) => m.endedAt == null) ?? null;
}

/* ---------- Änderungen melden ---------- */

/**
 * Die Oberfläche zeigt das Logbuch an mehreren Stellen (Knopf in der Leiste,
 * Blatt, Punktmenü). Ein winziges Abonnement hält sie gleich, ohne dass der
 * Zustand durch die halbe App gereicht werden muss.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeMissions(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

/* ---------- Einsatz führen ---------- */

/**
 * Neuen Einsatz beginnen. Ein laufender wird dabei beendet — zwei gleichzeitige
 * Logbücher gäbe es im Ernstfall nicht, und die Frage „in welches schreibe ich
 * jetzt?" darf sich gar nicht erst stellen.
 */
export function startMission(name: string): Mission {
  const list = loadMissions();
  const running = list.find((m) => m.endedAt == null);
  if (running) closeMission(running);

  const now = new Date().toISOString();
  const mission: Mission = {
    id: newId(),
    name: name.trim() || `Einsatz ${new Date().toLocaleDateString('de-DE')}`,
    startedAt: now,
    endedAt: null,
    entries: [
      { id: newId(), at: now, kind: 'start', text: name.trim() || 'Einsatz begonnen' },
    ],
  };
  list.push(mission);
  save(list);
  return mission;
}

function closeMission(mission: Mission): void {
  const now = new Date().toISOString();
  mission.endedAt = now;
  mission.entries.push({ id: newId(), at: now, kind: 'end', text: 'Einsatz beendet' });
}

/** Laufenden Einsatz beenden. Das Logbuch bleibt erhalten. */
export function endMission(): void {
  const list = loadMissions();
  const running = list.find((m) => m.endedAt == null);
  if (!running) return;
  closeMission(running);
  save(list);
}

export function deleteMission(id: string): void {
  save(loadMissions().filter((m) => m.id !== id));
}

export function renameMission(id: string, name: string): void {
  const list = loadMissions();
  const m = list.find((x) => x.id === id);
  if (!m) return;
  m.name = name.trim() || m.name;
  save(list);
}

/**
 * Ereignis eintragen — **wirkungslos ohne laufenden Einsatz**.
 *
 * Gibt zurück, ob etwas geschrieben wurde; die Oberfläche kann daran erkennen,
 * ob eine Rückmeldung („ins Logbuch") angebracht ist.
 */
export function logEvent(kind: LogKind, text: string, at?: Coords | null): boolean {
  const list = loadMissions();
  const running = list.find((m) => m.endedAt == null);
  if (!running) return false;
  running.entries.push({
    id: newId(),
    at: new Date().toISOString(),
    kind,
    text,
    ...(at ? { lat: at.lat, lon: at.lon } : {}),
  });
  if (running.entries.length > MAX_ENTRIES) {
    running.entries.splice(0, running.entries.length - MAX_ENTRIES);
  }
  save(list);
  return true;
}

/**
 * Dasselbe, aber nur einmal je Schlüssel und Einsatz.
 *
 * Für Ereignisse, die die App wiederholt bemerkt, ohne dass etwas Neues
 * passiert ist — dieselbe Warnung liegt bei jeder Aktualisierung wieder vor,
 * und ein Logbuch mit vierzig identischen Zeilen ist wertlos.
 */
export function logOnce(key: string, kind: LogKind, text: string, at?: Coords | null): boolean {
  const list = loadMissions();
  const running = list.find((m) => m.endedAt == null);
  if (!running) return false;
  if (running.entries.some((e) => e.key === key)) return false;
  running.entries.push({
    id: newId(),
    at: new Date().toISOString(),
    kind,
    text,
    key,
    ...(at ? { lat: at.lat, lon: at.lon } : {}),
  });
  save(list);
  return true;
}

/* ---------- Ausgabe ---------- */

const stamp = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/**
 * Das Logbuch als Klartext — zum Weitergeben, Einfügen in einen Bericht oder
 * Ausdrucken. Bewusst kein eigenes Format: Eine Zeile je Ereignis, Uhrzeit
 * vorn, Koordinaten in der Schreibweise, die eine Leitstelle hören will.
 */
export function missionToText(mission: Mission): string {
  const head = [
    `Einsatz: ${mission.name}`,
    `Beginn: ${new Date(mission.startedAt).toLocaleString('de-DE')}`,
    mission.endedAt ? `Ende: ${new Date(mission.endedAt).toLocaleString('de-DE')}` : 'Ende: läuft noch',
    '',
  ];
  const lines = mission.entries.map((e) => {
    const where = e.lat != null && e.lon != null ? ` (${formatDegMin({ lat: e.lat, lon: e.lon })})` : '';
    return `${stamp(e.at)}  ${KIND_DE[e.kind]}: ${e.text}${where}`;
  });
  return [...head, ...lines].join('\n');
}

/** Die Einträge mit Ort als GeoJSON — für die Nachbereitung auf einer Karte. */
export function missionToGeoJson(mission: Mission): string {
  const features = mission.entries
    .filter((e) => e.lat != null && e.lon != null)
    .map((e) => ({
      type: 'Feature' as const,
      properties: { zeit: e.at, art: KIND_DE[e.kind], text: e.text },
      geometry: { type: 'Point' as const, coordinates: [e.lon as number, e.lat as number] },
    }));
  return JSON.stringify({ type: 'FeatureCollection', name: mission.name, features }, null, 2);
}
