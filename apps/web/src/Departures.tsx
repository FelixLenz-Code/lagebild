import { useEffect, useState } from 'react';
import type { TransitDeparture, TransitTrip } from '@lagebild/shared';
import { fetchTrip } from './api.js';
import { departureTime, kindOfProduct } from './format.js';

/**
 * Abfahrtstafel mit Fahrtverlauf: ein Tipp auf eine Abfahrt zeigt, wo der Bus
 * oder Zug von hier an noch hält.
 *
 * Die Verkehrsmittel werden **nicht nur farblich** unterschieden — jede Zeile
 * nennt die Art im Klartext (Bus, Tram, Regionalzug …), damit die Information
 * nicht allein an der Farbe hängt.
 */
export function DepartureBoard(props: { departures: TransitDeparture[]; stopName?: string }) {
  const [open, setOpen] = useState<TransitDeparture | null>(null);
  const [trip, setTrip] = useState<TransitTrip | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open?.tripId) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setTrip(null);
    fetchTrip(open.tripId)
      .then((r) => {
        if (cancelled) return;
        setTrip(r.data);
        if (!r.data) setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open?.tripId]);

  if (open) {
    return (
      <TripView
        departure={open}
        trip={trip}
        loading={loading}
        failed={failed}
        stopName={props.stopName}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <ul className="dep-list">
      {props.departures.map((d, i) => {
        const kind = kindOfProduct(d.product);
        const row = (
          <>
            <span className={`line-pill ${kind}`}>{d.line}</span>
            {d.product && <span className="dep-mode">{d.product}</span>}
            <span className="dep-dir">{d.direction}</span>
            {d.platform && <span className="dep-time">Gl. {d.platform}</span>}
            <span className={`dep-time${d.cancelled ? ' cancelled' : d.delayMin ? ' late' : ''}`}>
              {d.cancelled
                ? 'fällt aus'
                : `${departureTime(d.when ?? d.plannedWhen)}${d.delayMin ? ` +${d.delayMin}` : ''}`}
            </span>
          </>
        );
        return (
          <li className="dep" key={i}>
            {d.tripId ? (
              <button
                type="button"
                className="dep-btn"
                onClick={() => setOpen(d)}
                title="Weitere Halte dieser Fahrt"
              >
                {row}
                <span className="chevron" aria-hidden="true">›</span>
              </button>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Restlicher Laufweg einer Fahrt ab dem gewählten Halt. */
function TripView(props: {
  departure: TransitDeparture;
  trip: TransitTrip | null;
  loading: boolean;
  failed: boolean;
  stopName?: string;
  onBack: () => void;
}) {
  const { departure, trip } = props;
  const kind = kindOfProduct(departure.product);

  // Nur die Halte ab hier zeigen — davor ist die Fahrt schon vorbei.
  const start = departure.when ?? departure.plannedWhen;
  const ahead = (() => {
    if (!trip) return [];
    const startMs = start ? Date.parse(start) : NaN;
    if (Number.isNaN(startMs)) return trip.stops;
    const idx = trip.stops.findIndex((s) => {
      const t = Date.parse(s.when ?? s.plannedWhen ?? '');
      return !Number.isNaN(t) && t >= startMs - 90_000;
    });
    return idx >= 0 ? trip.stops.slice(idx) : trip.stops;
  })();

  return (
    <div className="trip">
      <div className="trip-head">
        <button type="button" className="rp-chip" onClick={props.onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Zurück
        </button>
        <span className={`line-pill ${kind}`}>{departure.line}</span>
        <span className="dep-mode">{departure.product}</span>
        <span className="trip-dir">→ {departure.direction}</span>
      </div>

      {props.loading && <p className="muted">Laufweg wird geladen …</p>}
      {props.failed && <p className="muted">Für diese Fahrt liegt kein Laufweg vor.</p>}
      {!props.loading && !props.failed && ahead.length > 0 && (
        <>
          <div className="sect-label">
            Weitere Halte {props.stopName ? `ab ${props.stopName}` : ''} ({Math.max(0, ahead.length - 1)})
          </div>
          <ol className="trip-stops">
            {ahead.map((s, i) => (
              <li key={`${s.name}-${i}`} className={i === 0 ? 'is-here' : ''}>
                <i />
                <span className="ts-name">{s.name}</span>
                <span className={`ts-time${s.cancelled ? ' cancelled' : s.delayMin ? ' late' : ''}`}>
                  {s.cancelled
                    ? 'entfällt'
                    : `${departureTime(s.when ?? s.plannedWhen)}${s.delayMin ? ` +${s.delayMin}` : ''}`}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
