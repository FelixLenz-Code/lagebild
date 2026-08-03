import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { bearingTo, compassPoint, turnText, turnTo, useCompass } from './compass.js';
import { formatDegMin } from './coords.js';
import { formatLength } from './geo.js';
import { distanceM } from './offline/graph.js';

interface Props {
  /** Eigener Standort — Ausgangspunkt der Peilung. */
  from: Coords;
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
