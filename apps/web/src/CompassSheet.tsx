import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { useState } from 'react';
import {
  bearingTo,
  compassPoint,
  crossBearing,
  projectPoint,
  turnText,
  turnTo,
  useCompass,
  type Sighting,
} from './compass.js';
import { formatDegMin } from './coords.js';
import { formatLength } from './geo.js';
import { distanceM } from './offline/graph.js';

interface Props {
  /** Eigener Standort — Ausgangspunkt der Peilung. */
  from: Coords;
  /** Einen errechneten Punkt als Markierung anlegen. */
  onProject: (point: Coords, name: string) => void;
  /** Angepeilter Punkt (ohne Ziel bleibt es ein reiner Kompass). */
  target: { name: string; lat: number; lon: number } | null;
  onClearTarget: () => void;
  onClose: () => void;
}

const R = 96;
const CENTER = 110;

/**
 * Kompass und Peilung.
 *
 * Gedacht fürs Anlaufen eines Punktes ohne Karte im Blick — Rettungspunkt im
 * Wald, Sammelplatz im Nebel, Ausrichten einer Richtantenne. Die größte Zahl
 * ist deshalb nicht die Peilung, sondern **wie weit man sich drehen muss**.
 */
export function CompassSheet(props: Props) {
  const compass = useCompass(true);
  /** Wegpunkt-Projektion: Peilung und Entfernung als Text, damit auch „240,5" geht. */
  /** Kreuzpeilung: zwei gemerkte Peilungen. */
  const [sightings, setSightings] = useState<(Sighting | null)[]>([null, null]);
  const cross =
    sightings[0] && sightings[1] ? crossBearing(sightings[0], sightings[1]) : null;
  /**
   * Eine Peilung merken.
   *
   * Der Standort kommt **frisch aus der Ortung**, nicht aus dem gespeicherten
   * Standort der App: Zwischen den beiden Peilungen geht man ein Stück zur
   * Seite, und genau dieser Versatz ist die Grundlage der ganzen Rechnung.
   * Ohne Ortung bleibt der bekannte Standort als Rückfall.
   */
  const takeSighting = (slot: number) => {
    const store = (lat: number, lon: number) =>
      setSightings((prev) => {
        const next = [...prev];
        next[slot] = { lat, lon, bearingDeg: heading ?? 0 };
        return next;
      });
    if (!('geolocation' in navigator)) {
      store(props.from.lat, props.from.lon);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => store(pos.coords.latitude, pos.coords.longitude),
      () => store(props.from.lat, props.from.lon),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  };

  const [projBearing, setProjBearing] = useState('');
  const [projDistance, setProjDistance] = useState('');
  const projected =
    Number.isFinite(Number(projBearing)) && Number(projDistance) > 0 && projBearing !== ''
      ? projectPoint(props.from, Number(projBearing), Number(projDistance))
      : null;
  const heading = compass.headingDeg;
  const bearing = props.target ? bearingTo(props.from, props.target) : null;
  const distance = props.target
    ? distanceM(props.from.lat, props.from.lon, props.target.lat, props.target.lon)
    : null;
  const turn = heading != null && bearing != null ? turnTo(heading, bearing) : null;

  /** Punkt auf dem Ring zu einem Winkel (0° = oben). */
  const onRing = (deg: number, radius: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [CENTER + Math.cos(rad) * radius, CENTER + Math.sin(rad) * radius];
  };

  // Die Rose dreht sich gegen die Blickrichtung — oben ist immer „vorn".
  const rose = heading == null ? 0 : -heading;

  return (
    <Sheet
      title="Kompass und Peilung"
      meta={props.target ? props.target.name : 'ohne Ziel'}
      onClose={props.onClose}
    >
      {compass.needsPermission && (
        <div className="cp-ask">
          <p className="muted st-intro">
            Für den Kompass braucht die App die Erlaubnis, die Bewegungssensoren zu lesen.
          </p>
          <button type="button" className="btn-primary" onClick={compass.request}>
            Kompass einschalten
          </button>
        </div>
      )}
      {compass.error && <p className="err">{compass.error}</p>}

      <div className="cp-wrap">
        <svg viewBox="0 0 220 220" className="cp-rose" role="img" aria-label="Kompassrose">
          <circle className="cp-ring" cx={CENTER} cy={CENTER} r={R} />
          <g transform={`rotate(${rose} ${CENTER} ${CENTER})`}>
            {Array.from({ length: 72 }, (_, i) => {
              const deg = i * 5;
              const major = deg % 45 === 0;
              const [x1, y1] = onRing(deg, R);
              const [x2, y2] = onRing(deg, R - (major ? 12 : 5));
              return <line key={deg} className={major ? 'cp-tick major' : 'cp-tick'} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
            {['N', 'O', 'S', 'W'].map((label, i) => {
              const [x, y] = onRing(i * 90, R - 26);
              return (
                <text key={label} className={`cp-label${label === 'N' ? ' is-north' : ''}`} x={x} y={y}>
                  {label}
                </text>
              );
            })}
            {/* Nadel zum Ziel: sie sitzt im Rosen-Koordinatensystem, zeigt also
                auch dann richtig, wenn sich das Gerät dreht. */}
            {bearing != null && (
              <g transform={`rotate(${bearing} ${CENTER} ${CENTER})`}>
                <path className="cp-needle" d={`M${CENTER} ${CENTER - R + 6} l9 22 -9 -7 -9 7 z`} />
                <line className="cp-needle-line" x1={CENTER} y1={CENTER - R + 24} x2={CENTER} y2={CENTER} />
              </g>
            )}
          </g>
          {/* Feste Marke oben: die Blickrichtung des Geräts. */}
          <path className="cp-front" d={`M${CENTER} ${CENTER - R - 10} l7 12 -14 0 z`} />
          <circle className="cp-hub" cx={CENTER} cy={CENTER} r={4} />
        </svg>

        <div className="cp-values">
          {props.target ? (
            <>
              <div className="cp-turn">
                {turn == null ? (
                  <span className="muted">warte auf den Kompass …</span>
                ) : (
                  <b className={Math.abs(turn) <= 5 ? 'is-on' : ''}>{turnText(turn)}</b>
                )}
              </div>
              <dl className="cp-list">
                <div>
                  <dt>Peilung</dt>
                  <dd className="mono">
                    {Math.round(bearing!)}° {compassPoint(bearing!)}
                  </dd>
                </div>
                <div>
                  <dt>Entfernung</dt>
                  <dd className="mono">{formatLength(distance!)}</dd>
                </div>
                <div>
                  <dt>Blickrichtung</dt>
                  <dd className="mono">
                    {heading == null ? '—' : `${Math.round(heading)}° ${compassPoint(heading)}`}
                  </dd>
                </div>
                <div>
                  <dt>Ziel</dt>
                  <dd className="mono">{formatDegMin({ lat: props.target.lat, lon: props.target.lon })}</dd>
                </div>
              </dl>
              <button type="button" className="btn-quiet" onClick={props.onClearTarget}>
                Ziel aufheben
              </button>
            </>
          ) : (
            <>
              <div className="cp-turn">
                <b>{heading == null ? '—' : `${Math.round(heading)}° ${compassPoint(heading)}`}</b>
              </div>
              <p className="muted st-intro">
                Ein Ziel setzt du über das Kartenmenü (langes Antippen) mit „Peilung hierher" —
                dann zeigt die Nadel dorthin und darüber steht, wie weit du dich drehen musst.
              </p>
            </>
          )}
          <div className="sect-label" style={{ marginTop: 16 }}>
            Kreuzpeilung
          </div>
          <p className="muted cp-note">
            Von hier peilen, ein Stück zur Seite gehen, noch einmal peilen — der Schnittpunkt ist
            die Quelle. Für Rauch, ein Signal oder einen Sender, den man sehen, aber nicht
            erreichen kann.
          </p>
          <div className="cp-cross">
            {[0, 1].map((slot) => {
              const s = sightings[slot];
              return (
                <div className="cp-sight" key={slot}>
                  <span className="cp-sight-no">{slot + 1}</span>
                  {s ? (
                    <>
                      <input
                        type="number"
                        aria-label={`Peilung ${slot + 1} in Grad`}
                        value={Math.round(s.bearingDeg)}
                        onChange={(e) =>
                          setSightings((prev) => {
                            const next = [...prev];
                            next[slot] = { ...s, bearingDeg: Number(e.target.value) || 0 };
                            return next;
                          })
                        }
                      />
                      <span className="mono">{formatDegMin({ lat: s.lat, lon: s.lon })}</span>
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() =>
                          setSightings((prev) => {
                            const next = [...prev];
                            next[slot] = null;
                            return next;
                          })
                        }
                      >
                        löschen
                      </button>
                    </>
                  ) : (
                    <button type="button" className="rp-chip" onClick={() => takeSighting(slot)}>
                      Hier peilen
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {cross && !cross.ok && <p className="err">{cross.reason}</p>}
          {cross?.ok && (
            <div className="cp-crossout">
              <div>
                <b className="mono">{formatDegMin(cross.point)}</b>
                <span className="muted">
                  {formatLength(distanceM(props.from.lat, props.from.lon, cross.point.lat, cross.point.lon))} von
                  hier · Schnitt {Math.round(cross.cutAngleDeg)}°
                </span>
              </div>
              {cross.weak && (
                <p className="err cp-weak">
                  Der Schnitt ist zu spitz. Schon ein Grad Peilfehler verschiebt den Punkt um
                  Kilometer — geh weiter zur Seite, bis die Peilungen sich deutlicher kreuzen.
                </p>
              )}
              <button
                type="button"
                className="btn-quiet"
                onClick={() => props.onProject(cross.point, 'Kreuzpeilung')}
              >
                Als Markierung anlegen
              </button>
            </div>
          )}

          <div className="sect-label" style={{ marginTop: 16 }}>
            Punkt berechnen
          </div>
          <p className="muted cp-note">
            Von hier aus so weit auf diese Peilung — für Angaben wie „300 m auf 240°".
          </p>
          <div className="cp-proj">
            <label>
              <span>Peilung °</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={360}
                value={projBearing}
                onChange={(e) => setProjBearing(e.target.value)}
              />
            </label>
            <label>
              <span>Entfernung m</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                value={projDistance}
                onChange={(e) => setProjDistance(e.target.value)}
              />
            </label>
          </div>
          {projected && (
            <div className="cp-projout">
              <span className="mono">{formatDegMin(projected)}</span>
              <button
                type="button"
                className="btn-quiet"
                onClick={() =>
                  props.onProject(projected, `${Math.round(Number(projDistance))} m auf ${Math.round(Number(projBearing))}°`)
                }
              >
                Als Markierung anlegen
              </button>
            </div>
          )}

          <p className="muted cp-note">
            {compass.absolute
              ? 'Richtung rechtweisend (geographisch Nord).'
              : 'Dieses Gerät meldet keine geographische Nordrichtung — die Anzeige kann verdreht sein. Zum Prüfen die Blickrichtung mit einer bekannten Straße vergleichen.'}
          </p>
        </div>
      </div>
    </Sheet>
  );
}
