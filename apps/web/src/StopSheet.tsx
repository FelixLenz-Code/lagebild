import type { Coords, TransitDeparture, TransitStopPoint } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { DepartureBoard } from './Departures.js';
import { distanceM } from './offline/graph.js';

interface Props {
  stop: TransitStopPoint;
  coords: Coords;
  departures: TransitDeparture[] | null;
  loading: boolean;
  /** true, wenn die Abfahrten mangels Netz nicht geholt werden konnten. */
  offline: boolean;
  onRoute: () => void;
  onOrigin: () => void;
  onClose: () => void;
}

const KIND_DE: Record<string, string> = {
  bus: 'Bushaltestelle',
  tram: 'Tram / U-Bahn',
  rail: 'Bahnhof',
  ferry: 'Fähranleger',
  other: 'Haltestelle',
};

/** Haltestelle antippen: Art, Entfernung, nächste Abfahrten und Navigation. */
export function StopSheet(props: Props) {
  const { stop } = props;
  const away = distanceM(props.coords.lat, props.coords.lon, stop.lat, stop.lon);
  const awayText = away < 1000 ? `${Math.round(away / 10) * 10} m entfernt` : `${(away / 1000).toFixed(1)} km entfernt`;

  return (
    <Sheet title={stop.name} meta={`${KIND_DE[stop.kind] ?? 'Haltestelle'} · ${awayText}`} onClose={props.onClose}>
      <div className="rp-actions" style={{ marginBottom: 14 }}>
        <button type="button" className="btn-primary" onClick={props.onRoute}>
          Route hierher
        </button>
        <button type="button" className="btn-quiet" onClick={props.onOrigin}>
          Als Start setzen
        </button>
      </div>

      <div className="sect-label">Nächste Abfahrten</div>
      {props.loading && <p className="muted">Lade …</p>}
      {!props.loading && props.offline && (
        <p className="muted">Abfahrtszeiten brauchen eine Verbindung — die Haltestelle selbst ist gespeichert.</p>
      )}
      {!props.loading && !props.offline && !props.departures?.length && (
        <p className="muted">Zurzeit keine Abfahrten gemeldet.</p>
      )}
      {!!props.departures?.length && (
        <DepartureBoard departures={props.departures} stopName={stop.name} />
      )}
      <p className="sr-hint" style={{ marginTop: 12 }}>
        Fahrplan und Echtzeit von{' '}
        <a href="https://transitous.org/" target="_blank" rel="noreferrer">transitous.org</a>.
      </p>
    </Sheet>
  );
}
