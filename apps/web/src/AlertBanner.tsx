import { useState } from 'react';
import type { CivilWarning, Severity, WarningFeature } from '@lagebild/shared';
import { SEVERITY_DE, SEVERITY_VAR } from './format.js';

/** Ein Eintrag fürs Banner — aus DWD- wie Behördenwarnung gleich aufgebaut. */
export interface Alert {
  id: string;
  severity: Severity;
  headline: string;
  /** Woher die Warnung stammt („DWD", „Behördenwarnung", „Polizei" …). */
  origin: string;
  instruction?: string;
  /** Welches Blatt die Warnung im Detail zeigt. */
  detail: 'warnings' | 'nina';
}

const RANK: Record<Severity, number> = { minor: 0, moderate: 1, severe: 2, extreme: 3 };

/**
 * Warnungen, die **am eigenen Standort** gelten, für das Banner aufbereitet.
 *
 * Zwei Regeln, die bewusst unterschiedlich sind: Vom DWD kommen laufend
 * Warnungen jeder Stufe — hier zählen nur `severe` und `extreme`, sonst wäre
 * das Banner bei jedem Wind zu sehen und würde ignoriert. Behördenwarnungen
 * gibt es dagegen nur, wenn tatsächlich etwas vorgefallen ist; die stehen
 * unabhängig von ihrer eingetragenen Stufe drin.
 */
export function collectAlerts(weather: WarningFeature[], civil: CivilWarning[]): Alert[] {
  const list: Alert[] = [];
  for (const w of weather) {
    if (w.severity !== 'severe' && w.severity !== 'extreme') continue;
    if (list.some((a) => a.id === w.id)) continue;
    list.push({
      id: w.id,
      severity: w.severity,
      headline: w.headline,
      origin: 'DWD',
      instruction: w.instruction,
      detail: 'warnings',
    });
  }
  for (const w of civil) {
    list.push({
      id: w.id,
      severity: w.severity,
      headline: w.headline,
      origin: w.channel,
      instruction: w.instruction,
      detail: 'nina',
    });
  }
  // Schwerste zuerst — das Banner zeigt immer die oberste.
  return list.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

interface Props {
  alerts: Alert[];
  /** Die Detailliste öffnen. */
  onOpen: (detail: 'warnings' | 'nina') => void;
}

/** Weggeklickte Warnungen (nur für diese Sitzung — beim Neuladen wieder da). */
const dismissed = new Set<string>();

/**
 * Auffälliger Streifen über allem, wenn am Standort eine ernste Warnung gilt.
 *
 * Er nennt Stufe, Herkunft und Schlagzeile, dazu die Handlungsanweisung, wenn
 * es eine gibt — das ist der Teil, der im Ernstfall zählt. Wegklicken gilt für
 * diese Sitzung; beim nächsten Start ist die Warnung wieder da, solange sie
 * gilt.
 */
export function AlertBanner({ alerts, onOpen }: Props) {
  // Zählt hoch, wenn etwas weggeklickt wurde — dann rückt die nächste nach.
  const [, setTick] = useState(0);
  const open = alerts.filter((a) => !dismissed.has(a.id));
  const top = open[0];
  if (!top) return null;
  const color = SEVERITY_VAR[top.severity];

  return (
    <div className="alertbar" role="alert" style={{ borderColor: color }}>
      <span className="ab-sev" style={{ background: color }}>
        {SEVERITY_DE[top.severity]}
      </span>
      <button type="button" className="ab-body" onClick={() => onOpen(top.detail)}>
        <span className="ab-head">
          {top.headline}
          <span className="ab-origin">{top.origin}</span>
        </span>
        {top.instruction && <span className="ab-instr">{top.instruction}</span>}
      </button>
      {open.length > 1 && (
        <button type="button" className="ab-more" onClick={() => onOpen(top.detail)}>
          +{open.length - 1}
        </button>
      )}
      <button
        type="button"
        className="ab-close"
        aria-label="Warnung ausblenden"
        title="Für diese Sitzung ausblenden"
        onClick={() => {
          dismissed.add(top.id);
          setTick((n) => n + 1);
        }}
      >
        ✕
      </button>
    </div>
  );
}
