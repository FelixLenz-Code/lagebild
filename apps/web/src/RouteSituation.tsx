/**
 * Anzeige des Routen-Lagebilds und das Beschaffen der Daten dafür.
 *
 * Die Daten der App hängen sonst am Kartenausschnitt. Eine Route führt aber
 * dorthin, wo die Karte gerade nicht hinsieht — deshalb werden Warnungen, Wind,
 * Verkehr und Radar hier eigens **für den Streifen entlang der Strecke** geholt
 * und einmalig ausgewertet. Die Rechnung selbst steht in `routeSituation.ts`.
 */

import { useEffect, useState } from 'react';
import type { RouteResult } from '@lagebild/shared';
import { fetchNina, fetchRadarForecast, fetchTraffic, fetchWarnings, fetchWind, type Bbox } from './api.js';
import { routeSituation, kmLabel, worstLevel, type RouteEvent, type RouteSituation } from './routeSituation.js';

/** Umschließendes Rechteck der Strecke mit etwas Rand. */
function routeBbox(route: RouteResult, padDeg = 0.15): Bbox {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const [lon, lat] of route.coordinates) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west: west - padDeg, south: south - padDeg, east: east + padDeg, north: north + padDeg };
}

const middleOf = (route: RouteResult) => {
  const b = routeBbox(route, 0);
  return { lat: (b.north + b.south) / 2, lon: (b.east + b.west) / 2 };
};

/** Halbe Diagonale der Strecke in Metern — Radius für die Radarabfrage. */
function radarDistance(route: RouteResult): number {
  const b = routeBbox(route, 0);
  const dLat = ((b.north - b.south) / 2) * 111320;
  const dLon = ((b.east - b.west) / 2) * 111320 * Math.cos((((b.north + b.south) / 2) * Math.PI) / 180);
  return Math.min(200000, Math.max(30000, Math.hypot(dLat, dLon) + 20000));
}

export interface SituationState {
  loading: boolean;
  data: RouteSituation | null;
  /** Quellen, die gerade nichts geliefert haben — steht unter der Liste. */
  missing: string[];
}

/**
 * Lagebild zur gewählten Route. Rechnet neu, wenn sich die Strecke ändert oder
 * der Aktualisieren-Knopf gedrückt wird — nicht im Sekundentakt: Die
 * Radarvorhersage steht in Fünf-Minuten-Schritten, alles Häufigere wäre nur
 * Verkehr auf der Leitung.
 */
export function useRouteSituation(
  route: RouteResult | null,
  enabled: boolean,
  refreshTick: number,
): SituationState {
  const [state, setState] = useState<SituationState>({ loading: false, data: null, missing: [] });

  // Die Strecke selbst ist der Schlüssel: gleiche Geometrie, gleiches Lagebild.
  const key = route ? `${route.distanceM}:${route.durationS}:${route.coordinates.length}` : '';

  useEffect(() => {
    if (!route || !enabled) {
      setState({ loading: false, data: null, missing: [] });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    const bbox = routeBbox(route);
    const missing: string[] = [];
    // Eine ausgefallene Quelle darf das Lagebild nicht verhindern — sie fehlt
    // dann eben, und das steht auch dort.
    const soft = async <T,>(label: string, run: () => Promise<{ data: T }>): Promise<T | null> => {
      try {
        return (await run()).data;
      } catch {
        missing.push(label);
        return null;
      }
    };

    void (async () => {
      const [warnings, civil, traffic, wind, radar] = await Promise.all([
        soft('Unwetterwarnungen', () => fetchWarnings(bbox)),
        soft('Behördenwarnungen', () => fetchNina(bbox)),
        soft('Verkehr', () => fetchTraffic(bbox)),
        soft('Wind', () => fetchWind(bbox)),
        soft('Regenradar', () => fetchRadarForecast(middleOf(route), radarDistance(route))),
      ]);
      if (cancelled) return;
      try {
        const data = await routeSituation({
          route,
          warnings: warnings ?? [],
          civil: civil ?? [],
          traffic: traffic ?? [],
          wind,
          radar,
        });
        if (!cancelled) setState({ loading: false, data, missing });
      } catch {
        if (!cancelled) setState({ loading: false, data: null, missing });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key, enabled, refreshTick, route]);

  return state;
}

const KIND_LABEL: Record<RouteEvent['kind'], string> = {
  warning: 'Unwetter',
  civil: 'Behörde',
  rain: 'Regen',
  wind: 'Wind',
  traffic: 'Verkehr',
  dark: 'Licht',
};

function EventIcon({ kind }: { kind: RouteEvent['kind'] }) {
  const paths: Record<RouteEvent['kind'], JSX.Element> = {
    warning: <path d="M12 3l9.5 17H2.5zM12 10v4M12 17h.01" />,
    civil: <path d="M12 3l8 4v6c0 4.5-3.4 7.4-8 8-4.6-.6-8-3.5-8-8V7zM12 9v4M12 16h.01" />,
    rain: (
      <>
        <path d="M7 15a4.5 4.5 0 0 1 .6-9 6 6 0 0 1 11.2 2.1A3.6 3.6 0 0 1 18 15z" />
        <path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" />
      </>
    ),
    wind: <path d="M3 8h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h8" />,
    traffic: <path d="M5 17V9l2-4h10l2 4v8M5 13h14M8 17v2M16 17v2M8 9h8" />,
    dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

const minutesFromNow = (ms: number) => Math.round((ms - Date.now()) / 60000);

/**
 * Das Lagebild als Liste: was, wo auf der Strecke, wann dort.
 *
 * Die Reihenfolge ist die der Fahrt, nicht die der Schwere — man liest sie ab
 * wie den Streckenverlauf. Die Schwere steckt in der Farbe.
 */
export function RouteSituationView({
  state,
  onShow,
}: {
  state: SituationState;
  /** Ereignis auf der Karte zeigen. */
  onShow: (lat: number, lon: number) => void;
}) {
  const { data } = state;
  if (state.loading && !data) return <p className="muted rs-loading">Lagebild der Strecke wird gerechnet …</p>;
  if (!data) return null;

  const worst = worstLevel(data.events);
  const uncovered = data.lengthM - data.rainCoveredM;

  return (
    <section className="routesit" aria-label="Lagebild der Strecke">
      <div className={`rs-head${worst ? ` is-${worst}` : ''}`}>
        <h4>Lagebild der Strecke</h4>
        <span className="rs-arrival">Ankunft {clock(data.arrivalMs)}</span>
      </div>

      {data.events.length === 0 ? (
        <p className="rs-clear">Nichts auf der Strecke — keine Warnung, kein Regen, kein starker Wind.</p>
      ) : (
        <ol className="rs-list">
          {data.events.map((e, i) => {
            const min = minutesFromNow(e.atMs);
            return (
              <li key={`${e.kind}-${e.fromM}-${i}`} className={`rs-ev is-${e.level}`}>
                <button type="button" className="rs-ev-btn" onClick={() => onShow(e.lat, e.lon)}>
                  <span className="rs-ico">
                    <EventIcon kind={e.kind} />
                  </span>
                  <span className="rs-body">
                    <span className="rs-title">{e.title}</span>
                    <span className="rs-meta">
                      {e.toM > e.fromM + 400
                        ? `${kmLabel(e.fromM)} bis ${kmLabel(e.toM)}`
                        : `bei ${kmLabel(e.fromM)}`}
                      {' · '}
                      {min <= 0 ? 'jetzt' : min < 90 ? `in ${min} min` : `um ${clock(e.atMs)}`}
                      {e.detail ? ` · ${e.detail}` : ''}
                    </span>
                  </span>
                  <span className="rs-kind">{KIND_LABEL[e.kind]}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {/* Ehrlich sagen, wie weit die Vorhersage überhaupt reichte. Ein leeres
          Lagebild heißt sonst „alles frei", obwohl niemand hingesehen hat. */}
      {uncovered > 2000 && (
        <p className="rs-foot">
          Regen geprüft bis {kmLabel(data.rainCoveredM)} — weiter reicht die Radarvorhersage nicht.
        </p>
      )}
      {state.missing.length > 0 && (
        <p className="rs-foot warn">Ohne Antwort: {state.missing.join(', ')}.</p>
      )}
    </section>
  );
}
