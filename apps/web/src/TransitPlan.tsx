import { useState } from 'react';
import type { TransitItinerary, TransitLeg, TransitLegPlace } from '@lagebild/shared';
import { departureTime, kindOfProduct, trackLabel } from './format.js';
import { formatDistance, formatDuration } from './RoutePanel.js';

interface Props {
  itineraries: TransitItinerary[];
  index: number;
  loading: boolean;
  online: boolean;
  /** Gewünschte Zeit (ISO) — null bedeutet „jetzt". */
  time: string | null;
  arriveBy: boolean;
  onSelect: (index: number) => void;
  onTime: (time: string | null, arriveBy: boolean) => void;
  /** Fußweg eines Abschnitts mit der Offline-Navigation gehen. */
  onWalk: (leg: TransitLeg) => void;
}

const hhmm = (iso: string | null) => (iso ? departureTime(iso) : '–');

/** Datum + Uhrzeit für <input type="datetime-local"> (lokale Zeit). */
function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Gleis bzw. Steig eines Abschnittsendes. Steht dort eine andere Nummer als im
 * Fahrplan, wurde kurzfristig umgelegt — das gehört daneben, sonst steht man
 * am falschen Bahnsteig.
 */
function Track({ place, mode }: { place: TransitLegPlace; mode: string }) {
  if (!place.track) return null;
  const changed = place.plannedTrack && place.plannedTrack !== place.track;
  return (
    <span className={`tp-track${changed ? ' is-changed' : ''}`}>
      {trackLabel(mode)} {place.track}
      {changed && <em>statt {place.plannedTrack}</em>}
    </span>
  );
}

/**
 * ÖPNV-Verbindungen: Auswahl der Abfahrts-/Ankunftszeit, drei Vorschläge und
 * der Ablauf der gewählten Verbindung. Fußwege lassen sich an die
 * Offline-Navigation übergeben.
 */
export function TransitPlan(props: Props) {
  // Zuletzt gewählter Zeitpunkt — beim Hin- und Herschalten geht er nicht verloren.
  const [remembered, setRemembered] = useState<string | null>(props.time);
  const chosen = props.itineraries[props.index];
  const mode: 'now' | 'at' = props.time ? 'at' : 'now';

  /** Vorschlag beim Umschalten: nächste volle fünf Minuten. */
  const roundedNow = (): string => {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
    return d.toISOString();
  };

  return (
    <>
      <div className="tp-time">
        <div className="rp-profiles" role="group" aria-label="Abfahrtszeit">
          <button
            type="button"
            className={`rp-profile${mode === 'now' ? ' is-on' : ''}`}
            aria-pressed={mode === 'now'}
            onClick={() => props.onTime(null, props.arriveBy)}
          >
            Jetzt
          </button>
          <button
            type="button"
            className={`rp-profile${mode === 'at' ? ' is-on' : ''}`}
            aria-pressed={mode === 'at'}
            onClick={() => props.onTime(remembered ?? roundedNow(), props.arriveBy)}
          >
            Zeitpunkt
          </button>
        </div>
        {mode === 'at' && (
          <div className="tp-timebox">
            <select
              value={props.arriveBy ? 'arrive' : 'depart'}
              onChange={(e) => props.onTime(props.time, e.target.value === 'arrive')}
              aria-label="Abfahrt oder Ankunft"
            >
              <option value="depart">Abfahrt um</option>
              <option value="arrive">Ankunft bis</option>
            </select>
            <input
              type="datetime-local"
              value={toLocalInput(props.time)}
              onChange={(e) => {
                if (!e.target.value) return;
                const value = new Date(e.target.value).toISOString();
                setRemembered(value);
                props.onTime(value, props.arriveBy);
              }}
              aria-label="Zeitpunkt"
            />
          </div>
        )}
      </div>

      {!props.online && <p className="rp-hint err">ÖPNV-Verbindungen brauchen eine Verbindung ins Netz.</p>}
      {props.online && props.loading && <p className="muted">Verbindungen werden gesucht …</p>}
      {props.online && !props.loading && !props.itineraries.length && (
        <p className="rp-hint err">Keine Verbindung gefunden.</p>
      )}

      {props.itineraries.length > 0 && (
        <div className="rp-alts">
          {props.itineraries.map((it, i) => (
            <button
              key={i}
              type="button"
              className={`rp-alt${i === props.index ? ' is-on' : ''}`}
              aria-pressed={i === props.index}
              onClick={() => props.onSelect(i)}
            >
              <b>
                {hhmm(it.startTime)} – {hhmm(it.endTime)}
              </b>
              <span>{formatDuration(it.durationS)}</span>
              <span className="rp-alt-diff">
                {it.transfers === 0 ? 'ohne Umstieg' : `${it.transfers}× umsteigen`}
              </span>
            </button>
          ))}
        </div>
      )}

      {chosen && (
        <ol className="tp-legs">
          {chosen.legs.map((leg, i) => {
            const walk = leg.mode === 'WALK';
            const kind = kindOfProduct(leg.product);
            // Am Ende eines Fußwegs steht der Steig, an dem es weitergeht —
            // benannt nach dem Verkehrsmittel, das dort abfährt, nicht nach dem
            // Fußweg selbst.
            const nextMode = chosen.legs[i + 1]?.mode ?? leg.mode;
            return (
              <li key={i} className={walk ? 'is-walk' : ''}>
                <span className="tp-when">{hhmm(leg.departure)}</span>
                <span className="tp-body">
                  <span className="tp-head">
                    {walk ? (
                      <span className="dep-mode">Fußweg</span>
                    ) : (
                      <>
                        <span className={`line-pill ${kind}`}>{leg.line}</span>
                        <span className="dep-mode">{leg.product}</span>
                        {leg.headsign && <span className="tp-dir">→ {leg.headsign}</span>}
                        {leg.delayMin ? <span className="dep-time late">+{leg.delayMin}</span> : null}
                      </>
                    )}
                  </span>
                  {walk ? (
                    <span className="tp-detail">
                      {formatDuration(leg.durationS)}
                      {leg.distanceM ? ` · ${formatDistance(leg.distanceM)}` : ''} bis{' '}
                      {leg.to.name || 'zum Ziel'}
                      <Track place={leg.to} mode={nextMode} />
                    </span>
                  ) : (
                    <>
                      {/* Ein- und Ausstieg untereinander, jeweils mit Steig: Das
                          ist die Angabe, nach der man am Bahnhof sucht. */}
                      <span className="tp-stop">
                        <i>ab</i>
                        <b>{leg.from.name || 'Startpunkt'}</b>
                        <Track place={leg.from} mode={leg.mode} />
                      </span>
                      <span className="tp-stop">
                        <i>an</i>
                        <b>{leg.to.name || 'Ziel'}</b>
                        <Track place={leg.to} mode={leg.mode} />
                        <span className="tp-at">{hhmm(leg.arrival)}</span>
                      </span>
                      {leg.intermediateStops.length > 0 && (
                        <span className="tp-detail">
                          {leg.intermediateStops.length}{' '}
                          {leg.intermediateStops.length === 1 ? 'Halt' : 'Halte'} dazwischen
                        </span>
                      )}
                    </>
                  )}
                  {walk && leg.distanceM != null && leg.distanceM > 80 && (
                    <button type="button" className="rp-chip" onClick={() => props.onWalk(leg)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 20V9a3 3 0 0 1 3-3h5" />
                        <path d="M14 3l3 3-3 3" />
                        <circle cx="9" cy="20" r="1.6" />
                      </svg>
                      Fußweg navigieren
                    </button>
                  )}
                </span>
              </li>
            );
          })}
          <li className="tp-end">
            <span className="tp-when">{hhmm(chosen.endTime)}</span>
            <span className="tp-body">
              <span className="tp-head">
                <b>Ankunft</b>
              </span>
            </span>
          </li>
        </ol>
      )}
    </>
  );
}
