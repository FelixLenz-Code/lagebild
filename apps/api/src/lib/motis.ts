import type { TransitDeparture } from '@lagebild/shared';

/**
 * Gemeinsames für die beiden MOTIS-Routen (transitous.org): Basis-URL,
 * Verkehrsmittel-Bezeichnungen und die Umwandlung einer Abfahrt.
 */

export const MOTIS_BASE = process.env.TRANSIT_BASE ?? 'https://api.transitous.org/api/v1';

/** MOTIS-Verkehrsmittel → kurze deutsche Bezeichnung. */
export const MODE_DE: Record<string, string> = {
  BUS: 'Bus',
  COACH: 'Fernbus',
  TRAM: 'Tram',
  SUBWAY: 'U-Bahn',
  METRO: 'U-Bahn',
  SUBURBAN: 'S-Bahn',
  RAIL: 'Zug',
  REGIONAL_RAIL: 'Regionalzug',
  REGIONAL_FAST_RAIL: 'Regionalzug',
  LONG_DISTANCE: 'Fernzug',
  HIGHSPEED_RAIL: 'Fernzug',
  NIGHT_RAIL: 'Nachtzug',
  FERRY: 'Fähre',
  AIRPLANE: 'Flug',
  CABLE_CAR: 'Seilbahn',
  FUNICULAR: 'Standseilbahn',
  AREAL_LIFT: 'Seilbahn',
  OTHER: 'Sonstige',
};

/**
 * Bezeichnung des Verkehrsmittels — mit einer Korrektur am Linienkürzel.
 *
 * Die Fahrplandaten führen S-Bahnen vielerorts als `METRO`; „S 1" als U-Bahn
 * zu bezeichnen wäre für jeden Ortskundigen falsch. Verrät das Kürzel die
 * S-Bahn, hat es Vorrang vor der groben Einstufung der Quelle.
 */
export function productOf(mode: string | undefined, line: string | undefined): string | null {
  const base = MODE_DE[mode ?? ''] ?? null;
  if ((mode === 'METRO' || mode === 'SUBWAY') && /^R?S\s?\d/i.test((line ?? '').trim())) {
    return 'S-Bahn';
  }
  return base;
}

/** Grobe Einteilung fürs Kartensymbol. */
export function stopKind(modes: string[] | undefined): 'bus' | 'tram' | 'rail' | 'ferry' | 'other' {
  const set = new Set(modes ?? []);
  if (set.has('HIGHSPEED_RAIL') || set.has('LONG_DISTANCE') || set.has('REGIONAL_RAIL') ||
      set.has('REGIONAL_FAST_RAIL') || set.has('RAIL') || set.has('SUBURBAN') || set.has('NIGHT_RAIL')) {
    return 'rail';
  }
  if (set.has('SUBWAY') || set.has('METRO') || set.has('TRAM')) return 'tram';
  if (set.has('FERRY')) return 'ferry';
  if (set.has('BUS') || set.has('COACH')) return 'bus';
  return 'other';
}

export interface MotisStopTime {
  place?: {
    name?: string;
    departure?: string;
    scheduledDeparture?: string;
    track?: string;
    scheduledTrack?: string;
    cancelled?: boolean;
  };
  mode?: string;
  realTime?: boolean;
  headsign?: string;
  displayName?: string;
  routeShortName?: string;
  tripShortName?: string;
  routeLongName?: string;
  cancelled?: boolean;
  tripCancelled?: boolean;
  tripId?: string;
}

export function toDeparture(x: MotisStopTime): TransitDeparture {
  const place = x.place ?? {};
  const planned = place.scheduledDeparture ?? null;
  const actual = place.departure ?? planned;
  // Verspätung nur, wenn wirklich Echtzeitdaten anliegen.
  const delayMin =
    x.realTime && planned && actual
      ? Math.round((new Date(actual).getTime() - new Date(planned).getTime()) / 60000)
      : null;
  return {
    line: x.displayName || x.routeShortName || x.tripShortName || MODE_DE[x.mode ?? ''] || '?',
    product: MODE_DE[x.mode ?? ''] ?? null,
    direction: x.headsign || x.routeLongName || '',
    when: actual,
    plannedWhen: planned,
    delayMin,
    platform: place.track ?? place.scheduledTrack ?? null,
    cancelled: Boolean(x.cancelled || x.tripCancelled || place.cancelled),
    tripId: x.tripId,
  };
}

/**
 * Abfahrtsliste aufräumen: Dubletten (dieselbe Fahrt an mehreren Bahnsteigen)
 * entfernen, nach Zeit ordnen und auf einen sinnvollen Horizont begrenzen.
 */
export function tidyDepartures(list: TransitDeparture[], horizonHours: number): TransitDeparture[] {
  const seen = new Set<string>();
  const sorted = list
    .filter((d) => {
      const id = `${d.line}|${d.direction}|${d.plannedWhen ?? d.when}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((x, y) => (x.when ?? '').localeCompare(y.when ?? ''));
  // Abfahrten in mehreren Tagen sagen nichts über die Lage aus. Hat ein Halt
  // gar nichts Näheres, bleiben zwei Einträge als Hinweis stehen.
  const limit = Date.now() + horizonHours * 3600_000;
  const soon = sorted.filter((d) => {
    const t = Date.parse(d.when ?? d.plannedWhen ?? '');
    return Number.isNaN(t) || t <= limit;
  });
  return soon.length ? soon : sorted.slice(0, 2);
}

/**
 * Google-Polyline dekodieren (MOTIS liefert Genauigkeit 7).
 * Ergebnis als [lon, lat] — so, wie GeoJSON es erwartet.
 */
export function decodePolyline(encoded: string, precision = 7): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/* ---------- Rechnen auf dem Linienzug ---------- */

/** Kurs von `a` nach `b` in Grad (0 = Nord). */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const RAD = Math.PI / 180;
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Ebener Abstand zweier Punkte in Grad-Einheiten, mit Breitenkorrektur.
 *
 * Für die Frage „welcher Anteil der Strecke ist zurückgelegt" genügt ein
 * ebenes Maß. Ohne den Faktor cos(Breite) wären Ost-West-Abschnitte in
 * Deutschland aber um rund 40 % zu lang gewichtet — der Zug stünde dann
 * regelmäßig am falschen Ort.
 */
function flatDist(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return Math.hypot(dx, dy);
}

/** Aufsummierte Länge bis zu jedem Stützpunkt (Index 0 = 0). */
export function cumulativeLengths(line: [number, number][]): number[] {
  const steps: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    steps.push(steps[i - 1]! + flatDist(line[i - 1]!, line[i]!));
  }
  return steps;
}

/** Punkt auf dem Linienzug bei Länge `target` — samt Kurs an dieser Stelle. */
export function pointAtLength(
  line: [number, number][],
  steps: number[],
  target: number,
): { lat: number; lon: number; bearing: number } {
  const clamped = Math.max(0, Math.min(steps[steps.length - 1] ?? 0, target));
  let idx = 1;
  while (idx < steps.length - 1 && steps[idx]! < clamped) idx++;
  const a = line[idx - 1]!;
  const b = line[idx]!;
  const span = steps[idx]! - steps[idx - 1]!;
  const t = span > 0 ? (clamped - steps[idx - 1]!) / span : 0;
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    bearing: Math.round(bearingDeg(a, b)),
  };
}

/**
 * Wo liegt ein Halt auf dem Linienzug? Gesucht wird der nächstgelegene
 * Stützpunkt; zurück kommt dessen aufsummierte Länge.
 *
 * `from` begrenzt die Suche nach vorn: Ein Linienzug kann dieselbe Stelle
 * zweimal berühren (Schleifen, Kopfbahnhöfe), und ohne diese Schranke
 * spränge die Position dort zurück.
 */
export function projectOnLine(
  line: [number, number][],
  steps: number[],
  point: [number, number],
  from = 0,
): { index: number; length: number } {
  let best = Infinity;
  let bestIdx = from;
  for (let i = from; i < line.length; i++) {
    const d = flatDist(line[i]!, point);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { index: bestIdx, length: steps[bestIdx] ?? 0 };
}
