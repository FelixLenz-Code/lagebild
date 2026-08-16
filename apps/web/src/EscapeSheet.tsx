/**
 * „Weg von hier" — Fluchtrouting.
 *
 * Der Unterschied zu einer gewöhnlichen Route: Es gibt kein Ziel. Vorgegeben
 * ist eine **Bedingung** — weit genug weg, und bei Wind nicht in der Fahne
 * stromab. Bei einem Gefahrstoffaustritt ist das der ganze Punkt: Wer mit dem
 * Wind flieht, bleibt in der Wolke.
 *
 * Gerechnet wird auf dem Offline-Graphen im Gerät. Ein fremder Routing-Dienst
 * könnte das gar nicht — dort ist die Kostenfunktion nicht zu ändern.
 */

import { useEffect, useState } from 'react';
import type { Coords, RouteProfile, RouteResult } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { escapeOffline } from './offline/client.js';
import type { EscapeOutcome } from './offline/router.js';
import { formatDistance, formatDuration, ManeuverIcon } from './RoutePanel.js';
import { bearingTo, compassPoint } from './compass.js';

interface Props {
  /** Die Gefahrenstelle. */
  danger: Coords;
  label?: string | null;
  /** Wo man gerade ist. */
  from: Coords;
  /** Regionen, deren Routing-Pakete geladen sind. */
  codes: string[];
  /**
   * Vorgabe für den Sicherheitsabstand. Kommt aus dem Gefahrgut-Blatt, wo der
   * Absperrradius aus dem Handbuch steht — dann muss ihn niemand abtippen.
   */
  initialDistanceM?: number;
  /** Windrichtung am Ort (Grad, aus denen der Wind weht). */
  windFromDeg: number | null;
  windKmh: number | null;
  /** Fluchtweg übernehmen: Karte, Anweisungen, Zielführung. */
  onTake: (route: RouteResult, target: Coords) => void;
  onClose: () => void;
}

const PROFILE_LABEL: Record<RouteProfile, string> = { car: 'Auto', bike: 'Rad', foot: 'Zu Fuß' };

/** Vorgaben für den Sicherheitsabstand — die Stufen, die im Ernstfall zählen. */
const DISTANCES: { m: number; label: string; hint: string }[] = [
  { m: 500, label: '500 m', hint: 'Brand, Unfall' },
  { m: 1000, label: '1 km', hint: 'Gefahrstoff, Rauch' },
  { m: 3000, label: '3 km', hint: 'Großschadenslage' },
  { m: 10000, label: '10 km', hint: 'weiträumig' },
];

export function EscapeSheet(props: Props) {
  const [profile, setProfile] = useState<RouteProfile>('car');
  const [minDistanceM, setMinDistanceM] = useState(props.initialDistanceM ?? 1000);
  /** Quer zum Wind ausweichen — voreingestellt, sobald Wind bekannt ist. */
  const [crosswind, setCrosswind] = useState(props.windFromDeg != null);
  const [result, setResult] = useState<EscapeOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codesKey = props.codes.join(',');
  useEffect(() => {
    if (!props.codes.length) {
      setError('Für diese Gegend ist kein Routing-Paket gespeichert. Ohne das Paket lässt sich kein Weg rechnen.');
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    escapeOffline(
      props.codes,
      props.from,
      profile,
      {
        center: props.danger,
        // Der Kern ist so groß wie die halbe geforderte Entfernung — daraus
        // ergibt sich auch die Länge der Windfahne.
        radiusM: Math.max(200, minDistanceM / 2),
        windFromDeg: crosswind ? props.windFromDeg : null,
      },
      { minDistanceM },
    )
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setError(
          r.status === 'ok'
            ? null
            : r.status === 'start-off-grid'
              ? 'Dein Standort liegt nicht im gespeicherten Straßennetz.'
              : 'Aus dieser Lage führt im gespeicherten Netz kein Weg weit genug heraus.',
        );
      })
      .catch(() => {
        if (!cancelled) setError('Die Rechnung ist fehlgeschlagen.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [codesKey, profile, minDistanceM, crosswind, props.from.lat, props.from.lon, props.danger.lat, props.danger.lon, props.windFromDeg]);

  const route = result?.route ?? null;
  const target = result?.target ?? null;
  const heading = target ? bearingTo(props.from, target) : null;

  return (
    <Sheet
      title="Weg von hier"
      meta={props.label ? `Gefahr: ${props.label}` : 'Fluchtweg aus der Gefahrenstelle'}
      onClose={props.onClose}
    >
      <div className="sect-label">Wie weit soll es weg gehen?</div>
      <div className="es-choices" role="group" aria-label="Sicherheitsabstand">
        {DISTANCES.map((d) => (
          <button
            key={d.m}
            type="button"
            className={`es-choice${minDistanceM === d.m ? ' is-on' : ''}`}
            aria-pressed={minDistanceM === d.m}
            onClick={() => setMinDistanceM(d.m)}
          >
            <b>{d.label}</b>
            <span>{d.hint}</span>
          </button>
        ))}
      </div>

      <div className="es-row">
        <span>Womit</span>
        <div className="rp-profiles" role="group" aria-label="Fortbewegungsart">
          {(['car', 'bike', 'foot'] as RouteProfile[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`rp-profile${profile === p ? ' is-on' : ''}`}
              aria-pressed={profile === p}
              onClick={() => setProfile(p)}
            >
              {PROFILE_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Die wichtigste Entscheidung des Blatts. Deshalb steht sie im Klartext
          da und nicht als Schalter mit drei Wörtern. */}
      <label className={`es-wind${crosswind ? ' is-on' : ''}`}>
        <input
          type="checkbox"
          checked={crosswind}
          disabled={props.windFromDeg == null}
          onChange={() => setCrosswind((v) => !v)}
        />
        <span>
          <b>Quer zum Wind ausweichen</b>
          <span className="es-wind-hint">
            {props.windFromDeg == null
              ? 'Keine Windrichtung bekannt — ohne sie geht nur „möglichst weit weg".'
              : `Wind aus ${Math.round(props.windFromDeg)}° (${compassPoint(props.windFromDeg)})${
                  props.windKmh != null ? `, ${Math.round(props.windKmh)} km/h` : ''
                } — bei Gefahrstoff und Rauch entscheidet die Richtung, nicht die Entfernung.`}
          </span>
        </span>
      </label>

      {loading && <p className="muted">Fluchtweg wird gerechnet …</p>}
      {!loading && error && <p className="rp-hint err">{error}</p>}

      {result && route && target && !loading && (
        <>
          <div className="sect-label">Der schnellste Weg heraus</div>
          <div className="es-summary">
            <b>{formatDistance(route.distanceM)}</b>
            <b>{formatDuration(route.durationS)}</b>
            {heading != null && (
              <span className="mono">
                Richtung {compassPoint(heading)} ({Math.round(heading)}°)
              </span>
            )}
          </div>
          <p className="es-note">
            Endet {result.targetDistanceM != null ? formatDistance(result.targetDistanceM) : ''} von der
            Gefahrenstelle entfernt
            {result.crosswind ? ' und querab der Windrichtung' : ''}.
          </p>

          <ol className="rp-steps es-steps">
            {route.steps.slice(0, 6).map((s, i) => (
              <li key={i}>
                <span className="st-ico">
                  <ManeuverIcon type={s.type} modifier={s.modifier} size={18} />
                </span>
                <span className="st-text">{s.text}</span>
                <span className="st-dist">{s.distanceM >= 1 ? formatDistance(s.distanceM) : ''}</span>
              </li>
            ))}
          </ol>

          <div className="tr-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={() => props.onTake(route, target)}>
              Fluchtweg übernehmen
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
