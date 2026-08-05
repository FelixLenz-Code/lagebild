/**
 * Rettungs- und Notfallpunkte finden.
 *
 * **Rettungspunkte** sind die nummerierten Schilder im Wald und an Wegen. Sie
 * über die gewöhnliche Ortssuche zu finden, klappt nicht: Sie tragen keinen
 * Namen, sondern eine Kennung, und wer „Rettungspunkt 4915" tippt, meint mit
 * der Zahl keine Hausnummer. Deshalb ein eigener Weg — Kennung vergleichen,
 * Rest nach Nähe.
 *
 * Zwei Quellen, wie überall in der Suche: der **Offline-Index** der geladenen
 * Region (dafür muss das Paket neu gebaut sein, siehe `scripts/build-routing.mjs`)
 * und, mit Netz, die **Overpass-Abfrage** des Servers. Beides zusammen, doppelte
 * Punkte fliegen raus.
 *
 * **Notfallpunkte** — Klinik, Apotheke, Arzt, Polizei, Feuerwehr, Trinkwasser,
 * Schutzhütte — stehen bereits als POI im Index. Einzeln findet die Ortssuche
 * sie längst („Apotheke"); was fehlte, war das Sammelwort: Wer „Notfall" tippt,
 * will nicht acht Apotheken, sondern von jeder Art die nächste.
 */

import type { Coords, GeoResult } from '@lagebild/shared';
import { fetchRescue } from './api.js';
import { poisOffline } from './offline/client.js';
import { distanceM } from './offline/graph.js';

/** Punkte, die im Notfall zählen — alle stehen im Offline-Suchindex. */
export const EMERGENCY_CATEGORIES = [
  'hospital',
  'pharmacy',
  'doctor',
  'police',
  'fire_station',
  'drinking_water',
  'shelter',
];

/** Ein gefundener Rettungspunkt. */
export interface RescueHit {
  /** Kennung auf dem Schild — das, was man der Leitstelle durchgibt. */
  ref: string | null;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  /** Betreiber oder Notrufnummer, soweit bekannt. */
  detail: string | null;
  /** Aus dem gespeicherten Index, also auch ohne Netz zu haben. */
  offline: boolean;
}

/** Eine erkannte Suche nach Rettungspunkten. */
export interface RescueQuery {
  /** Gesuchte Kennung ohne Trennzeichen — null heißt „die nächsten". */
  ref: string | null;
  /** Dieselbe Kennung so, wie sie eingetippt wurde (für die Anzeige). */
  label: string | null;
}

/** Kennungen vergleichbar machen: „NRW-4915", „nrw 4915" → „nrw4915". */
const foldRef = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Die Wörter, mit denen man diese Punkte benennt — je nach Bundesland anders. */
const RESCUE_WORDS = /rettungs?(treff)?punkte?|notfall(treff)?punkte?|notruf(s?ä?ule)?|rettung/g;

/**
 * Kennung im Text: Landeskürzel und Zahl, wie sie auf den Schildern stehen.
 * Steht sie allein da, muss sie deutlich genug aussehen — sonst gerieten
 * Straßennummern („A9") und Hausnummern in den Rettungspunkt-Abschnitt.
 */
const REF_IN_TEXT = /[a-zäöü]{0,5}[-\s]?\d{1,6}[a-z]?/;
const REF_ALONE = /^(\d{3,6}[a-z]?|[a-zäöü]{1,5}[-\s]\d{1,6}[a-z]?)$/;

/**
 * Sieht die Eingabe nach einem Rettungspunkt aus? Zwei Fälle zählen: das Wort
 * ist genannt („Rettungspunkt", „Notfallpunkt"), oder da steht nichts als eine
 * Kennung — dann hat sie meistens jemand am Telefon vorgelesen.
 */
export function parseRescueQuery(raw: string): RescueQuery | null {
  const t = raw.trim().toLowerCase();
  if (t.length < 2) return null;
  // Erst das Schlagwort heraus, dann die Kennung: Sonst läse „Rettungspunkt
  // 4915" das Wortende als Teil der Kennung.
  const rest = t.replace(RESCUE_WORDS, ' ').trim();
  if (rest.length < t.length) {
    const hit = rest.match(REF_IN_TEXT);
    const label = hit?.[0].trim() || null;
    return { ref: label ? foldRef(label) : null, label };
  }
  if (REF_ALONE.test(t)) return { ref: foldRef(t), label: t };
  return null;
}

/** Fragt die Eingabe nach Notfallpunkten als Gruppe? */
export function isEmergencyQuery(raw: string): boolean {
  return /notfall|notdienst|erste hilfe|anlaufstelle/.test(raw.trim().toLowerCase());
}

/**
 * Suchausschnitt um den Bezugspunkt. Ohne Kennung zählt nur die Umgebung; mit
 * Kennung darf es weiter reichen, denn eine vorgelesene Nummer kann gut einen
 * Landkreis entfernt liegen. Weiter zu greifen lohnt nicht — Kennungen wiederholen
 * sich zwischen den Bundesländern, und Overpass ist ein gespendeter Dienst.
 */
function boxAround(near: Coords, wide: boolean) {
  const d = wide ? 0.45 : 0.15;
  return { west: near.lon - d * 1.6, south: near.lat - d, east: near.lon + d * 1.6, north: near.lat + d };
}

/** Aus „Rettungspunkt NRW-4915" die Kennung zurückgewinnen. */
function refFromName(name: string): string | null {
  const rest = name.replace(/^rettungspunkt\s*/i, '').trim();
  return rest || null;
}

/**
 * Rettungspunkte zur Eingabe. Mit Kennung wird darauf gefiltert (Teiltreffer
 * genügt, „4915" findet „NRW-4915"), sonst kommen die nächstgelegenen.
 */
export async function findRescuePoints(
  query: RescueQuery,
  near: Coords,
  offlineCode: string | null,
  online: boolean,
  limit = 8,
): Promise<RescueHit[]> {
  const box = boxAround(near, query.ref !== null);

  const fromOffline = offlineCode
    ? poisOffline(offlineCode, ['rescue'], box, 900)
        .then((list) =>
          list.map(
            (p: GeoResult): RescueHit => ({
              ref: refFromName(p.name),
              name: p.name,
              lat: p.lat,
              lon: p.lon,
              distanceM: distanceM(near.lat, near.lon, p.lat, p.lon),
              detail: null,
              offline: true,
            }),
          ),
        )
        .catch(() => [] as RescueHit[])
    : Promise.resolve([] as RescueHit[]);

  const fromNetwork =
    online && navigator.onLine
      ? fetchRescue(box)
          .then((r) =>
            r.data.map(
              (p): RescueHit => ({
                ref: p.ref,
                name: p.ref ? `Rettungspunkt ${p.ref}` : (p.name ?? 'Rettungspunkt'),
                lat: p.lat,
                lon: p.lon,
                distanceM: distanceM(near.lat, near.lon, p.lat, p.lon),
                detail: p.operator ?? p.phone ?? null,
                offline: false,
              }),
            ),
          )
          .catch(() => [] as RescueHit[])
      : Promise.resolve([] as RescueHit[]);

  const [offline, network] = await Promise.all([fromOffline, fromNetwork]);

  // Derselbe Punkt aus beiden Quellen: Der gespeicherte hat Vorrang, er steht
  // auch beim nächsten Mal ohne Netz noch zur Verfügung.
  const merged = [...offline];
  const key = (p: RescueHit) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
  const seen = new Set(merged.map(key));
  for (const p of network) {
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    merged.push(p);
  }

  const wanted = query.ref;
  const matching = wanted ? merged.filter((p) => p.ref && foldRef(p.ref).includes(wanted)) : merged;
  // Bei gesuchter Kennung steht die genaue Übereinstimmung vorn, sonst der
  // nächstgelegene Punkt — im Ernstfall zählt der Weg dorthin.
  matching.sort((a, b) => {
    if (wanted) {
      const exact = (p: RescueHit) => (p.ref && foldRef(p.ref) === wanted ? 0 : 1);
      const d = exact(a) - exact(b);
      if (d !== 0) return d;
    }
    return a.distanceM - b.distanceM;
  });
  return matching.slice(0, limit);
}

/**
 * Von jeder Art Notfallpunkt die nächste. Eine Liste mit acht Apotheken hilft
 * niemandem — dieselbe Überlegung wie im Notfallblatt.
 */
export async function findEmergencyPoints(
  near: Coords,
  offlineCode: string | null,
): Promise<(GeoResult & { distanceM: number })[]> {
  if (!offlineCode) return [];
  const box = boxAround(near, false);
  const list = await poisOffline(offlineCode, EMERGENCY_CATEGORIES, box, 400).catch(
    () => [] as GeoResult[],
  );
  const nearest = list
    .map((p) => ({ ...p, distanceM: distanceM(near.lat, near.lon, p.lat, p.lon) }))
    .sort((a, b) => a.distanceM - b.distanceM);
  const seen = new Set<string>();
  return nearest.filter((p) => {
    const cat = p.category ?? '';
    if (seen.has(cat)) return false;
    seen.add(cat);
    return true;
  });
}
