import type { Severity } from '@lagebild/shared';

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

export const TRAFFIC_DE: Record<string, string> = {
  closure: 'Sperrung',
  jam: 'Stau',
  roadworks: 'Baustelle',
  warning: 'Warnung',
};
