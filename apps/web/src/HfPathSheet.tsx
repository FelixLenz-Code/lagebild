import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import type { BandStatus, PathForecast } from './hfPath.js';

interface Props {
  forecast: PathForecast | null;
  loading: boolean;
  from: string;
  to: Coords;
  onClose: () => void;
}

const STATUS_DE: Record<BandStatus, string> = { open: 'Offen', marginal: 'Grenzwertig', closed: 'Zu' };
const STATUS_COLOR: Record<BandStatus, string> = {
  open: 'var(--ok)',
  marginal: 'var(--sev1)',
  closed: 'var(--sev3)',
};

const compass = (deg: number): string =>
  ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][
    Math.round(deg / 22.5) % 16
  ]!;

/**
 * Welche Bänder tragen auf dieser Strecke? Jede Zeile nennt Zustand und Grund
 * im Klartext — die Farbe ist nur Beiwerk.
 */
export function HfPathSheet(props: Props) {
  const f = props.forecast;
  return (
    <Sheet
      title="Funkstrecke"
      meta={`von ${props.from} nach ${props.to.lat.toFixed(2)}, ${props.to.lon.toFixed(2)}`}
      onClose={props.onClose}
    >
      {props.loading && <p className="muted">Ausbreitungsdaten werden geladen …</p>}
      {!props.loading && !f && (
        <p className="rp-hint err">
          Ohne aktuelle Ionosphärendaten lässt sich die Strecke nicht bewerten — dafür braucht es
          eine Verbindung ins Netz.
        </p>
      )}

      {f && (
        <>
          <div className="hf-grid">
            <div className="hf-kv">
              <span>Entfernung</span>
              <b>{f.distanceKm.toLocaleString('de-DE')} km</b>
            </div>
            <div className="hf-kv">
              <span>Richtung</span>
              <b>
                {f.bearingDeg}° {compass(f.bearingDeg)}
              </b>
            </div>
            <div className="hf-kv">
              <span>Sprünge (F2)</span>
              <b>{f.hops}</b>
            </div>
            <div className="hf-kv">
              <span>MUF der Strecke</span>
              <b>{f.mufMHz} MHz</b>
            </div>
            <div className="hf-kv">
              <span>Arbeitsfrequenz</span>
              <b>{f.fotMHz} MHz</b>
            </div>
            <div className="hf-kv">
              <span>untere Grenze</span>
              <b>{f.lufMHz} MHz</b>
            </div>
          </div>

          <p className="sr-hint">
            {Math.round(f.dayFraction * 100)} % der Strecke liegen im Tageslicht
            {f.greyLine ? ' · die Strecke streift die Dämmerungszone, die unteren Bänder tragen dort oft besonders weit' : ''}.
          </p>

          <div className="sect-label">Bänder</div>
          <ul className="hf-bandlist">
            {f.bands.map((b) => (
              <li key={b.band}>
                <span className="hb-name">{b.band}</span>
                <span className="hb-freq">{b.mhz.toFixed(b.mhz < 10 ? 2 : 1)} MHz</span>
                <span className="hb-status" style={{ color: STATUS_COLOR[b.status] }}>
                  <i style={{ background: STATUS_COLOR[b.status] }} />
                  {STATUS_DE[b.status]}
                </span>
                <span className="hb-reason">{b.reason}</span>
              </li>
            ))}
          </ul>

          <p className="sr-hint" style={{ marginTop: 12 }}>
            Faustformel aus Ionosonden-Messungen und Sonnenstand — der schwächste Punkt der Strecke
            liegt bei {f.weakest.lat.toFixed(1)}°, {f.weakest.lon.toFixed(1)}°. Antenne, Leistung,
            Störpegel und Sporadic E kommen in der Wirklichkeit dazu.
          </p>
        </>
      )}
    </Sheet>
  );
}
