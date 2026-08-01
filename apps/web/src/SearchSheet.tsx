import { useEffect, useMemo, useRef, useState } from 'react';
import type { Coords, GeoResult } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { fetchGeocode } from './api.js';
import { searchOffline } from './offline/client.js';
import { CategoryIcon } from './CategoryIcon.js';
import { loadDraw, type DrawFeature } from './drawStore.js';
import { distanceM } from './offline/graph.js';
import type { Place } from './places.js';

interface Props {
  /** Bezugspunkt für Entfernungen und Rangfolge. */
  coords: Coords;
  /** Gespeicherte Ziele. */
  favorites: Place[];
  /** Region mit heruntergeladenem Suchindex (oder null). */
  offlineCode: string | null;
  online: boolean;
  onClose: () => void;
  /** Ziel übernehmen und Route berechnen. */
  onRoute: (place: Place, category?: string) => void;
  onSaveFavorite: (place: Place) => void;
  onRemoveFavorite: (place: Place) => void;
}

const distanceLabel = (m?: number): string | null => {
  if (m == null) return null;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
};

/** Mittelpunkt einer eigenen Markierung (Punkt oder Fläche). */
function drawCenter(f: DrawFeature): Coords {
  if (f.geometry.type === 'Point') {
    const [lon, lat] = f.geometry.coordinates;
    return { lat, lon };
  }
  const ring = f.geometry.coordinates[0] ?? [];
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  const n = Math.max(1, ring.length);
  return { lat: lat / n, lon: lon / n };
}

/** Doppelte Treffer aus beiden Quellen zusammenführen (grobe Ortsgleichheit). */
function mergeResults(offline: GeoResult[], online: GeoResult[]): GeoResult[] {
  const out = [...offline];
  for (const r of online) {
    const dup = out.some(
      (o) =>
        Math.abs(o.lat - r.lat) < 0.0006 &&
        Math.abs(o.lon - r.lon) < 0.0009 &&
        o.name.toLowerCase().slice(0, 8) === r.name.toLowerCase().slice(0, 8),
    );
    if (!dup) out.push(r);
  }
  return out;
}

/**
 * Ziele suchen und anfahren. Diese Ansicht setzt bewusst **keinen Standort** —
 * dafür gibt es das Standort-Menü. Gefunden wird in drei Quellen: eigene
 * Markierungen, der Offline-Index der Region und (mit Netz) Photon.
 */
export function SearchSheet(props: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [indexLoading, setIndexLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);
  // Eigene Markierungen liegen im localStorage — beim Öffnen einmal lesen.
  const drawings = useMemo(() => loadDraw(), []);

  const term = q.trim();
  const ownMatches = useMemo(() => {
    const needle = term.toLowerCase();
    return drawings
      .filter((f) => !needle || f.name.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((f) => {
        const c = drawCenter(f);
        return {
          feature: f,
          place: { name: f.name, lat: c.lat, lon: c.lon } satisfies Place,
          distanceM: distanceM(props.coords.lat, props.coords.lon, c.lat, c.lon),
        };
      })
      .sort((a, b) => a.distanceM - b.distanceM);
  }, [drawings, term, props.coords.lat, props.coords.lon]);

  useEffect(() => {
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const id = ++runId.current;
    const timer = setTimeout(async () => {
      const offlinePromise = props.offlineCode
        ? searchOffline(props.offlineCode, term, props.coords, 14).catch(() => [])
        : Promise.resolve([] as GeoResult[]);
      const onlinePromise =
        props.online && navigator.onLine
          ? fetchGeocode(term, props.coords)
              .then((r) => r.data)
              .catch(() => [] as GeoResult[])
          : Promise.resolve([] as GeoResult[]);

      if (props.offlineCode && !results.length) setIndexLoading(true);
      const [offline, online] = await Promise.all([offlinePromise, onlinePromise]);
      if (id !== runId.current) return;
      setIndexLoading(false);
      const merged = mergeResults(offline, online);
      setResults(merged);
      setLoading(false);
      if (!merged.length) setError('Keine Treffer.');
    }, 280);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, props.offlineCode, props.online, props.coords.lat, props.coords.lon]);

  const isSaved = (p: Place) =>
    props.favorites.some((f) => Math.abs(f.lat - p.lat) < 1e-6 && Math.abs(f.lon - p.lon) < 1e-6);

  /** Eine Zeile: antippen fährt hin, Stern speichert das Ziel. */
  const row = (
    key: string,
    place: Place,
    detail: string | null,
    category: string | undefined,
    extra?: { own?: boolean; offline?: boolean; distanceM?: number },
  ) => (
    <div className="sr-row" key={key}>
      <button type="button" className="sr-main" onClick={() => props.onRoute(place, category)}>
        <span className={`sr-ico${extra?.own ? ' is-own' : ''}`}>
          <CategoryIcon category={extra?.own ? 'address' : category} />
        </span>
        <span className="sr-text">
          <span className="sr-name">{place.name}</span>
          <span className="sr-detail">
            {extra?.own && <span className="sr-tag own">eigene Markierung</span>}
            {detail}
            {detail && extra?.distanceM != null ? ' · ' : ''}
            {distanceLabel(extra?.distanceM)}
            {extra?.offline && <span className="sr-tag">offline</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`sr-star${isSaved(place) ? ' is-on' : ''}`}
        title={isSaved(place) ? 'Gespeichertes Ziel entfernen' : 'Als Ziel speichern'}
        aria-label={isSaved(place) ? 'Gespeichertes Ziel entfernen' : 'Als Ziel speichern'}
        onClick={() => (isSaved(place) ? props.onRemoveFavorite(place) : props.onSaveFavorite(place))}
      >
        <svg viewBox="0 0 24 24" fill={isSaved(place) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9Z" />
        </svg>
      </button>
      <button
        type="button"
        className="sr-go"
        title="Route hierher"
        aria-label={`Route nach ${place.name}`}
        onClick={() => props.onRoute(place, category)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 20V9a3 3 0 0 1 3-3h5" />
          <path d="M14 3l3 3-3 3" />
          <circle cx="9" cy="20" r="1.6" />
        </svg>
      </button>
    </div>
  );

  return (
    <Sheet title="Ziel suchen" onClose={props.onClose}>
      <div className="pp-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={q}
          autoFocus
          placeholder={'Adresse, Ort oder z.B. „Tankstelle" …'}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Ziel suchen"
        />
      </div>

      {ownMatches.length > 0 && (
        <>
          <div className="sect-label">Meine Markierungen</div>
          <div className="pp-results">
            {ownMatches.map((m) =>
              row(`draw-${m.feature.id}`, m.place, m.feature.geometry.type === 'Point' ? 'Punkt' : 'Fläche', undefined, {
                own: true,
                distanceM: m.distanceM,
              }),
            )}
          </div>
        </>
      )}

      {term.length >= 2 && (
        <>
          <div className="sect-label">Treffer</div>
          <div className="pp-results">
            {loading && !results.length && (
              <p className="muted">{indexLoading ? 'Suchindex wird geladen …' : 'Suche …'}</p>
            )}
            {!loading && !results.length && <p className="muted">{error ?? 'Keine Treffer.'}</p>}
            {results.map((r, i) =>
              row(`${r.lat},${r.lon},${i}`, { name: r.name, lat: r.lat, lon: r.lon }, r.detail ?? null, r.category, {
                offline: r.source === 'offline',
                distanceM: r.distanceM,
              }),
            )}
          </div>
          <p className="sr-hint">
            {props.offlineCode
              ? 'Adressen und Orte kommen aus dem gespeicherten Index — auch ohne Netz.'
              : props.online
                ? 'Online-Suche (Photon). Für Offline-Treffer die Region unter „Offline" laden.'
                : 'Ohne Netz und ohne gespeicherte Region ist keine Suche möglich.'}
          </p>
        </>
      )}

      {props.favorites.length > 0 && (
        <>
          <div className="sect-label">Gespeicherte Ziele</div>
          <div className="pp-results">
            {props.favorites.map((f) =>
              row(`fav-${f.lat},${f.lon}`, f, null, 'place', {
                distanceM: distanceM(props.coords.lat, props.coords.lon, f.lat, f.lon),
              }),
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
