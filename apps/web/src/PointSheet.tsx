import { useEffect, useState } from 'react';
import type { Coords, CivilWarning, RescuePoint, WarningFeature } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { CoordinateList } from './LocationSheet.js';
import { bearingTo, compassPoint } from './compass.js';
import { formatLength } from './geo.js';
import { distanceM } from './offline/graph.js';
import { elevationAtOffline, poisOffline } from './offline/client.js';
import { pointInGeometry } from './places.js';
import { sunAltitude, sunTimes } from './sun.js';
import { SEVERITY_DE, SEVERITY_VAR } from './format.js';

/**
 * „Was ist hier?" — alles, was die App über eine Stelle weiß, auf einem Blatt.
 *
 * Die Angaben lagen bisher an sieben verschiedenen Orten: Koordinaten im
 * Standort-Blatt, Warnungen in zwei Listen, Höhe nur im Routenprofil,
 * Sonnenzeiten im Wetterblatt, Rettungspunkte auf der Karte. Wer wissen will,
 * was an *dieser* Stelle los ist, sollte nicht sieben Mal nachsehen müssen.
 *
 * Alles kommt aus Daten, die ohnehin schon geladen sind — bis auf Höhe und
 * Anlaufstellen, die aus den Offline-Paketen nachgeschlagen werden.
 */

interface Props {
  point: Coords;
  /** Name, wenn die Stelle einen hat (Haltestelle, eigene Markierung). */
  label?: string | null;
  /** Eigener Standort — für Entfernung und Peilung. */
  from: Coords;
  /** Bereits geladene Warnungen im Ausschnitt. */
  warnings: WarningFeature[];
  civil: CivilWarning[];
  rescue: RescuePoint[];
  /** Regionen mit heruntergeladenen Paketen. */
  terrainCodes: string[];
  searchCode: string | null;
  onRoute: (place: { name: string; lat: number; lon: number }) => void;
  /** „Weg von hier": Fluchtrouting mit dieser Stelle als Gefahr. */
  onEscape: (point: Coords, label: string | null) => void;
  /** Sichtverbindung vom eigenen Standort zu dieser Stelle prüfen. */
  onSight: (point: Coords, label: string | null) => void;
  onClose: () => void;
}

const CATEGORIES = ['hospital', 'pharmacy', 'police', 'fire_station', 'drinking_water'];
const CATEGORY_DE: Record<string, string> = {
  hospital: 'Klinik',
  pharmacy: 'Apotheke',
  police: 'Polizei',
  fire_station: 'Feuerwehr',
  drinking_water: 'Trinkwasser',
};

const clock = (d: Date | null) =>
  d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '—';

export function PointSheet(props: Props) {
  const [elevation, setElevation] = useState<number | null | 'lade'>('lade');
  const [nearby, setNearby] = useState<{ name: string; category?: string; distanceM: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!props.terrainCodes.length) setElevation(null);
    else {
      elevationAtOffline(props.terrainCodes, props.point.lat, props.point.lon)
        .then((v) => !cancelled && setElevation(v))
        .catch(() => !cancelled && setElevation(null));
    }
    if (props.searchCode) {
      const box = {
        west: props.point.lon - 0.09,
        south: props.point.lat - 0.06,
        east: props.point.lon + 0.09,
        north: props.point.lat + 0.06,
      };
      poisOffline(props.searchCode, CATEGORIES, box, 150)
        .then((list) => {
          if (cancelled) return;
          const seen = new Set<string>();
          setNearby(
            list
              .map((p) => ({
                name: p.name,
                category: p.category,
                distanceM: distanceM(props.point.lat, props.point.lon, p.lat, p.lon),
              }))
              .sort((a, b) => a.distanceM - b.distanceM)
              .filter((p) => {
                if (seen.has(p.category ?? '')) return false;
                seen.add(p.category ?? '');
                return true;
              })
              .slice(0, 3),
          );
        })
        .catch(() => !cancelled && setNearby([]));
    }
    return () => {
      cancelled = true;
    };
  }, [props.point.lat, props.point.lon, props.terrainCodes.join(','), props.searchCode]);

  const away = distanceM(props.from.lat, props.from.lon, props.point.lat, props.point.lon);
  const bearing = bearingTo(props.from, props.point);
  const here = { lat: props.point.lat, lon: props.point.lon };

  const hits = [
    ...props.warnings
      .filter((w) => pointInGeometry(here, w.geometry))
      .map((w) => ({ id: w.id, severity: w.severity, headline: w.headline, origin: 'DWD' })),
    ...props.civil
      .filter((w) => pointInGeometry(here, w.geometry))
      .map((w) => ({ id: w.id, severity: w.severity, headline: w.headline, origin: w.channel })),
  ];

  const sun = sunTimes(new Date(), props.point.lat, props.point.lon);
  const altitude = sunAltitude(new Date(), props.point.lat, props.point.lon);
  /** Wie lange es hier noch hell ist — die Frage, die man abends wirklich hat. */
  const daylight = (() => {
    if (!sun.sunset || !sun.sunrise) return '—';
    const now = Date.now();
    if (now < sun.sunrise.getTime()) {
      const min = Math.round((sun.sunrise.getTime() - now) / 60000);
      return `hell in ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
    }
    if (now > sun.sunset.getTime()) return 'dunkel';
    const min = Math.round((sun.sunset.getTime() - now) / 60000);
    return min >= 60 ? `noch ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `noch ${min} min`;
  })();

  const nearestRescue = [...props.rescue]
    .map((r) => ({ ...r, away: distanceM(props.point.lat, props.point.lon, r.lat, r.lon) }))
    .sort((a, b) => a.away - b.away)[0];

  return (
    <Sheet
      title={props.label || 'Was ist hier?'}
      meta={`${formatLength(away)} · ${Math.round(bearing)}° ${compassPoint(bearing)} von deinem Standort`}
      onClose={props.onClose}
    >
      <div className="ps-facts">
        <div>
          <dt>Höhe</dt>
          <dd className="mono">
            {elevation === 'lade'
              ? '…'
              : elevation != null
                ? `${elevation} m`
                : 'kein Geländepaket'}
          </dd>
        </div>
        <div>
          <dt>Sonne</dt>
          <dd className="mono">
            {clock(sun.sunrise)} – {clock(sun.sunset)}
          </dd>
        </div>
        <div>
          <dt>Sonnenstand</dt>
          <dd className="mono">
            {altitude > 0 ? `${Math.round(altitude)}° über dem Horizont` : 'unter dem Horizont'}
          </dd>
        </div>
        <div>
          {/* Wer um 19 Uhr irgendwo im Wald steht, hat genau diese Frage. */}
          <dt>Tageslicht</dt>
          <dd className="mono">{daylight}</dd>
        </div>
      </div>

      <div className="sect-label">Warnlage an dieser Stelle</div>
      {hits.length === 0 ? (
        <p className="muted ps-quiet">Keine Warnung, die diesen Punkt überdeckt.</p>
      ) : (
        <ul className="ps-warn">
          {hits.map((h) => (
            <li key={h.id}>
              <span className="wp-sev" style={{ background: `var(${SEVERITY_VAR[h.severity]})` }}>
                {SEVERITY_DE[h.severity]}
              </span>
              <span>
                <b>{h.headline}</b>
                <span className="muted"> {h.origin}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {(nearestRescue || nearby.length > 0) && (
        <>
          <div className="sect-label">Im Notfall in der Nähe</div>
          <ul className="em-list">
            {nearestRescue && (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    props.onRoute({
                      name: nearestRescue.ref ?? 'Rettungspunkt',
                      lat: nearestRescue.lat,
                      lon: nearestRescue.lon,
                    })
                  }
                >
                  <b>Rettungspunkt {nearestRescue.ref ?? ''}</b>
                  <span className="mono">{formatLength(nearestRescue.away)}</span>
                </button>
              </li>
            )}
            {nearby.map((n) => (
              <li key={`${n.category}-${n.name}`}>
                <span className="ps-poi">
                  <b>
                    {CATEGORY_DE[n.category ?? ''] ?? n.category}: {n.name}
                  </b>
                  <span className="mono">{formatLength(n.distanceM)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <CoordinateList coords={props.point} />

      <div className="tr-actions" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            props.onRoute({
              name: props.label || `${props.point.lat.toFixed(4)}, ${props.point.lon.toFixed(4)}`,
              ...props.point,
            })
          }
        >
          Route hierher
        </button>
        {/* Die Gegenrichtung: Diese Stelle ist die Gefahr, nicht das Ziel. */}
        <button type="button" className="btn-quiet" onClick={() => props.onSight(here, props.label ?? null)}>
          Sichtverbindung
        </button>
        <button
          type="button"
          className="btn-quiet ps-escape"
          onClick={() => props.onEscape(here, props.label ?? null)}
        >
          Weg von hier
        </button>
      </div>
    </Sheet>
  );
}
