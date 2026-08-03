import { useEffect, useRef, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { ImportBox } from './ImportBox.js';
import type { ImportResult } from './importFiles.js';
import {
  downloadGpx,
  loadTracks,
  newTrackId,
  saveTracks,
  shouldKeep,
  trackLength,
  type Track,
  type TrackPoint,
} from './trackStore.js';

/**
 * Spuraufzeichnung.
 *
 * Zweck ist nicht der Sportnachweis, sondern der **Rückweg**: Wer im Wald oder
 * im Nebel umkehren muss, folgt der eigenen Spur zurück. Deshalb liegt die
 * laufende Aufzeichnung als Linie auf der Karte, und zu jeder gespeicherten
 * Spur führt ein Knopf zurück zum Startpunkt.
 */
export function useTrackRecorder() {
  const [tracks, setTracks] = useState<Track[]>(() => loadTracks());
  const [recording, setRecording] = useState(false);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);
  const pointsRef = useRef<TrackPoint[]>([]);
  pointsRef.current = points;

  useEffect(() => saveTracks(tracks), [tracks]);

  const start = () => {
    if (!('geolocation' in navigator)) {
      setError('Dieses Gerät liefert keine Ortung.');
      return;
    }
    setError(null);
    setPoints([]);
    setRecording(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next: TrackPoint = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          t: pos.timestamp,
          ...(pos.coords.altitude != null ? { ele: pos.coords.altitude } : {}),
        };
        setPoints((prev) => (shouldKeep(prev[prev.length - 1], next) ? [...prev, next] : prev));
      },
      () => setError('Ortung nicht möglich — Berechtigung prüfen.'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    );
  };

  /** Aufzeichnung beenden und (bei genug Punkten) speichern. */
  const stop = (name: string): Track | null => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setRecording(false);
    const captured = pointsRef.current;
    setPoints([]);
    if (captured.length < 2) return null;
    const track: Track = {
      id: newTrackId(),
      name: name.trim() || new Date().toLocaleString('de-DE'),
      points: captured,
      distanceM: Math.round(trackLength(captured)),
      startedAt: captured[0]!.t,
      endedAt: captured[captured.length - 1]!.t,
      source: 'record',
    };
    setTracks((prev) => [...prev, track]);
    return track;
  };

  // Läuft die Aufzeichnung noch, wenn die Seite verschwindet, muss die Ortung
  // trotzdem freigegeben werden.
  useEffect(
    () => () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    },
    [],
  );

  return { tracks, setTracks, recording, points, error, start, stop };
}

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`);

function duration(from: number, to: number): string {
  const min = Math.max(0, Math.round((to - from) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

interface Props {
  tracks: Track[];
  onTracks: (next: Track[]) => void;
  /** Gerade aufgezeichnete Punkte (leer, wenn nichts läuft). */
  live: TrackPoint[];
  recording: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
  /** Eine Spur auf der Karte zeigen (oder ausblenden, wenn dieselbe kommt). */
  onShow: (track: Track | null) => void;
  /** Zum Startpunkt einer Spur zurückführen. */
  onBackToStart: (point: Coords, name: string) => void;
  shownId: string | null;
  /** Eingelesene Datei übernehmen. */
  onImport: (result: ImportResult) => void;
  /** Datei, die auf das Fenster gezogen wurde. */
  droppedFile?: File | null;
  onFileHandled?: () => void;
  onClose: () => void;
}

/** Übersicht der Spuren mit Aufzeichnung, Import, Anzeige und Ausgabe als GPX. */
export function TrackPanel(props: Props) {
  const live = props.live;
  const liveDistance = live.length > 1 ? trackLength(live) : 0;

  return (
    <Sheet
      title="Spuren"
      meta={props.recording ? 'Aufzeichnung läuft' : `${props.tracks.length} gespeichert`}
      onClose={props.onClose}
    >
      {props.error && <p className="err">{props.error}</p>}

      <div className="tr-live">
        {props.recording ? (
          <>
            <div className="tr-stats">
              <span className="tr-big">{km(liveDistance)}</span>
              <span className="tr-sub">
                {live.length} Punkte
                {live.length > 1 ? ` · ${duration(live[0]!.t, live[live.length - 1]!.t)}` : ''}
              </span>
            </div>
            <button type="button" className="btn-primary" onClick={props.onStop}>
              Beenden und speichern
            </button>
          </>
        ) : (
          <>
            <p className="muted st-intro">
              Die App schreibt den eigenen Weg mit — als Linie auf der Karte, damit der Rückweg
              auch im Nebel oder im Dunkeln nachvollziehbar bleibt. Alles bleibt auf dem Gerät.
            </p>
            <button type="button" className="btn-primary" onClick={props.onStart}>
              Aufzeichnung starten
            </button>
          </>
        )}
      </div>

      <div className="sect-label" style={{ marginTop: 18 }}>
        Datei einlesen
      </div>
      <ImportBox
        onCommit={props.onImport}
        file={props.droppedFile ?? null}
        onFileHandled={props.onFileHandled}
      />

      {props.tracks.length > 0 && (
        <>
          <div className="sect-label" style={{ marginTop: 18 }}>
            Gespeicherte Spuren
          </div>
          <ul className="tr-list">
            {[...props.tracks].reverse().map((t) => (
              <li key={t.id} className={props.shownId === t.id ? 'is-shown' : ''}>
                <div className="tr-head">
                  <b>{t.name}</b>
                  <span className="tr-meta mono">
                    {km(t.distanceM)}
                    {/* Eingelesene Spuren haben oft keine Zeitstempel — dann
                        stünde hier sonst der 1.1.1970. */}
                    {t.startedAt > 0 && ` · ${duration(t.startedAt, t.endedAt)}`}
                    {t.startedAt > 0 && ` · ${new Date(t.startedAt).toLocaleDateString('de-DE')}`}
                    {t.source === 'import' && ` · aus ${t.origin ?? 'Datei'}`}
                  </span>
                </div>
                <div className="tr-actions">
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => props.onShow(props.shownId === t.id ? null : t)}
                  >
                    {props.shownId === t.id ? 'Von der Karte nehmen' : 'Auf der Karte zeigen'}
                  </button>
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() =>
                      props.onBackToStart({ lat: t.points[0]!.lat, lon: t.points[0]!.lon }, t.name)
                    }
                  >
                    Zum Start zurück
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => downloadGpx(t)}>
                    GPX
                  </button>
                  <button
                    type="button"
                    className="btn-quiet tr-del"
                    onClick={() => {
                      props.onTracks(props.tracks.filter((x) => x.id !== t.id));
                      if (props.shownId === t.id) props.onShow(null);
                    }}
                  >
                    Löschen
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}
