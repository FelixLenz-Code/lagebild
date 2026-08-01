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
