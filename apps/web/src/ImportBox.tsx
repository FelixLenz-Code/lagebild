import { useEffect, useRef, useState } from 'react';
import { ImportError, readImport, type ImportResult } from './importFiles.js';
import { trackLength } from './trackStore.js';

/**
 * Datei einlesen: auswählen oder auf das Feld ziehen, danach **erst eine
 * Zusammenfassung**, dann übernehmen. Fremde Dateien enthalten oft mehr, als
 * man erwartet (ganze Wegpunktsammlungen) — deshalb soll niemand die eigenen
 * Markierungen ungefragt vollgeschüttet bekommen.
 */

const FORMAT_LABEL: Record<ImportResult['format'], string> = {
  gpx: 'GPX',
  kml: 'KML',
  kmz: 'KMZ',
  geojson: 'GeoJSON',
};

const km = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Props {
  onCommit: (result: ImportResult) => void;
  /** Datei, die auf das Fenster gezogen wurde. */
  file?: File | null;
  onFileHandled?: () => void;
}

export function ImportBox({ onCommit, file, onFileHandled }: Props) {
  const [pending, setPending] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const read = async (f: File) => {
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      setPending(await readImport(f.name, await f.arrayBuffer()));
    } catch (e) {
      setError(
        e instanceof ImportError
          ? e.message
          : `„${f.name}" ließ sich nicht lesen. Ist die Datei vollständig?`,
      );
    } finally {
      setBusy(false);
    }
  };

  // Eine auf das Fenster gezogene Datei landet hier.
  useEffect(() => {
    if (!file) return;
    void read(file);
    onFileHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const total = pending
    ? pending.lines.reduce((sum, l) => sum + trackLength(l.points), 0)
    : 0;
  const parts = pending
    ? [
        pending.lines.length ? count(pending.lines.length, 'Spur', 'Spuren') : '',
        pending.points.length ? count(pending.points.length, 'Punkt', 'Punkte') : '',
        pending.areas.length ? count(pending.areas.length, 'Fläche', 'Flächen') : '',
      ].filter(Boolean)
    : [];

  return (
    <div className="imp">
      <div
        className={`imp-drop${over ? ' is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void read(f);
        }}
      >
        <p className="muted st-intro">
          Fremde Touren und Punktsammlungen öffnen — GPX, KML, KMZ oder GeoJSON. Linien werden zu
          Spuren, einzelne Punkte und Flächen zu eigenen Markierungen. Alles bleibt auf dem Gerät.
        </p>
        <button type="button" className="btn-quiet" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Wird gelesen …' : 'Datei wählen'}
        </button>
        <input
          ref={input}
          type="file"
          accept=".gpx,.kml,.kmz,.geojson,.json,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
            // Damit dieselbe Datei erneut gewählt werden kann.
            e.target.value = '';
          }}
        />
      </div>

      {error && <p className="err">{error}</p>}

      {pending && (
        <div className="imp-sum">
          <div className="imp-head">
            <b>{pending.source}</b>
            <span className="tr-meta mono">
              {FORMAT_LABEL[pending.format]}
              {parts.length ? ` · ${parts.join(' · ')}` : ''}
              {total > 0 ? ` · ${km(total)}` : ''}
            </span>
          </div>

          <ul className="imp-list">
            {[
              ...pending.lines.map((l) => ({ icon: '⎯', name: l.name, extra: km(trackLength(l.points)) })),
              ...pending.points.map((p) => ({ icon: '•', name: p.name, extra: '' })),
              ...pending.areas.map((a) => ({ icon: '▱', name: a.name, extra: '' })),
            ]
              .slice(0, 8)
              .map((row, i) => (
                <li key={i}>
                  <span className="imp-ic" aria-hidden="true">
                    {row.icon}
                  </span>
                  <span className="imp-name">{row.name}</span>
                  {row.extra && <span className="tr-meta mono">{row.extra}</span>}
                </li>
              ))}
            {pending.lines.length + pending.points.length + pending.areas.length > 8 && (
              <li className="muted">
                … und {pending.lines.length + pending.points.length + pending.areas.length - 8} weitere
              </li>
            )}
          </ul>

          {(pending.skipped > 0 || pending.thinned > 0) && (
            <p className="muted imp-note">
              {pending.skipped > 0 &&
                `${count(pending.skipped, 'Eintrag', 'Einträge')} ohne verwertbare Geometrie übergangen. `}
              {pending.thinned > 0 &&
                `${pending.thinned} dicht beieinander liegende Stützpunkte ausgedünnt, damit die Spur handlich bleibt — der Verlauf bleibt erkennbar.`}
            </p>
          )}

          <div className="tr-actions">
            <button type="button" className="btn-primary" onClick={() => onCommit(pending)}>
              Übernehmen
            </button>
            <button type="button" className="btn-quiet" onClick={() => setPending(null)}>
              Verwerfen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
