import { useState } from 'react';
import type { TransitItinerary, TransitLeg } from '@lagebild/shared';
import { departureTime, kindOfProduct } from './format.js';
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
 * ÖPNV-Verbindungen: Auswahl der Abfahrts-/Ankunftszeit, drei Vorschläge und
 * der Ablauf der gewählten Verbindung. Fußwege lassen sich an die
 * Offline-Navigation übergeben.
 */
export function TransitPlan(props: Props) {
  const [showTime, setShowTime] = useState(false);
  const chosen = props.itineraries[props.index];

  return (
    <>
      <div className="tp-time">
        <button
          type="button"
          className={`rp-chip${props.time ? '' : ' is-on'}`}
          onClick={() => {
            props.onTime(null, false);
            setShowTime(false);
          }}
        >
          Jetzt
        </button>
        <button type="button" className={`rp-chip${props.time ? ' is-on' : ''}`} onClick={() => setShowTime((v) => !v)}>
          {props.time ? `${props.arriveBy ? 'Ankunft' : 'Abfahrt'} ${hhmm(props.time)}` : 'Zeit wählen'}
        </button>
        {showTime && (
          <div className="tp-timebox">
            <select
              value={props.arriveBy ? 'arrive' : 'depart'}
              onChange={(e) => props.onTime(props.time ?? new Date().toISOString(), e.target.value === 'arrive')}
              aria-label="Abfahrt oder Ankunft"
            >
              <option value="depart">Abfahrt um</option>
              <option value="arrive">Ankunft bis</option>
            </select>
            <input
              type="datetime-local"
              value={toLocalInput(props.time)}
              onChange={(e) => {
                const value = e.target.value ? new Date(e.target.value).toISOString() : null;
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
                  <span className="tp-detail">
                    {walk
                      ? `${formatDuration(leg.durationS)}${leg.distanceM ? ` · ${formatDistance(leg.distanceM)}` : ''} bis ${leg.to.name || 'zum Ziel'}`
                      : `${leg.from.name} → ${leg.to.name}${
                          leg.intermediateStops.length ? ` · ${leg.intermediateStops.length} Halte` : ''
                        }`}
                  </span>
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
