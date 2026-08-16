/**
 * Das Kartenblatt: die Karte auf Papier.
 *
 * Bei leerem Akku ist Papier die einzige Karte, die noch funktioniert — und
 * eine ausgedruckte Karte ohne Gitter, Maßstab und Notrufnummern ist ein Bild,
 * keine Karte. Dieses Blatt legt deshalb ein **UTM-Gitter** darüber (dasselbe,
 * in dem MGRS-Koordinaten gemeldet werden), schreibt den Maßstab dazu, nennt
 * die Eckkoordinaten und die Nummern, nach denen man im Ernstfall greift.
 *
 * Alles entsteht aus dem, was ohnehin da ist: dem Bild der Karte und der
 * Projektion, die die Karte selbst liefert. Es wird nichts nachgeladen.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Coords, RescuePoint } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import type { MapApi } from './LageMap.js';
import { formatDecimal, formatUtm, fromUtm, toMgrs, toUtm } from './coords.js';
import { distanceM } from './offline/graph.js';
import { formatLength } from './geo.js';

/** Breite des gedruckten Kartenbilds — dieselbe Zahl steht im Druck-CSS. */
const PRINT_WIDTH_MM = 180;

type Frame = NonNullable<Awaited<ReturnType<MapApi['sheet']>>>;

/** Gitterabstand (Meter), der auf dem Blatt zwischen 15 und 40 mm liegt. */
function gridStep(metersPerPixel: number, widthPx: number): number {
  const groundWidthM = metersPerPixel * widthPx;
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
  // Ziel: zwischen fünf und zwölf Linien über die Blattbreite.
  return steps.find((s) => groundWidthM / s <= 12) ?? steps[steps.length - 1]!;
}

/** Maßstabszahl für den Ausdruck: Boden zu Papier. */
function scaleDenominator(frame: Frame): number {
  const groundWidthM = frame.metersPerPixel * frame.width;
  return Math.round(groundWidthM / (PRINT_WIDTH_MM / 1000));
}

/**
 * Meridiankonvergenz: der Winkel zwischen **Gitternord** und geografisch Nord.
 *
 * Auf einem Blatt mit UTM-Gitter ist das die Zahl, die man beim Peilen braucht.
 * Die **magnetische** Missweisung steht bewusst nicht dabei — dafür bräuchte es
 * ein Erdmagnetfeldmodell, das die App nicht mitbringt; eine geschätzte Zahl
 * wäre auf einer Karte, nach der jemand läuft, schlimmer als keine.
 */
function convergence(c: Coords): number | null {
  const u = toUtm(c);
  if (!u) return null;
  const centralMeridian = (u.zone - 1) * 6 - 180 + 3;
  const dLon = ((c.lon - centralMeridian) * Math.PI) / 180;
  return (Math.atan(Math.tan(dLon) * Math.sin((c.lat * Math.PI) / 180)) * 180) / Math.PI;
}

interface Props {
  mapApi: MapApi | null;
  place: string;
  coords: Coords;
  rescue: RescuePoint[];
  onClose: () => void;
}

export function MapSheet(props: Props) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [withGrid, setWithGrid] = useState(true);

  // Das Bild wird einmal beim Öffnen genommen — sonst ändert sich das Blatt
  // unter der Hand, während man es liest. Die Karte stellt sich dafür kurz auf
  // den hellen Stil um, deshalb dauert es einen Augenblick.
  useEffect(() => {
    let cancelled = false;
    void props.mapApi
      ?.sheet()
      .then((f) => !cancelled && setFrame(f))
      .catch(() => !cancelled && setFrame(null));
    return () => {
      cancelled = true;
    };
  }, [props.mapApi]);

  const grid = useMemo(() => {
    if (!frame || !withGrid) return null;
    const step = gridStep(frame.metersPerPixel, frame.width);
    // Ecken des Bildes in UTM, daraus das umschließende Gitterrechteck.
    const corners = [
      frame.unproject(0, 0),
      frame.unproject(frame.width, 0),
      frame.unproject(0, frame.height),
      frame.unproject(frame.width, frame.height),
    ].map((c) => toUtm(c));
    if (corners.some((u) => !u)) return null;
    const zone = corners[0]!.zone;
    const north = corners[0]!.north;
    // Über Zonengrenzen hinweg wäre ein einziges Gitter falsch — dann lieber
    // keines als ein schiefes.
    if (corners.some((u) => u!.zone !== zone)) return null;

    const eastings = corners.map((u) => u!.easting);
    const northings = corners.map((u) => u!.northing);
    const e0 = Math.ceil(Math.min(...eastings) / step) * step;
    const e1 = Math.max(...eastings);
    const n0 = Math.ceil(Math.min(...northings) / step) * step;
    const n1 = Math.max(...northings);

    const lines: { x1: number; y1: number; x2: number; y2: number; label: string; vertical: boolean }[] = [];
    const at = (easting: number, northing: number) => {
      const c = fromUtm({ zone, band: '', north, easting, northing });
      return c ? frame.project(c.lat, c.lon) : null;
    };
    // Jede Gitterlinie wird über mehrere Stützpunkte gezogen: In der Projektion
    // der Karte ist sie leicht gekrümmt, und über ein ganzes Blatt sieht man das.
    for (let e = e0; e <= e1; e += step) {
      const a = at(e, Math.min(...northings));
      const b = at(e, Math.max(...northings));
      if (!a || !b) continue;
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, vertical: true, label: String(Math.round(e / 1000) % 100).padStart(2, '0') });
    }
    for (let n = n0; n <= n1; n += step) {
      const a = at(Math.min(...eastings), n);
      const b = at(Math.max(...eastings), n);
      if (!a || !b) continue;
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, vertical: false, label: String(Math.round(n / 1000) % 100).padStart(2, '0') });
    }
    return { lines, step, zone };
  }, [frame, withGrid]);

  const scale = frame ? scaleDenominator(frame) : null;
  const conv = frame ? convergence(frame.center) : null;
  const corners = frame
    ? {
        nw: frame.unproject(0, 0),
        ne: frame.unproject(frame.width, 0),
        sw: frame.unproject(0, frame.height),
        se: frame.unproject(frame.width, frame.height),
      }
    : null;

  const nearRescue = useMemo(
    () =>
      [...props.rescue]
        .map((r) => ({ ...r, away: distanceM(props.coords.lat, props.coords.lon, r.lat, r.lon) }))
        .sort((a, b) => a.away - b.away)
        .slice(0, 4),
    [props.rescue, props.coords],
  );

  const today = new Date().toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Sheet title="Kartenblatt" meta="Ausschnitt zum Ausdrucken — mit Gitter, Maßstab und Nummern" onClose={props.onClose}>
      {!frame && <p className="muted">Kartenblatt wird vorbereitet …</p>}

      {frame && (
        <>
          <div className="ms-controls no-print">
            <label className="ms-check">
              <input type="checkbox" checked={withGrid} onChange={() => setWithGrid((v) => !v)} />
              UTM-Gitter{grid ? ` (${grid.step >= 1000 ? `${grid.step / 1000} km` : `${grid.step} m`})` : ''}
            </label>
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              Drucken
            </button>
          </div>

          {/* Ab hier ist alles das gedruckte Blatt. */}
          <div className="mapsheet" id="mapsheet">
            <div className="ms-head">
              <div>
                <b>{props.place}</b>
                <span>{today}</span>
              </div>
              <div className="ms-scale">
                <b>1 : {scale?.toLocaleString('de-DE')}</b>
                <span>bei {PRINT_WIDTH_MM} mm Blattbreite</span>
              </div>
            </div>

            <div className="ms-map">
              <img src={frame.url} alt="Kartenausschnitt" />
              {grid && (
                <svg viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="none" className="ms-grid">
                  {grid.lines.map((l, i) => (
                    <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
                  ))}
                  {grid.lines
                    .filter((l) => l.vertical)
                    .map((l, i) => (
                      <text key={`t${i}`} x={l.x1 + 4} y={18} className="ms-grid-label">
                        {l.label}
                      </text>
                    ))}
                  {grid.lines
                    .filter((l) => !l.vertical)
                    .map((l, i) => (
                      <text key={`l${i}`} x={4} y={l.y1 - 4} className="ms-grid-label">
                        {l.label}
                      </text>
                    ))}
                </svg>
              )}
              {/* Maßstabsleiste: eine Gitterweite lang, damit sie zum Bild passt. */}
              {grid && (
                <div className="ms-bar">
                  <i style={{ width: `${(grid.step / frame.metersPerPixel / frame.width) * 100}%` }} />
                  <span>{grid.step >= 1000 ? `${grid.step / 1000} km` : `${grid.step} m`}</span>
                </div>
              )}
            </div>

            <div className="ms-legend">
              <div className="ms-block">
                <h4>Blattmitte</h4>
                <p className="mono">{toMgrs(frame.center) ?? '—'}</p>
                <p className="mono">{formatUtm(frame.center) ?? '—'}</p>
                <p className="mono">{formatDecimal(frame.center)}</p>
              </div>
              <div className="ms-block">
                <h4>Ecken (MGRS)</h4>
                {corners && (
                  <>
                    <p className="mono">NW {toMgrs(corners.nw, 4) ?? '—'}</p>
                    <p className="mono">NO {toMgrs(corners.ne, 4) ?? '—'}</p>
                    <p className="mono">SW {toMgrs(corners.sw, 4) ?? '—'}</p>
                    <p className="mono">SO {toMgrs(corners.se, 4) ?? '—'}</p>
                  </>
                )}
              </div>
              <div className="ms-block">
                <h4>Nord</h4>
                <p>
                  Gitternord weicht {conv == null ? '—' : `${Math.abs(conv).toFixed(1).replace('.', ',')}° nach ${conv >= 0 ? 'Ost' : 'West'}`} von geografisch Nord ab.
                </p>
                <p className="ms-small">
                  Die magnetische Missweisung ist hier <b>nicht</b> enthalten — die App führt kein
                  Erdmagnetfeldmodell.
                </p>
              </div>
              <div className="ms-block">
                <h4>Im Notfall</h4>
                <p className="mono">112 Feuerwehr und Rettung</p>
                <p className="mono">110 Polizei</p>
                <p className="mono">116 117 ärztlicher Bereitschaftsdienst</p>
                <p className="ms-small">Standort so durchgeben, wie er oben steht (MGRS oder Dezimalgrad).</p>
              </div>
              {nearRescue.length > 0 && (
                <div className="ms-block ms-wide">
                  <h4>Rettungspunkte in der Nähe</h4>
                  {nearRescue.map((r) => (
                    <p key={`${r.lat},${r.lon}`} className="mono">
                      {r.ref ?? 'ohne Kennung'} · {formatLength(r.away)} · {toMgrs({ lat: r.lat, lon: r.lon }, 4) ?? ''}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <p className="ms-foot">
              Lagebild · Karte © OpenStreetMap-Mitwirkende · Gitter {grid ? `UTM-Zone ${grid.zone}` : 'aus'} ·
              gedruckt {today}
            </p>
          </div>
        </>
      )}
    </Sheet>
  );
}
