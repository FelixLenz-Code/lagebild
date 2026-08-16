import { useEffect, useState } from 'react';
import { batteryState, storageEstimate, type BatteryState } from './backup.js';
import { FEDERAL_STATES } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import {
  PACKAGE_LABEL,
  WORLD_CODE,
  deleteRegion,
  downloadPackage,
  regionBytes,
  type PackageKind,
  type RegionFiles,
} from './offlineMaps.js';

interface Props {
  /** Auf dem Server verfügbare Pakete je Region. */
  available: Record<string, RegionFiles>;
  /** Bereits heruntergeladene Pakete je Region. */
  offline: Record<string, RegionFiles>;
  onClose: () => void;
  onChanged: () => void;
}

const KINDS: PackageKind[] = ['map', 'route', 'search', 'terrain', 'pop'];
const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

export function OfflineRegions(props: Props) {
  /** Platz und Akku — beides gibt nicht jeder Browser her, dann fehlt die Zeile. */
  const [device, setDevice] = useState<{
    freeBytes: number | null;
    quotaBytes: number | null;
    battery: BatteryState | null;
  }>({ freeBytes: null, quotaBytes: null, battery: null });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([storageEstimate(), batteryState()]).then(([storage, battery]) => {
      if (cancelled) return;
      setDevice({
        freeBytes: storage ? Math.max(0, storage.quotaBytes - storage.usedBytes) : null,
        quotaBytes: storage?.quotaBytes ?? null,
        battery,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [props.offline]);

  const [progress, setProgress] = useState<{ code: string; kind: PackageKind; fraction: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadedCodes = Object.keys(props.offline).filter((c) => regionBytes(props.offline[c]) > 0);
  const totalBytes = downloadedCodes.reduce((a, c) => a + regionBytes(props.offline[c]), 0);
  const offerTotal = Object.keys(props.available).reduce((a, c) => a + regionBytes(props.available[c]), 0);
  const haveTotal = Object.keys(props.available).reduce(
    (a, c) =>
      a +
      KINDS.reduce((sum, k) => sum + (props.available[c]?.[k] && props.offline[c]?.[k] ? props.available[c]![k]! : 0), 0),
    0,
  );
  const missingAll = Object.keys(props.available).filter((c) =>
    KINDS.some((k) => props.available[c]?.[k] && !props.offline[c]?.[k]),
  ).length;

  /** Lädt alle auf dem Server vorhandenen Teile einer Region nacheinander. */
  async function download(code: string) {
    setError(null);
    setBusy(code);
    try {
      await downloadRegion(code);
    } catch {
      setError('Download fehlgeschlagen. Liegt das Paket auf dem Server?');
    } finally {
      setBusy(null);
      setProgress(null);
      props.onChanged();
    }
  }

  async function downloadRegion(code: string) {
    for (const kind of KINDS) {
      if (!props.available[code]?.[kind]) continue;
      if (props.offline[code]?.[kind]) continue;
      setProgress({ code, kind, fraction: 0 });
      await downloadPackage(code, kind, (fraction) => setProgress({ code, kind, fraction }));
      props.onChanged();
    }
  }

  /** Alles laden, was der Server hat — Routen laufen dann bundesweit. */
  async function downloadAll() {
    setError(null);
    setBusy('*');
    try {
      for (const s of FEDERAL_STATES) {
        if (!props.available[s.code]) continue;
        setBusy(s.code);
        await downloadRegion(s.code);
      }
    } catch {
      setError('Download fehlgeschlagen. Liegt das Paket auf dem Server?');
    } finally {
      setBusy(null);
      setProgress(null);
      props.onChanged();
    }
  }

  async function remove(code: string) {
    await deleteRegion(code);
    props.onChanged();
  }

  return (
    <Sheet title="Offline-Regionen" onClose={props.onClose}>
      <div className="storage-sum">
        <span className="big">{downloadedCodes.length}</span>
        <span className="u">Regionen offline</span>
        <span className="free">{totalBytes ? mb(totalBytes) : '0 MB'} belegt</span>
      </div>

      {/* Beim Packen vor der Tour sind das die zwei Zahlen, auf die es
          ankommt: Wie viel Platz ist noch da, und wie weit trägt der Akku. */}
      {(device.freeBytes != null || device.battery) && (
        <div className="device-bar">
          {device.freeBytes != null && (
            <span>
              <b>{mb(device.freeBytes)}</b> frei
              {device.quotaBytes ? ` von ${mb(device.quotaBytes)}` : ''}
            </span>
          )}
          {device.battery && (
            <span className={device.battery.level <= 0.2 && !device.battery.charging ? 'is-low' : ''}>
              <b>{Math.round(device.battery.level * 100)} %</b> Akku
              {device.battery.charging ? ' (lädt)' : ''}
            </span>
          )}
        </div>
      )}
      <div className="always-on">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <div>
          <b>Fachdaten sind bundesweit immer offline.</b> Hier lädst du zusätzlich die{' '}
          <b>Hintergrundkarte</b>, den <b>Routing-Graphen</b> und den <b>Suchindex</b> (Adressen und
          POIs) — damit funktionieren Suche und Navigation vollständig ohne Netz.
        </div>
      </div>
      {error && <p className="err" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="region all">
        <div className="rinfo">
          <b>Deutschland komplett</b>
          <span className="rmeta">
            {missingAll === 0
              ? 'Alle verfügbaren Regionen sind gespeichert'
              : `${missingAll} Regionen offen · ${mb(offerTotal - haveTotal)} zu laden`}
          </span>
        </div>
        <div className="raction">
          {missingAll > 0 && (
            <button className="rbtn" type="button" disabled={busy !== null} onClick={downloadAll}>
              Alles laden
            </button>
          )}
        </div>
      </div>
      <p className="sr-hint">
        Routen dürfen über Landesgrenzen gehen: Die App verbindet alle gespeicherten Regionen
        entlang der Strecke zu einem Netz.
      </p>

      <div className="region-list">
        {(() => {
          // Die Weltkarte steht vor den Ländern: Sie gehört zu keinem davon
          // und ist die Grundlage, auf der die Ausschnitte liegen.
          const code = WORLD_CODE;
          const have = props.offline[code] ?? {};
          const offer = props.available[code] ?? {};
          if (!regionBytes(offer) && !regionBytes(have)) return null;
          const downloading = busy === code;
          const frac = progress && progress.code === code ? progress.fraction : 0;
          const geladen = !!have.map;
          return (
            <div className="region is-world" key={code}>
              <span className="rcode">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.5 2.6 2.5 15 0 18M12 3c-2.5 2.6-2.5 15 0 18" />
                </svg>
              </span>
              <div className="rinfo">
                <b>Weltkarte (grob)</b>
                <span className="rmeta">
                  {downloading
                    ? 'Karte wird geladen …'
                    : `Nur weit herausgezoomt (bis Stufe 5) — damit ohne Netz die ganze Erde etwas zeigt, etwa unter den Satellitenbahnen. ${
                        offer.map ? mb(offer.map) : ''
                      }`}
                </span>
              </div>
              <div className="raction">
                {downloading ? (
                  <div className="rprog">
                    <div className="track"><i style={{ width: `${Math.round(frac * 100)}%` }} /></div>
                    <div className="pct">{Math.round(frac * 100)} %</div>
                  </div>
                ) : geladen ? (
                  <span className="rok">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    {mb(regionBytes(have))}
                  </span>
                ) : (
                  <button className="rbtn" type="button" disabled={busy !== null} onClick={() => download(code)}>
                    Laden
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {FEDERAL_STATES.map((s) => {
          const have = props.offline[s.code] ?? {};
          const offer = props.available[s.code] ?? {};
          const haveBytes = regionBytes(have);
          const offerBytes = regionBytes(offer);
          const missing = KINDS.filter((k) => offer[k] && !have[k]);
          const downloading = busy === s.code;
          const frac = progress && progress.code === s.code ? progress.fraction : 0;
          return (
            <div className="region" key={s.code}>
              <span className="rcode">{s.code}</span>
              <div className="rinfo">
                <b>{s.name}</b>
                <span className="rmeta">
                  {downloading
                    ? `${PACKAGE_LABEL[progress?.kind ?? 'map']} wird geladen …`
                    : offerBytes === 0
                      ? 'Nicht verfügbar'
                      : KINDS.filter((k) => offer[k]).map((k) => (
                          <span key={k} className={`part${have[k] ? ' is-on' : ''}`}>
                            {PACKAGE_LABEL[k]} {mb(offer[k]!)}
                          </span>
                        ))}
                </span>
              </div>
              <div className="raction">
                {downloading ? (
                  <div className="rprog">
                    <div className="track"><i style={{ width: `${Math.round(frac * 100)}%` }} /></div>
                    <div className="pct">{Math.round(frac * 100)} %</div>
                  </div>
                ) : (
                  <>
                    {haveBytes > 0 && missing.length === 0 && (
                      <span className="rok">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        {mb(haveBytes)}
                      </span>
                    )}
                    {missing.length > 0 && (
                      <button className="rbtn" type="button" disabled={busy !== null} onClick={() => download(s.code)}>
                        {haveBytes > 0 ? 'Ergänzen' : 'Laden'}
                      </button>
                    )}
                    {haveBytes > 0 && (
                      <button className="rdel" type="button" aria-label="Löschen" onClick={() => remove(s.code)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
