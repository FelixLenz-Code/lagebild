/**
 * Eine berechnete Route als GPX ausgeben.
 *
 * Geschrieben werden **beide** Sichten, weil Programme sie unterschiedlich
 * brauchen:
 * - `<trk>` mit dem vollständigen Linienzug — dem folgt jedes Wander- und
 *   Radgerät Punkt für Punkt;
 * - `<rte>` mit einem Punkt je Fahranweisung samt Text — daraus machen
 *   Navigationsprogramme wieder Ansagen;
 * - `<wpt>` für Start, Zwischenziele und Ziel.
 *
 * Höhen kommen mit, wenn ein Höhenprofil vorliegt (Geländepaket oder Höhen aus
 * einer eingelesenen Datei) — sonst bleibt `<ele>` weg, statt eine Null zu
 * behaupten.
 */

import type { RouteResult } from '@lagebild/shared';
import type { ElevationProfile } from './offline/terrain.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Abstand zweier Punkte in Metern (nur für die Zuordnung der Höhen). */
function distanceM(a: [number, number], b: [number, number]): number {
  const RAD = Math.PI / 180;
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Höhe je Geometriepunkt aus dem Profil holen. Das Profil ist in gleichen
 * Abständen abgetastet, die Geometrie nicht — deshalb wird über die
 * zurückgelegte Strecke zugeordnet.
 */
function elevationsFor(
  coordinates: [number, number][],
  profile: ElevationProfile | null,
): (number | null)[] {
  if (!profile || profile.points.length < 2) return coordinates.map(() => null);
  const out: (number | null)[] = [];
  let walked = 0;
  let cursor = 0;
  for (let i = 0; i < coordinates.length; i++) {
    if (i > 0) walked += distanceM(coordinates[i - 1]!, coordinates[i]!);
    while (cursor < profile.points.length - 2 && profile.points[cursor + 1]!.distanceM < walked) {
      cursor++;
    }
    const a = profile.points[cursor]!;
    const b = profile.points[cursor + 1] ?? a;
    const span = b.distanceM - a.distanceM;
    const t = span > 0 ? Math.max(0, Math.min(1, (walked - a.distanceM) / span)) : 0;
    out.push(a.eleM == null ? null : b.eleM == null ? a.eleM : a.eleM + (b.eleM - a.eleM) * t);
  }
  return out;
}

export interface RouteExportMeta {
  /** Name der Route, z. B. „Bremen Hbf → Universität". */
  name: string;
  /** Beschriftung für Start, Zwischenziele und Ziel. */
  startName?: string;
  viaNames?: string[];
  endName?: string;
  profile: ElevationProfile | null;
}

export function routeToGpx(route: RouteResult, meta: RouteExportMeta): string {
  const ele = elevationsFor(route.coordinates, meta.profile);
  const wpt = (name: string, lat: number, lon: number, symbol: string) =>
    `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">` +
    `<name>${esc(name)}</name><sym>${symbol}</sym></wpt>`;

  const waypoints = [
    wpt(meta.startName ?? 'Start', route.snappedStart.lat, route.snappedStart.lon, 'Flag, Green'),
    ...(route.waypoints ?? []).map((w, i) =>
      wpt(meta.viaNames?.[i] ?? `Zwischenziel ${i + 1}`, w.lat, w.lon, 'Flag, Blue'),
    ),
    wpt(meta.endName ?? 'Ziel', route.snappedEnd.lat, route.snappedEnd.lon, 'Flag, Red'),
  ];

  const trkpts = route.coordinates.map(([lon, lat], i) => {
    const e = ele[i];
    return (
      `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">` +
      (e == null ? '' : `<ele>${e.toFixed(1)}</ele>`) +
      `</trkpt>`
    );
  });

  const rtepts = route.steps.map(
    (s) =>
      `    <rtept lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}">` +
      `<name>${esc(s.text)}</name>` +
      (s.name ? `<desc>${esc(s.name)}</desc>` : '') +
      `</rtept>`,
  );

  const km = (route.distanceM / 1000).toFixed(1);
  const minutes = Math.round(route.durationS / 60);

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Lagebild" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>${esc(meta.name)}</name>\n` +
    `    <desc>${km} km, ${minutes} min` +
    (meta.profile ? `, ${meta.profile.gainM} m Anstieg, ${meta.profile.lossM} m Abstieg` : '') +
    `</desc>\n` +
    `    <time>${new Date().toISOString()}</time>\n` +
    `  </metadata>\n` +
    `${waypoints.join('\n')}\n` +
    `  <rte>\n    <name>${esc(meta.name)}</name>\n${rtepts.join('\n')}\n  </rte>\n` +
    `  <trk>\n    <name>${esc(meta.name)}</name>\n    <trkseg>\n${trkpts.join('\n')}\n    </trkseg>\n  </trk>\n` +
    `</gpx>\n`
  );
}
