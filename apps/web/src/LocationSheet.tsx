import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';

interface Props {
  /** Name des aktuellen Standorts (Anzeige in der Topbar). */
  current: string;
  coords: Coords;
  /** Woher der Standort stammt. */
  source: 'gps' | 'manual';
  onClose: () => void;
  onUseGeolocation: () => void;
  onPickOnMap: () => void;
}

/**
 * Standort setzen — bewusst getrennt von der Suche: der Standort bestimmt
 * Wetter, Warnungen und alle ortsbezogenen Kacheln und kommt deshalb nur aus
 * der Ortung oder von Hand aus der Karte.
 */
export function LocationSheet(props: Props) {
  return (
    <Sheet title="Standort" onClose={props.onClose}>
      <div className="loc-now">
        <div className="loc-name">{props.current}</div>
        <div className="loc-coords mono">
          {props.coords.lat.toFixed(4)}, {props.coords.lon.toFixed(4)}
          <span className="loc-src">{props.source === 'gps' ? 'Ortung' : 'von Hand gesetzt'}</span>
        </div>
      </div>

      <div className="pp-actions">
        <button type="button" className="pp-action" onClick={props.onUseGeolocation}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
          Mein Standort (Ortung)
        </button>
        <button type="button" className="pp-action" onClick={props.onPickOnMap}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.2" />
          </svg>
          Auf der Karte setzen
        </button>
      </div>

      <p className="sr-hint">
        Der Standort steuert Wetter, Warnungen und die Kacheln. Ziele zum Anfahren findest du
        über die Suche.
      </p>
    </Sheet>
  );
}
