/**
 * Markierungen im Anhang der Adresse mitgeben.
 *
 * Ein QR-Code fasst wenige hundert Bytes, GeoJSON ist geschwätzig. Deshalb wird
 * hier auf das Nötigste eingedampft: Art, Farbe, Name und Koordinaten, letztere
 * auf fünf Nachkommastellen (rund ein Meter) und als **Differenzen** zum
 * Vorgänger — eine Linie besteht aus benachbarten Punkten, deren Unterschiede
 * viel kürzer schreiben als die Punkte selbst.
 *
 * Das Format ist bewusst schlicht und lesbar; wer den Code manuell weitergibt,
 * kann ihn abtippen. Unbekannte Felder werden übersprungen — ein neueres Gerät
 * darf mehr mitgeben, ohne ein älteres zu Fall zu bringen.
 */

import { newId, type DrawFeature, type DrawGeometry } from './drawStore.js';

const PARAM = 'marken';
/** Fünf Nachkommastellen ≈ ein Meter. */
const SCALE = 100000;

const kindCode: Record<DrawFeature['kind'], string> = { point: 'p', line: 'l', area: 'a' };
const kindOf: Record<string, DrawFeature['kind']> = { p: 'point', l: 'line', a: 'area' };

/** Punktfolge als Differenzen in Hunderttausendstel Grad. */
function packPoints(points: [number, number][]): string {
  let lastLon = 0;
  let lastLat = 0;
  const parts: string[] = [];
  for (const [lon, lat] of points) {
    const x = Math.round(lon * SCALE);
    const y = Math.round(lat * SCALE);
    parts.push(`${x - lastLon}.${y - lastLat}`);
    lastLon = x;
    lastLat = y;
  }
  return parts.join('_');
}

function unpackPoints(text: string): [number, number][] {
  let lastLon = 0;
  let lastLat = 0;
  const out: [number, number][] = [];
  for (const part of text.split('_')) {
    const [dx, dy] = part.split('.').map(Number);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    lastLon += dx!;
    lastLat += dy!;
    out.push([lastLon / SCALE, lastLat / SCALE]);
  }
  return out;
}

/** Koordinaten einer Markierung als flache Punktfolge. */
function pointsOf(geometry: DrawGeometry): [number, number][] {
  if (geometry.type === 'Point') return [geometry.coordinates as [number, number]];
  if (geometry.type === 'LineString') return geometry.coordinates as [number, number][];
  return (geometry.coordinates as [number, number][][])[0] ?? [];
}

/**
 * Markierungen an einen Adress-Anhang anhängen (mit führendem `&`), oder ein
 * leerer String, wenn es nichts zu übergeben gibt.
 */
export function packDraw(features: DrawFeature[]): string {
  if (!features.length) return '';
  const parts = features
    .map((f) => {
      const points = pointsOf(f.geometry);
      if (!points.length) return '';
      // Der Name kann alles enthalten — er wird kodiert, der Rest bleibt lesbar.
      return [
        kindCode[f.kind],
        f.color ?? '',
        encodeURIComponent(f.name ?? ''),
        packPoints(points),
      ].join('~');
    })
    .filter(Boolean);
  return parts.length ? `&${PARAM}=${parts.join('!')}` : '';
}

/** Markierungen aus einem Adress-Anhang lesen. Fehlerhafte Einträge entfallen. */
export function unpackDraw(hash: string): DrawFeature[] {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const raw = params.get(PARAM);
  if (!raw) return [];
  const out: DrawFeature[] = [];
  for (const entry of raw.split('!')) {
    const [kindRaw, color, name, coords] = entry.split('~');
    const kind = kindOf[kindRaw ?? ''];
    if (!kind || !coords) continue;
    const points = unpackPoints(coords);
    if (!points.length) continue;
    const geometry: DrawGeometry =
      kind === 'point'
        ? { type: 'Point', coordinates: points[0]! }
        : kind === 'line'
          ? { type: 'LineString', coordinates: points }
          : {
              type: 'Polygon',
              // Ein Ring muss geschlossen sein; beim Packen wurde das nicht
              // vorausgesetzt, hier wird es nachgeholt.
              coordinates: [
                points[0]![0] === points[points.length - 1]![0] &&
                points[0]![1] === points[points.length - 1]![1]
                  ? points
                  : [...points, points[0]!],
              ],
            };
    out.push({
      id: newId(),
      kind,
      name: decodeURIComponent(name ?? '') || 'Übernommen',
      geometry,
      ...(color ? { color } : {}),
    } as DrawFeature);
  }
  return out;
}
