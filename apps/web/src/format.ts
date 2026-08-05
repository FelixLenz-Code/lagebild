import type { Severity, AirCategory } from '@lagebild/shared';

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  return `vor ${Math.round(hrs / 24)} Tg.`;
}

export function timeUntil(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'jetzt';
  if (mins < 60) return `${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} Std.`;
}

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
export function compass(deg: number | null): string {
  if (deg == null) return '–';
  return COMPASS[Math.round(deg / 45) % 8]!;
}

export function timeHM(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Abfahrtszeit: heute nur die Uhrzeit, sonst mit Wochentag — sonst sehen
 * Fahrten an verschiedenen Tagen identisch aus.
 */
export function departureTime(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return `morgen ${time}`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Kurzer Stundenstempel für die Vorhersage („14 Uhr"). */
export function hourLabel(iso: string): string {
  return `${new Date(iso).getHours()} Uhr`;
}

/** Wochentag eines Vorhersagetags — heute und morgen ausgeschrieben. */
export function dayLabel(ymd: string): string {
  const date = new Date(`${ymd}T12:00:00`);
  const days = Math.round((date.getTime() - new Date().setHours(12, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'Heute';
  if (days === 1) return 'Morgen';
  return date.toLocaleDateString('de-DE', { weekday: 'short' });
}

export const CONDITION_DE: Record<string, string> = {
  dry: 'Trocken',
  fog: 'Nebel',
  rain: 'Regen',
  sleet: 'Schneeregen',
  snow: 'Schnee',
  hail: 'Hagel',
  thunderstorm: 'Gewitter',
  'clear-day': 'Klar',
  'clear-night': 'Klar',
  'partly-cloudy-day': 'Teils bewölkt',
  'partly-cloudy-night': 'Teils bewölkt',
  cloudy: 'Bewölkt',
};

export const SEVERITY_DE: Record<Severity, string> = {
  minor: 'Gering',
  moderate: 'Mäßig',
  severe: 'Schwer',
  extreme: 'Extrem',
};

export const SEVERITY_VAR: Record<Severity, string> = {
  minor: 'var(--sev1)',
  moderate: 'var(--sev2)',
  severe: 'var(--sev3)',
  extreme: 'var(--sev4)',
};

/** Verkehrsmittel-Bezeichnung → Art (steuert Farbe der Linien-Plakette). */
export function kindOfProduct(product: string | null | undefined): string {
  switch (product) {
    case 'Bus':
    case 'Fernbus':
      return 'bus';
    case 'Tram':
    case 'U-Bahn':
      return 'tram';
    case 'S-Bahn':
    case 'Zug':
    case 'Regionalzug':
    case 'Fernzug':
    case 'Nachtzug':
      return 'rail';
    case 'Fähre':
      return 'ferry';
    default:
      return 'other';
  }
}

/**
 * Wie der Steig beim jeweiligen Verkehrsmittel heißt. Am Bahnhof hängt „Gleis"
 * aus, am Busbahnhof „Steig", am Hafen „Anleger" — wer davorsteht, sucht genau
 * dieses Wort, deshalb steht hier keine Einheitsbezeichnung.
 *
 * Angenommen wird beides: die MOTIS-Kennung (`HIGHSPEED_RAIL`) dort, wo sie
 * vorliegt, und sonst die deutsche Bezeichnung aus `product`. Verwechseln kann
 * man sie nicht — die eine ist durchgängig groß geschrieben.
 */
export function trackLabel(mode: string | null | undefined): string {
  switch (mode) {
    case 'Zug':
    case 'Regionalzug':
    case 'Fernzug':
    case 'Nachtzug':
    case 'S-Bahn':
    case 'U-Bahn':
      return 'Gleis';
    case 'Fähre':
      return 'Anleger';
    case 'Flug':
      return 'Gate';
    case 'RAIL':
    case 'REGIONAL_RAIL':
    case 'REGIONAL_FAST_RAIL':
    case 'LONG_DISTANCE':
    case 'HIGHSPEED_RAIL':
    case 'NIGHT_RAIL':
    case 'SUBURBAN':
    case 'SUBWAY':
    case 'METRO':
      return 'Gleis';
    case 'FERRY':
      return 'Anleger';
    case 'AIRPLANE':
      return 'Gate';
    default:
      return 'Steig';
  }
}

export const APRS_KIND_DE: Record<string, string> = {
  station: 'APRS-Station',
  object: 'APRS-Objekt',
  item: 'APRS-Item',
  weather: 'Wetterstation',
  ais: 'Schiff (AIS über APRS)',
  other: 'APRS-Ziel',
};

export const VESSEL_DE: Record<string, string> = {
  cargo: 'Frachter',
  tanker: 'Tanker',
  passenger: 'Passagierschiff',
  tug: 'Schlepper',
  fishing: 'Fischerei',
  sailing: 'Segelschiff',
  pleasure: 'Sportboot',
  'high-speed': 'Schnellboot',
  authority: 'Behörde / Rettung',
  other: 'Schiff',
};

export const VESSEL_STATUS_DE: Record<string, string> = {
  'under-way': 'in Fahrt',
  anchored: 'vor Anker',
  moored: 'festgemacht',
  'not-under-command': 'manövrierunfähig',
  fishing: 'beim Fischen',
  aground: 'auf Grund',
  other: 'sonstiger Status',
};

export const TRAFFIC_DE: Record<string, string> = {
  closure: 'Sperrung',
  jam: 'Stau',
  roadworks: 'Baustelle',
  warning: 'Warnung',
};

export const AIR_DE: Record<AirCategory, string> = {
  good: 'Gut',
  fair: 'Ausreichend',
  moderate: 'Mäßig',
  poor: 'Schlecht',
  'very-poor': 'Sehr schlecht',
  'extremely-poor': 'Extrem schlecht',
};

export const AIR_COLOR: Record<AirCategory, string> = {
  good: '#2c7448',
  fair: '#6f9e2e',
  moderate: '#c9a70c',
  poor: '#c96f0f',
  'very-poor': '#a92318',
  'extremely-poor': '#6c2790',
};

/** Zeitbeschriftung eines Radar-Frames (Unix-Sekunden). */
export function radarTimeLabel(timeSec: number, forecast: boolean): string {
  const mins = Math.round((timeSec * 1000 - Date.now()) / 60000);
  if (mins === 0) return 'jetzt';
  if (forecast || mins > 0) return `in ${Math.max(mins, 1)} Min · Prognose`;
  return `vor ${-mins} Min`;
}
