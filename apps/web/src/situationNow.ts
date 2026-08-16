/**
 * Die Lage-Ampel: aus dreißig Ebenen **ein Satz**.
 *
 * Die App weiß viel; wer losgeht, will erst einmal eine Antwort. Diese Rechnung
 * schaut auf alles, was am eigenen Standort gilt, und macht daraus eine Stufe
 * und einen Satz, den man auch vorlesen lassen kann.
 *
 * Zwei Regeln bestimmen den Zuschnitt:
 *
 *  * **Nur, was handlungsrelevant ist.** Bewölkung, Luftdruck und Sichtweite
 *    stehen in der Wetterkachel; hier stehen sie nicht, sonst verwässern sie
 *    die Aussage.
 *  * **Keine erfundene Sicherheit.** Fehlt eine Quelle, sagt die Ampel „ruhig,
 *    soweit bekannt" — nie „alles frei".
 */

import type { AirQuality, CivilWarning, WarningFeature, WeatherNow } from '@lagebild/shared';
import type { Nowcast } from './radarNowcast.js';
import { rainLabel } from './radarNowcast.js';

/** Stufen der Ampel, von unten nach oben. */
export type SituationLevel = 'ruhig' | 'achtung' | 'ernst' | 'gefahr';

export const LEVEL_RANK: Record<SituationLevel, number> = {
  ruhig: 0,
  achtung: 1,
  ernst: 2,
  gefahr: 3,
};

export const LEVEL_LABEL: Record<SituationLevel, string> = {
  ruhig: 'Ruhig',
  achtung: 'Achtung',
  ernst: 'Ernst',
  gefahr: 'Gefahr',
};

/** Farbe der Stufe — dieselben Variablen wie bei den Warnstufen. */
export const LEVEL_COLOR: Record<SituationLevel, string> = {
  ruhig: 'var(--ok)',
  achtung: 'var(--sev1)',
  ernst: 'var(--sev2)',
  gefahr: 'var(--sev3)',
};

export interface SituationReason {
  level: SituationLevel;
  /** Ein Halbsatz, der für sich stehen kann. */
  text: string;
}

export interface SituationNow {
  level: SituationLevel;
  /** Ein vollständiger Satz — auch als Ansage brauchbar. */
  sentence: string;
  reasons: SituationReason[];
  /** Was nicht geprüft werden konnte (fehlende Quelle, offline). */
  unknown: string[];
}

export interface SituationInput {
  /**
   * DWD-Warnungen, die den Standort überdecken — **alle Stufen**. Das Banner
   * zeigt bewusst nur die schweren; für die Ampel zählt auch eine
   * Windböen-Warnung, sie ist ja genau der Grund für ein Gelb.
   */
  weatherWarnings: WarningFeature[];
  /** Behördenwarnungen am Standort (MoWaS, KATWARN, Polizei, Hochwasser …). */
  civilWarnings: CivilWarning[];
  weather: WeatherNow | null;
  nowcast: Nowcast | null;
  air: AirQuality | null;
  /** Waldbrandgefahr-Stufe 1–5 am Standort, wenn bekannt. */
  fireDanger?: number | null;
  /** Sonnenuntergang, wenn er heute noch bevorsteht. */
  sunsetMs?: number | null;
  online: boolean;
  /** Stand der Daten (ms) — alles Ältere ist eine Erinnerung, keine Lage. */
  lastSyncMs?: number | null;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Ab wann Daten als alt gelten (90 Minuten). */
const STALE_MS = 90 * 60 * 1000;

/**
 * Wind: die Böe entscheidet. Die Schwellen folgen der Beaufort-Skala —
 * 62 km/h ist Sturm (Bft 8), 89 schwerer Sturm (Bft 10), 118 Orkan (Bft 12).
 */
function windReason(gustKmh: number): SituationReason | null {
  if (gustKmh >= 118) return { level: 'gefahr', text: `Orkanböen um ${Math.round(gustKmh)} km/h` };
  if (gustKmh >= 89) return { level: 'ernst', text: `schwere Sturmböen um ${Math.round(gustKmh)} km/h` };
  if (gustKmh >= 62) return { level: 'achtung', text: `Sturmböen um ${Math.round(gustKmh)} km/h` };
  return null;
}

/** Waldbrandgefahrenindex des DWD: 1 sehr gering … 5 sehr hoch. */
function fireReason(stage: number): SituationReason | null {
  if (stage >= 5) return { level: 'ernst', text: 'sehr hohe Waldbrandgefahr' };
  if (stage >= 4) return { level: 'achtung', text: 'hohe Waldbrandgefahr' };
  return null;
}

/** Glätte: um den Gefrierpunkt mit Nässe ist die häufigste stille Gefahr. */
function iceReason(w: WeatherNow, nowcast: Nowcast | null): SituationReason | null {
  const t = w.tempC;
  if (t == null || t > 3 || t < -12) return null;
  const wet =
    (w.precipitationMm ?? 0) > 0 ||
    w.condition === 'sleet' ||
    w.condition === 'snow' ||
    w.condition === 'rain' ||
    (nowcast?.rainingNow ?? false);
  if (!wet) return null;
  return {
    level: t <= 1 ? 'ernst' : 'achtung',
    text: t <= 0 ? 'Glätte: Niederschlag bei Frost' : 'mögliche Glätte um den Gefrierpunkt',
  };
}

const ALERT_LEVEL: Record<string, SituationLevel> = {
  minor: 'achtung',
  moderate: 'achtung',
  severe: 'ernst',
  extreme: 'gefahr',
};

/** Die Lage am eigenen Standort in einer Stufe und einem Satz. */
export function situationNow(input: SituationInput): SituationNow {
  const reasons: SituationReason[] = [];
  const unknown: string[] = [];

  /* --- Amtliche Warnungen wiegen am schwersten. --- */
  const seen = new Set<string>();
  for (const w of input.weatherWarnings) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    reasons.push({ level: ALERT_LEVEL[w.severity] ?? 'ernst', text: `${w.headline} (DWD)` });
  }
  for (const w of input.civilWarnings) {
    // Eine Behördenwarnung gibt es nur, wenn etwas vorgefallen ist — ihre
    // eingetragene Stufe ist dafür kein verlässliches Maß.
    reasons.push({
      level: w.urgent || w.severity === 'extreme' ? 'gefahr' : 'ernst',
      text: `${w.headline} (${w.channel})`,
    });
  }

  /* --- Wetter am Ort. --- */
  const w = input.weather;
  if (w) {
    const gust = w.windGustKmh ?? w.windKmh;
    if (gust != null) {
      const r = windReason(gust);
      if (r) reasons.push(r);
    }
    const ice = iceReason(w, input.nowcast);
    if (ice) reasons.push(ice);
    if (w.condition === 'thunderstorm') reasons.push({ level: 'ernst', text: 'Gewitter am Ort' });
    if (w.condition === 'fog') reasons.push({ level: 'achtung', text: 'Nebel' });
  } else {
    unknown.push('Wetter');
  }

  /* --- Regen der nächsten zwei Stunden (Radarvorhersage). --- */
  const n = input.nowcast;
  if (n) {
    if (n.rainingNow && n.peakMmH >= 2.5) {
      reasons.push({ level: n.peakMmH >= 10 ? 'ernst' : 'achtung', text: `${rainLabel(n.peakMmH)} jetzt` });
    } else if (n.startsAt != null) {
      const min = Math.max(0, Math.round((n.startsAt - Date.now()) / 60000));
      if (min <= 60 && n.peakMmH >= 2.5) {
        reasons.push({
          level: n.peakMmH >= 10 ? 'ernst' : 'achtung',
          text: `${rainLabel(n.peakMmH)} ab ${clock(n.startsAt)}`,
        });
      }
    }
  } else {
    unknown.push('Regenradar');
  }

  if (input.fireDanger != null) {
    const r = fireReason(input.fireDanger);
    if (r) reasons.push(r);
  }

  /* --- Luft: erst ab „schlecht" eine Aussage. --- */
  const air = input.air;
  if (air?.category === 'very-poor' || air?.category === 'extremely-poor') {
    reasons.push({ level: 'achtung', text: 'sehr schlechte Luftqualität' });
  }

  /* --- Licht: kein Notstand, aber es ändert Pläne. --- */
  if (input.sunsetMs != null) {
    const min = Math.round((input.sunsetMs - Date.now()) / 60000);
    if (min > 0 && min <= 90) {
      reasons.push({ level: 'achtung', text: `Sonnenuntergang um ${clock(input.sunsetMs)}` });
    }
  }

  /* --- Wie verlässlich ist das alles gerade? --- */
  const stale = input.lastSyncMs != null && Date.now() - input.lastSyncMs > STALE_MS;
  if (!input.online) unknown.push('Verbindung fehlt — letzter Stand');
  else if (stale) unknown.push(`Stand von ${clock(input.lastSyncMs!)}`);

  reasons.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const level = reasons[0]?.level ?? 'ruhig';

  /* --- Der Satz. --- */
  let sentence: string;
  if (!reasons.length) {
    sentence = input.online
      ? 'Ruhig: keine Warnung, kein starker Wind, kein Regen in Sicht.'
      : 'Ruhig nach dem letzten bekannten Stand — ohne Verbindung ungeprüft.';
  } else {
    const first = reasons[0]!.text;
    const rest = reasons.slice(1, 3).map((r) => r.text);
    sentence =
      `${LEVEL_LABEL[level]}: ${first}` +
      (rest.length ? `; dazu ${rest.join(' und ')}` : '') +
      (reasons.length > 3 ? ` und ${reasons.length - 3} Weiteres` : '') +
      '.';
  }

  return { level, sentence, reasons, unknown };
}
