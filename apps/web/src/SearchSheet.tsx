import { useEffect, useMemo, useRef, useState } from 'react';
import type { Coords, GeoResult } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { fetchGeocode } from './api.js';
import { searchOffline } from './offline/client.js';
import { CategoryIcon } from './CategoryIcon.js';
import { parseCoords, formatDegMin, formatUtm } from './coords.js';
import { loadDraw, type DrawFeature } from './drawStore.js';
import { midpoint } from './geo.js';
import { distanceM } from './offline/graph.js';
import {
  findEmergencyPoints,
  findRescuePoints,
  isEmergencyQuery,
  parseRescueQuery,
  type RescueHit,
} from './rescueSearch.js';
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
  /** GPX-Tour als Route laden; gibt eine Fehlermeldung zurück oder null. */
  onGpxFile: (file: File) => Promise<string | null>;
}

const distanceLabel = (m?: number): string | null => {
  if (m == null) return null;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
};

/** Anfahrpunkt einer eigenen Markierung (Punkt, Linie oder Fläche). */
function drawCenter(f: DrawFeature): Coords {
  if (f.geometry.type === 'Point') {
    const [lon, lat] = f.geometry.coordinates;
    return { lat, lon };
  }
  if (f.geometry.type === 'LineString') {
    // Bei einer Tour ist die Mitte der Linie gemeint, nicht der Schwerpunkt
    // aller Stützpunkte — der läge bei einer Schleife irgendwo daneben.
    const [lon, lat] = midpoint(f.geometry.coordinates);
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
  const gpxInput = useRef<HTMLInputElement>(null);
  const [gpxError, setGpxError] = useState<string | null>(null);
  /**
   * Sieht die Eingabe nach einer Koordinate aus? Dann steht sie als eigener
   * Treffer ganz oben — in allen Schreibweisen, die die App auch ausgibt
   * (Dezimalgrad, Grad/Minuten, UTM, MGRS).
   */
  const coordHit = useMemo(() => parseCoords(q), [q]);

  // Eigene Markierungen liegen im localStorage — beim Öffnen einmal lesen.
  const drawings = useMemo(() => loadDraw(), []);

  const term = q.trim();
  const ownMatches = useMemo(() => {
    const needle = term.toLowerCase();
    return drawings
      // Die Beschreibung wird mitdurchsucht: Wer „Schlüssel beim Hausmeister"
      // notiert hat, sucht später danach und nicht nach dem Namen.
      .filter(
        (f) =>
          !needle ||
          f.name.toLowerCase().includes(needle) ||
          (f.note ?? '').toLowerCase().includes(needle),
      )
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

  /**
   * Rettungs- und Notfallpunkte laufen an der Ortssuche vorbei: Die einen
   * tragen statt eines Namens eine Kennung, die anderen sind als Gruppe
   * gemeint. Beide bekommen deshalb einen eigenen Durchgang — mit derselben
   * Wartezeit wie die Ortssuche, damit beim Tippen nichts unnötig losläuft.
   */
  const rescueQuery = useMemo(() => parseRescueQuery(term), [term]);
  const emergencyWanted = useMemo(() => isEmergencyQuery(term), [term]);
  const [rescueHits, setRescueHits] = useState<RescueHit[]>([]);
  const [rescueBusy, setRescueBusy] = useState(false);
  const [emergencyHits, setEmergencyHits] = useState<(GeoResult & { distanceM: number })[]>([]);

  useEffect(() => {
    if (!rescueQuery) {
      setRescueHits([]);
      setRescueBusy(false);
      return;
    }
    let cancelled = false;
    setRescueBusy(true);
    const timer = setTimeout(() => {
      findRescuePoints(rescueQuery, props.coords, props.offlineCode, props.online)
        .then((hits) => !cancelled && setRescueHits(hits))
        .catch(() => !cancelled && setRescueHits([]))
        .finally(() => !cancelled && setRescueBusy(false));
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rescueQuery, props.offlineCode, props.online, props.coords.lat, props.coords.lon]);

  useEffect(() => {
    if (!emergencyWanted || !props.offlineCode) {
      setEmergencyHits([]);
      return;
    }
    let cancelled = false;
    findEmergencyPoints(props.coords, props.offlineCode)
      .then((hits) => !cancelled && setEmergencyHits(hits))
      .catch(() => !cancelled && setEmergencyHits([]));
    return () => {
      cancelled = true;
    };
  }, [emergencyWanted, props.offlineCode, props.coords.lat, props.coords.lon]);

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
          placeholder={'Adresse, Ort, „Tankstelle", Rettungspunkt oder Koordinaten …'}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Ziel suchen"
        />
      </div>

      {/* Nicht jedes Ziel lässt sich tippen: Eine fertige Tour ist auch ein
          Ziel, nur eben als Datei. Deshalb steht der Weg dorthin hier und
          nicht in einem Untermenü. */}
      <div className="sr-gpx">
        <button type="button" className="rp-chip" onClick={() => gpxInput.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M8 8l4-4 4 4M4 20h16" />
          </svg>
          GPX-Tour laden
        </button>
        <span className="muted">einer fertigen Strecke folgen</span>
        <input
          ref={gpxInput}
          type="file"
          accept=".gpx,.kml,.kmz,.geojson,.json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setGpxError(null);
            const message = await props.onGpxFile(file);
            if (message) setGpxError(message);
          }}
        />
      </div>
      {gpxError && <p className="err">{gpxError}</p>}

      {coordHit && (
        <>
          <div className="sect-label">Koordinate</div>
          <div className="pp-results">
            {row(
              'coord',
              { name: formatDegMin(coordHit), lat: coordHit.lat, lon: coordHit.lon },
              formatUtm(coordHit) ?? 'Koordinate',
              'place',
              { distanceM: distanceM(props.coords.lat, props.coords.lon, coordHit.lat, coordHit.lon) },
            )}
          </div>
        </>
      )}

      {ownMatches.length > 0 && (
        <>
          <div className="sect-label">Meine Markierungen</div>
          <div className="pp-results">
            {ownMatches.map((m) =>
              row(
                `draw-${m.feature.id}`,
                m.place,
                m.feature.note?.trim()
                  ? m.feature.note.trim()
                  : m.feature.geometry.type === 'Point'
                    ? 'Punkt'
                    : 'Fläche',
                undefined,
                {
                  own: true,
                  distanceM: m.distanceM,
                },
              ),
            )}
          </div>
        </>
      )}

      {rescueQuery && (
        <>
          <div className="sect-label">
            Rettungspunkte{rescueQuery.label ? ` mit „${rescueQuery.label}"` : ' in der Nähe'}
          </div>
          <div className="pp-results">
            {rescueBusy && !rescueHits.length && <p className="muted">Suche …</p>}
            {!rescueBusy && !rescueHits.length && (
              <p className="muted">
                {props.offlineCode || (props.online && navigator.onLine)
                  ? 'Kein Rettungspunkt gefunden. Kennungen wiederholen sich zwischen den Bundesländern — gesucht wird nur im Umkreis.'
                  : 'Ohne Netz und ohne gespeicherte Region ist keine Suche möglich.'}
              </p>
            )}
            {rescueHits.map((r, i) =>
              row(
                `rescue-${i}-${r.lat},${r.lon}`,
                { name: r.name, lat: r.lat, lon: r.lon },
                r.detail,
                'rescue',
                { offline: r.offline, distanceM: r.distanceM },
              ),
            )}
          </div>
          {rescueHits.length > 0 && (
            <p className="sr-hint">
              Die Kennung ist das, was die Leitstelle hören will — der Punkt selbst lässt sich von
              hier aus anfahren.
            </p>
          )}
        </>
      )}

      {emergencyWanted && (
        <>
          <div className="sect-label">Notfallpunkte in der Nähe</div>
          <div className="pp-results">
            {!props.offlineCode ? (
              <p className="muted">
                Notfallpunkte kommen aus dem gespeicherten Suchindex — Region unter „Offline"
                laden. Einzeln findet die Suche sie auch so: „Apotheke", „Klinik", „Polizei".
              </p>
            ) : !emergencyHits.length ? (
              <p className="muted">In der Nähe nichts gefunden.</p>
            ) : (
              emergencyHits.map((p) =>
                row(`emg-${p.lat},${p.lon}`, { name: p.name, lat: p.lat, lon: p.lon }, p.detail ?? null, p.category, {
                  offline: true,
                  distanceM: p.distanceM,
                }),
              )
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
