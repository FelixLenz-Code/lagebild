import type { TransitTrip, TransitVehicle } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { departureTime, kindOfProduct } from './format.js';

interface Props {
  vehicle: TransitVehicle;
  trip: TransitTrip | null;
  loading: boolean;
  failed: boolean;
  onClose: () => void;
  /** Blatt schließen, Laufweg aber auf der Karte lassen und einpassen. */
  onShowOnMap: () => void;
  /** Einen Halt der Fahrt ansteuern. */
  onRouteToStop: (stop: { name: string; lat: number; lon: number }) => void;
}

/**
 * Ein angetipptes Fahrzeug: Linie, Verspätung und der ganze Laufweg.
 *
 * Wichtig für das Verständnis der Daten: Die Karte zeigt **keine
 * GPS-Ortung**. transitous liefert Soll- und Echtzeit-Fahrplan; die Position
 * wird daraus gerechnet. Das steht auch im Blatt, damit niemand die Marke für
 * eine Peilung hält.
 */
export function VehicleSheet(props: Props) {
  const { vehicle: v, trip } = props;
  const kind = kindOfProduct(v.product);
  const now = Date.now();

  // Welcher Halt kommt als nächstes? Danach richtet sich die Hervorhebung.
  const nextIndex = trip
    ? trip.stops.findIndex((s) => {
        const t = Date.parse(s.when ?? s.plannedWhen ?? '');
        return Number.isFinite(t) && t >= now;
      })
    : -1;

  const delay =
    v.delayMin == null || v.delayMin === 0
      ? 'pünktlich'
      : v.delayMin > 0
        ? `${v.delayMin} min später`
        : `${Math.abs(v.delayMin)} min früher`;

  return (
    <Sheet
      title={`${v.line}${v.towards ? ` → ${v.towards}` : ''}`}
      meta={`${v.product ?? 'Fahrt'} · ${delay}${v.realTime ? '' : ' · nur Sollfahrplan'}`}
      onClose={props.onClose}
    >
      <div className="trip-head" style={{ marginBottom: 12 }}>
        <span className={`line-pill ${kind}`}>{v.line}</span>
        {trip?.direction && <span className="trip-dir">→ {trip.direction}</span>}
      </div>

      {!!trip?.geometry.length && (
        <div className="rp-actions" style={{ marginBottom: 14 }}>
          <button type="button" className="btn-primary" onClick={props.onShowOnMap}>
            Laufweg auf der Karte
          </button>
        </div>
      )}

      {props.loading && <p className="muted">Fahrplan wird geladen …</p>}
      {props.failed && <p className="muted">Zu dieser Fahrt liegt kein Fahrplan vor.</p>}

      {!!trip?.stops.length && (
        <>
          <div className="sect-label">
            Laufweg ({trip.stops.length} Halte)
            {nextIndex > 0 ? ` · noch ${trip.stops.length - nextIndex}` : ''}
          </div>
          <ol className="trip-stops">
            {trip.stops.map((s, i) => {
              const passed = nextIndex >= 0 && i < nextIndex;
              return (
                <li key={`${s.name}-${i}`} className={i === nextIndex ? 'is-here' : passed ? 'is-past' : ''}>
                  <i />
                  <button
                    type="button"
                    className="ts-name ts-link"
                    onClick={() => props.onRouteToStop({ name: s.name, lat: s.lat, lon: s.lon })}
                    title="Route zu diesem Halt"
                  >
                    {s.name}
                  </button>
                  <span className={`ts-time${s.cancelled ? ' cancelled' : s.delayMin ? ' late' : ''}`}>
                    {s.cancelled
                      ? 'entfällt'
                      : `${departureTime(s.when ?? s.plannedWhen)}${s.delayMin ? ` +${s.delayMin}` : ''}`}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <p className="sr-hint" style={{ marginTop: 12 }}>
        Die Marke ist <b>keine GPS-Ortung</b>: Die Position wird aus dem Fahrplan gerechnet — bei
        Fahrten mit Echtzeitmeldung samt gemeldeter Verspätung. Daten von{' '}
        <a href="https://transitous.org/" target="_blank" rel="noreferrer">transitous.org</a>.
      </p>
    </Sheet>
  );
}
