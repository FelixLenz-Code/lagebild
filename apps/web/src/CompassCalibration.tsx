/**
 * Kompass kalibrieren.
 *
 * **Was ein Browser hier kann und was nicht.** Die Kalibrierung des
 * Magnetfeldsensors macht das Betriebssystem; anstoßen lässt sie sich von einer
 * Webseite aus nicht. Was diese Seite kann, ist das, worauf es im Feld
 * ankommt:
 *
 *   1. Die Bewegung anleiten, die das System zum Nachkalibrieren braucht — die
 *      liegende Acht. Dabei wird mitgezählt, ob wirklich alle Richtungen
 *      durchlaufen wurden; sonst hält man das Gerät nur hin und glaubt, es
 *      getan zu haben.
 *   2. Danach **nachmessen**, ob die Anzeige ruhig steht. Ein unkalibrierter
 *      oder von Metall gestörter Sensor springt; ein guter steht.
 *   3. Eine verbleibende Abweichung **abziehen** — mit der Sonne als bekannter
 *      Richtung. Ihr Azimut steht für Ort und Zeit auf ein Zehntelgrad genau
 *      fest, und sie ist das einzige Bezugsobjekt, das im Wald wie auf See
 *      immer da ist.
 *
 * Schritt 3 ist auch die Rettung für Geräte, die über `deviceorientation` nur
 * eine relative Ausrichtung liefern: Ohne Bezug ist die Zahl wertlos, mit einem
 * einmal gesetzten Bezug wird sie brauchbar.
 */

import { useEffect, useRef, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { compassPoint, loadCompassOffset, saveCompassOffset, turnTo } from './compass.js';
import { sunAltitude, sunAzimuth } from './sun.js';

interface Props {
  /** Rohe Richtung des Geräts (ohne Korrektur) — null, solange nichts kommt. */
  rawHeadingDeg: number | null;
  /** Unruhe der Anzeige in Grad, siehe `useCompass`. */
  jitterDeg: number | null;
  /** Selbstauskunft des Geräts, falls vorhanden. */
  accuracyDeg: number | null;
  /** Liefert das Gerät rechtweisend Nord? */
  absolute: boolean;
  /** Standort — für den Sonnenstand. */
  at: Coords;
  onClose: () => void;
}

/** Wie viele der 16 Sektoren wurden beim Schwenken durchlaufen? */
const SEKTOREN = 16;

type Schritt = 'start' | 'acht' | 'ruhe' | 'fertig';

/** Urteil über die Unruhe — die Schwellen sind Erfahrungswerte, keine Norm. */
function urteil(jitter: number | null): { text: string; klasse: string } {
  if (jitter == null) return { text: 'noch keine Messung', klasse: '' };
  if (jitter < 1.5) return { text: 'ruhig — der Kompass taugt', klasse: 'is-gut' };
  if (jitter < 4) return { text: 'leicht unruhig — für grobe Richtungen brauchbar', klasse: 'is-mittel' };
  return { text: 'unruhig — Metall in der Nähe oder unkalibriert', klasse: 'is-schlecht' };
}

export function CompassCalibration(props: Props) {
  const [schritt, setSchritt] = useState<Schritt>('start');
  const [rest, setRest] = useState(0);
  /** Beim Schwenken besuchte Sektoren. */
  const [besucht, setBesucht] = useState<boolean[]>(() => new Array(SEKTOREN).fill(false));
  /** Unruhe-Werte der Ruhephase. */
  const messungen = useRef<number[]>([]);
  const [ruheWert, setRuheWert] = useState<number | null>(null);
  const [offset, setOffset] = useState(() => loadCompassOffset());
  const [hinweis, setHinweis] = useState<string | null>(null);

  const roh = props.rawHeadingDeg;

  // Schwenken: Sektoren einsammeln, bis die Zeit um ist.
  useEffect(() => {
    if (schritt !== 'acht' || roh == null) return;
    const sektor = Math.floor((((roh % 360) + 360) % 360) / (360 / SEKTOREN)) % SEKTOREN;
    setBesucht((prev) => (prev[sektor] ? prev : prev.map((v, i) => (i === sektor ? true : v))));
  }, [schritt, roh]);

  // Ruhephase: Unruhe sammeln.
  useEffect(() => {
    if (schritt !== 'ruhe' || props.jitterDeg == null) return;
    messungen.current.push(props.jitterDeg);
  }, [schritt, props.jitterDeg]);

  // Ein Zähler für beide Phasen.
  useEffect(() => {
    if (schritt !== 'acht' && schritt !== 'ruhe') return;
    if (rest <= 0) {
      if (schritt === 'acht') {
        setSchritt('ruhe');
        messungen.current = [];
        setRest(5);
      } else {
        const werte = messungen.current;
        setRuheWert(werte.length ? werte.reduce((a, b) => a + b, 0) / werte.length : null);
        setSchritt('fertig');
      }
      return;
    }
    const t = window.setTimeout(() => setRest((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [schritt, rest]);

  const anzahlBesucht = besucht.filter(Boolean).length;
  const vollstaendig = anzahlBesucht >= SEKTOREN - 2;

  const sonneAz = sunAzimuth(new Date(), props.at.lat, props.at.lon);
  const sonneHoch = sunAltitude(new Date(), props.at.lat, props.at.lon);
  const sonneDa = sonneHoch > 3;

  /** Auf die Sonne zeigen und den Rest der Abweichung abziehen. */
  const nachSonne = () => {
    if (roh == null) return;
    // Die gespeicherte Korrektur ist das, was zur rohen Messung addiert werden
    // muss, damit die Richtung stimmt.
    const neu = ((sonneAz - roh) % 360 + 360) % 360;
    saveCompassOffset(neu);
    setOffset(neu);
    setHinweis(`Korrektur gesetzt: ${vorzeichen(neu)}. Der Kompass zeigt jetzt auf die Sonne.`);
  };

  const zuruecksetzen = () => {
    saveCompassOffset(0);
    setOffset(0);
    setHinweis('Korrektur gelöscht — es gilt wieder, was das Gerät meldet.');
  };

  const start = () => {
    setBesucht(new Array(SEKTOREN).fill(false));
    setRuheWert(null);
    setHinweis(null);
    setSchritt('acht');
    setRest(12);
  };

  const wert = urteil(schritt === 'fertig' ? ruheWert : props.jitterDeg);

  return (
    <div className="cal">
      <div className="cal-head">
        <h4>Kompass kalibrieren</h4>
        <button type="button" className="btn-quiet" onClick={props.onClose}>
          schließen
        </button>
      </div>

      {!props.absolute && (
        <p className="cal-warn">
          Dieses Gerät meldet <b>keine rechtweisende</b> Nordrichtung — die Zahl ist ohne Bezug.
          Schritt&nbsp;3 stellt den Bezug her.
        </p>
      )}
      {props.accuracyDeg != null && (
        <p className="muted cal-small">
          Das Gerät gibt seine Ungenauigkeit selbst mit ± {Math.round(props.accuracyDeg)}° an.
        </p>
      )}

      {/* ---- Schritt 1 und 2 ---- */}
      <div className="cal-step">
        <b>1 · Acht schwenken</b>
        {schritt === 'start' && (
          <>
            <p className="cal-small">
              Das Gerät flach in die Hand nehmen und zwölf Sekunden lang eine liegende Acht
              beschreiben — dabei um alle drei Achsen kippen. Abstand halten zu Auto, Stativ,
              Funkgerät und Magnetverschlüssen: Der Sensor misst das Erdmagnetfeld, und das ist
              schwach gegen jedes Stück Eisen.
            </p>
            <button type="button" className="btn-primary" onClick={start} disabled={roh == null}>
              {roh == null ? 'Warte auf den Sensor …' : 'Los'}
            </button>
          </>
        )}
        {schritt === 'acht' && (
          <>
            <p className="cal-run">Schwenken … noch {rest} s</p>
            <div className="cal-sectors" aria-label={`${anzahlBesucht} von ${SEKTOREN} Richtungen erfasst`}>
              {besucht.map((v, i) => (
                <i key={i} className={v ? 'is-on' : ''} />
              ))}
            </div>
            <p className="cal-small">{anzahlBesucht} von {SEKTOREN} Richtungen erfasst</p>
          </>
        )}
        {(schritt === 'ruhe' || schritt === 'fertig') && (
          <p className={`cal-small ${vollstaendig ? 'is-gut' : 'is-mittel'}`}>
            {vollstaendig
              ? `Alle Richtungen durchlaufen (${anzahlBesucht}/${SEKTOREN}).`
              : `Nur ${anzahlBesucht} von ${SEKTOREN} Richtungen — beim nächsten Mal weiter schwenken.`}
          </p>
        )}
      </div>

      <div className="cal-step">
        <b>2 · Ruhig halten</b>
        {schritt === 'ruhe' ? (
          <p className="cal-run">Stillhalten … noch {rest} s</p>
        ) : schritt === 'fertig' ? (
          <p className={`cal-verdict ${wert.klasse}`}>
            {ruheWert == null ? 'Keine Messung zustande gekommen.' : `${ruheWert.toFixed(1)}° Schwankung — ${wert.text}`}
          </p>
        ) : (
          <p className="cal-small">Kommt nach dem Schwenken.</p>
        )}
      </div>

      {/* ---- Schritt 3 ---- */}
      <div className="cal-step">
        <b>3 · Nach der Sonne ausrichten (freiwillig)</b>
        {sonneDa ? (
          <>
            <p className="cal-small">
              Die Sonne steht gerade bei <b>{Math.round(sonneAz)}° ({compassPoint(sonneAz)})</b>,{' '}
              {Math.round(sonneHoch)}° über dem Horizont. Das Gerät genau auf die Sonne ausrichten —
              oder, angenehmer fürs Auge, mit dem Rücken zur Sonne genau auf den eigenen Schatten —
              und dann tippen. <b>Nicht in die Sonne sehen.</b>
            </p>
            <div className="cal-row">
              <button type="button" className="btn-primary" onClick={nachSonne} disabled={roh == null}>
                Jetzt zeigt es auf die Sonne
              </button>
              {roh != null && (
                <span className="cal-small">
                  roh {Math.round(roh)}° → Abweichung {vorzeichen(((sonneAz - roh) % 360 + 360) % 360)}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="cal-small">
            Die Sonne steht zu tief ({Math.round(sonneHoch)}°) — ohne sie geht dieser Schritt nicht.
            Bei Tageslicht wiederholen.
          </p>
        )}
      </div>

      <div className="cal-foot">
        <span>
          Gespeicherte Korrektur: <b>{offset === 0 ? 'keine' : vorzeichen(offset)}</b>
        </span>
        {offset !== 0 && (
          <button type="button" className="btn-quiet" onClick={zuruecksetzen}>
            zurücksetzen
          </button>
        )}
      </div>
      {hinweis && <p className="cal-ok">{hinweis}</p>}
    </div>
  );
}

/** Eine Korrektur lesbar machen: „+12°" bzw. „−8°" statt „352°". */
function vorzeichen(deg: number): string {
  const d = Math.round(turnTo(0, deg));
  if (d === 0) return '0°';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}°`;
}
