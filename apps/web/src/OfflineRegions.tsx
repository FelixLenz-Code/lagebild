import { useState } from 'react';
import { FEDERAL_STATES } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { downloadOffline, deleteOffline } from './offlineMaps.js';

interface Props {
  /** Auf dem Server verfügbare Regionen: code → Bytegröße. */
  availableMap: Record<string, number>;
  /** Bereits heruntergeladene Regionen: code → Bytegröße. */
  offline: Record<string, number>;
  onClose: () => void;
  onChanged: () => void;
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

export function OfflineRegions(props: Props) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadedCodes = Object.keys(props.offline);
  const totalBytes = downloadedCodes.reduce((a, c) => a + props.offline[c]!, 0);

  async function download(code: string) {
    setError(null);
    setBusy(code);
    setProgress((p) => ({ ...p, [code]: 0 }));
    try {
      await downloadOffline(code, (frac) => setProgress((p) => ({ ...p, [code]: frac })));
      props.onChanged();
    } catch {
      setError('Download fehlgeschlagen. Ist die Region auf dem Server hinterlegt?');
    } finally {
      setBusy(null);
      setProgress((p) => {
        const next = { ...p };
        delete next[code];
        return next;
      });
    }
  }

  async function remove(code: string) {
    await deleteOffline(code);
    props.onChanged();
  }

  return (
    <Sheet title="Offline-Regionen" onClose={props.onClose}>
      <div className="storage-sum">
        <span className="big">{downloadedCodes.length}</span>
        <span className="u">Regionen offline</span>
        <span className="free">{totalBytes ? mb(totalBytes) : '0 MB'} belegt</span>
      </div>
      <div className="always-on">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <div>
          <b>Fachdaten sind bundesweit immer offline.</b> Hier lädst du zusätzlich die <b>Hintergrundkarte</b> pro Bundesland.
        </div>
      </div>
      {error && <p className="err" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="region-list">
        {FEDERAL_STATES.map((s) => {
          const isDown = s.code in props.offline;
          const available = s.code in props.availableMap;
          const frac = progress[s.code];
          const downloading = busy === s.code;
          return (
            <div className="region" key={s.code}>
              <span className="rcode">{s.code}</span>
              <div className="rinfo">
                <b>{s.name}</b>
                <span className="rmeta">
                  {isDown
                    ? `Offline · ${mb(props.offline[s.code]!)}`
                    : downloading
                      ? 'Wird geladen …'
                      : available
                        ? `${mb(props.availableMap[s.code]!)}`
                        : 'Nicht verfügbar'}
                </span>
              </div>
              <div className="raction">
                {downloading ? (
                  <div className="rprog">
                    <div className="track"><i style={{ width: `${Math.round((frac ?? 0) * 100)}%` }} /></div>
                    <div className="pct">{Math.round((frac ?? 0) * 100)} %</div>
                  </div>
                ) : isDown ? (
                  <>
                    <span className="rok">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      Offline
                    </span>
                    <button className="rdel" type="button" aria-label="Löschen" onClick={() => remove(s.code)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
                    </button>
                  </>
                ) : (
                  <button className="rbtn" type="button" disabled={!available || busy !== null} onClick={() => download(s.code)}>
                    Laden
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
