import { useEffect, useState } from 'react';
import type { Coords, Severity } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { fetchNina, fetchWarnings, type Bbox } from './api.js';
import { withCache } from './cache.js';
import { collectAlerts, type Alert } from './AlertBanner.js';
import { SEVERITY_DE, SEVERITY_VAR, relativeTime } from './format.js';
import { pointInGeometry, type WatchedPlace, MAX_WATCHED } from './places.js';
import { distanceM } from './offline/graph.js';
import { formatLength } from './geo.js';

/**
 * „Meine Orte" — mehrere beobachtete Orte mit eigenem Warnstatus.
 *
 * Der Warnstreifen oben zeigt nur den **eigenen Standort**. Wer unterwegs ist,
 * will aber auch wissen, ob zu Hause oder bei den Eltern etwas los ist. Genau
 * dafür ist diese Liste da: je Ort dieselbe Prüfung wie am Standort, nur eben
 * ortsfern.
 */

export interface PlaceStatus {
  alerts: Alert[];
  checkedAt: number | null;
  /** Aus dem Zwischenspeicher, weil gerade kein Netz da war. */
  cached: boolean;
}

/** Kleines Rechteck um einen Ort — die Flächenprüfung kommt danach. */
const boxAround = (c: Coords): Bbox => ({
  west: c.lon - 0.2,
  south: c.lat - 0.12,
  east: c.lon + 0.2,
  north: c.lat + 0.12,
});

const RANK: Record<Severity, number> = { minor: 0, moderate: 1, severe: 2, extreme: 3 };

/** Schwerste Stufe über alle Orte — für die Kachel. */
export function worstSeverity(states: Record<string, PlaceStatus>): Severity | null {
  let worst: Severity | null = null;
  for (const state of Object.values(states)) {
    for (const alert of state.alerts) {
      if (!worst || RANK[alert.severity] > RANK[worst]) worst = alert.severity;
    }
  }
  return worst;
}

/**
 * Warnlage je beobachtetem Ort.
 *
 * Abgefragt wird **je Ort ein eigenes Rechteck**, nicht ein gemeinsames: Bei
 * Orten in Bremen und München wäre das gemeinsame Rechteck halb Deutschland,
 * und die Warnabfrage des DWD liefert national über 20.000 Flächen.
 */
export function useWatchedStatus(
  places: WatchedPlace[],
  refreshTick: number,
): Record<string, PlaceStatus> {
  const [states, setStates] = useState<Record<string, PlaceStatus>>({});
  const key = places.map((p) => `${p.id}:${p.lat.toFixed(3)},${p.lon.toFixed(3)}`).join('|');

  useEffect(() => {
    if (!places.length) {
      setStates({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(
        places.map(async (p) => {
          const box = boxAround(p);
          const tag = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
          const [weather, civil] = await Promise.all([
            withCache(`watch-warn:${tag}`, () => fetchWarnings(box)).catch(() => null),
            withCache(`watch-nina:${tag}`, () => fetchNina(box)).catch(() => null),
          ]);
          const alerts = collectAlerts(
            (weather?.value.data ?? []).filter((w) => pointInGeometry(p, w.geometry)),
            (civil?.value.data ?? []).filter((w) => pointInGeometry(p, w.geometry)),
          );
          return [
            p.id,
            {
              alerts,
              checkedAt: weather?.savedAt ?? civil?.savedAt ?? null,
              cached: !!(weather?.fromCache || civil?.fromCache),
            },
          ] as const;
        }),
      );
      if (!cancelled) setStates(Object.fromEntries(results));
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshTick]);

  return states;
}

interface Props {
  places: WatchedPlace[];
  states: Record<string, PlaceStatus>;
  /** Eigener Standort — für die Entfernung und zum Hinzufügen. */
  coords: Coords;
  currentName: string;
  onAddCurrent: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onShow: (place: WatchedPlace) => void;
  onOpenAlert: (detail: 'warnings' | 'nina') => void;
  onClose: () => void;
}

export function WatchedPlacesSheet(props: Props) {
  const full = props.places.length >= MAX_WATCHED;
  const already = props.places.some(
    (p) => Math.abs(p.lat - props.coords.lat) < 1e-4 && Math.abs(p.lon - props.coords.lon) < 1e-4,
  );

  return (
    <Sheet title="Meine Orte" meta={`${props.places.length} beobachtet`} onClose={props.onClose}>
      <p className="muted st-intro">
        Diese Orte prüft die App auf Warnungen, auch wenn du ganz woanders bist — der Streifen
        oben gilt nur für deinen Standort. Alles bleibt auf dem Gerät.
      </p>

      <button
        type="button"
        className="btn-primary"
        onClick={props.onAddCurrent}
        disabled={full || already}
        title={full ? `Mehr als ${MAX_WATCHED} Orte werden nicht beobachtet` : undefined}
      >
        {already ? 'Dieser Ort wird schon beobachtet' : `„${props.currentName}" beobachten`}
      </button>

      {props.places.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          Noch kein Ort. Über das Kartenmenü (langes Antippen) lässt sich jeder Punkt mit „Ort
          beobachten" aufnehmen.
        </p>
      ) : (
        <ul className="wp-list">
          {props.places.map((p) => {
            const state = props.states[p.id];
            const worst = state?.alerts[0];
            const away = distanceM(props.coords.lat, props.coords.lon, p.lat, p.lon);
            return (
              <li key={p.id} className={worst ? 'is-alert' : ''}>
                <div className="wp-head">
                  <span
                    className="wp-dot"
                    style={{ background: worst ? `var(${SEVERITY_VAR[worst.severity]})` : 'var(--ok)' }}
                    aria-hidden="true"
                  />
                  <b>{p.name}</b>
                  <span className="tr-meta mono">{formatLength(away)} entfernt</span>
                </div>

                {worst ? (
                  <button
                    type="button"
                    className="wp-alert"
                    onClick={() => props.onOpenAlert(worst.detail)}
                  >
                    <span className="wp-sev" style={{ background: `var(${SEVERITY_VAR[worst.severity]})` }}>
                      {SEVERITY_DE[worst.severity]}
                    </span>
                    <span className="wp-text">
                      <b>{worst.headline}</b>
                      <span className="muted">
                        {worst.origin}
                        {state && state.alerts.length > 1 ? ` · +${state.alerts.length - 1} weitere` : ''}
                      </span>
                      {worst.instruction && <span className="wp-instr">{worst.instruction}</span>}
                    </span>
                  </button>
                ) : (
                  <p className="muted wp-quiet">
                    {state ? 'Keine Warnung.' : 'wird geprüft …'}
                    {state?.checkedAt
                      ? ` Geprüft ${relativeTime(new Date(state.checkedAt).toISOString())}.`
                      : ''}
                    {state?.cached ? ' (letzter Stand)' : ''}
                  </p>
                )}

                <div className="tr-actions">
                  <button type="button" className="btn-quiet" onClick={() => props.onShow(p)}>
                    Auf der Karte zeigen
                  </button>
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => {
                      const name = window.prompt('Name des Ortes', p.name);
                      if (name != null && name.trim()) props.onRename(p.id, name.trim());
                    }}
                  >
                    Umbenennen
                  </button>
                  <button type="button" className="btn-quiet tr-del" onClick={() => props.onRemove(p.id)}>
                    Entfernen
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
