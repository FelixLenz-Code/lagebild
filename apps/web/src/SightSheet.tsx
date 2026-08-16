/**
 * Sichtverbindung: „Sehe ich von hier bis dorthin?"
 *
 * Für Funk (Relais, Handfunkgerät, Richtstrecke) genauso wie fürs Auge — sehe
 * ich den Gipfel, sieht mich der Hubschrauber, ist die Wolkenwand hinter dem
 * Grat. Gerechnet wird aus dem Geländepaket im Gerät, mit Erdkrümmung und, wenn
 * eine Frequenz gewählt ist, mit der ersten Fresnelzone.
 */

import { useEffect, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { sightOffline } from './offline/client.js';
import type { SightResult } from './offline/terrain.js';
import { formatLength } from './geo.js';
import { bearingTo, compassPoint } from './compass.js';

interface Props {
  from: Coords;
  to: Coords;
  label?: string | null;
  /** Regionen mit Geländepaket. */
  terrainCodes: string[];
  onClose: () => void;
}

/** Gängige Bänder — die Fresnelzone hängt an der Wellenlänge. */
const BANDS: { mhz: number | null; label: string }[] = [
  { mhz: null, label: 'nur Sicht' },
  { mhz: 145, label: '2 m' },
  { mhz: 435, label: '70 cm' },
  { mhz: 868, label: '868 MHz' },
  { mhz: 2400, label: '2,4 GHz' },
];

/** Antennenhöhen, die man im Feld wirklich hat. */
const HEIGHTS = [1.5, 2, 5, 10, 30];

const W = 320;
const H = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 16;

const VERDICT: Record<SightResult['verdict'], { text: string; color: string }> = {
  frei: { text: 'Freie Sicht', color: 'var(--ok)' },
  angeschnitten: { text: 'Sicht frei, Fresnelzone angeschnitten', color: 'var(--sev1)' },
  verdeckt: { text: 'Verdeckt — keine Sichtverbindung', color: 'var(--sev3)' },
};

export function SightSheet(props: Props) {
  const [fromHeightM, setFromHeightM] = useState(2);
  const [toHeightM, setToHeightM] = useState(2);
  const [freqMHz, setFreqMHz] = useState<number | null>(145);
  const [result, setResult] = useState<SightResult | null>(null);
  const [state, setState] = useState<'lade' | 'ok' | 'leer'>('lade');

  const codesKey = props.terrainCodes.join(',');
  useEffect(() => {
    if (!props.terrainCodes.length) {
      setState('leer');
      return;
    }
    let cancelled = false;
    setState('lade');
    sightOffline(props.terrainCodes, props.from, props.to, {
      fromHeightM,
      toHeightM,
      ...(freqMHz ? { freqMHz } : {}),
    })
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setState(r ? 'ok' : 'leer');
      })
      .catch(() => !cancelled && setState('leer'));
    return () => {
      cancelled = true;
    };
  }, [codesKey, fromHeightM, toHeightM, freqMHz, props.from.lat, props.from.lon, props.to.lat, props.to.lon]);

  const bearing = bearingTo(props.from, props.to);

  /* --- Der Schnitt als Bild --- */
  let chart: JSX.Element | null = null;
  if (result) {
    const values = result.points.flatMap((p) => [p.groundM ?? 0, p.lineM, p.fresnelM]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(30, max - min);
    const x = (d: number) => (d / result.distanceM) * W;
    const y = (e: number) => PAD_TOP + (1 - (e - min) / span) * (H - PAD_TOP - PAD_BOTTOM);
    const ground = result.points
      .filter((p) => p.groundM != null)
      .map((p) => `${x(p.distanceM).toFixed(1)},${y(p.groundM!).toFixed(1)}`)
      .join(' ');
    const first = result.points[0]!;
    const last = result.points[result.points.length - 1]!;
    chart = (
      <svg viewBox={`0 0 ${W} ${H}`} className="elev-chart sight-chart" preserveAspectRatio="none" role="img" aria-label="Geländeschnitt der Strecke">
        <polyline
          className="elev-area"
          points={`${x(first.distanceM)},${H - PAD_BOTTOM} ${ground} ${x(last.distanceM)},${H - PAD_BOTTOM}`}
        />
        <polyline className="elev-line" points={ground} />
        {freqMHz && (
          <polyline
            className="sight-fresnel"
            points={result.points.map((p) => `${x(p.distanceM).toFixed(1)},${y(p.fresnelM).toFixed(1)}`).join(' ')}
          />
        )}
        <line
          className={`sight-line is-${result.verdict}`}
          x1={x(0)}
          y1={y(result.points[0]!.lineM)}
          x2={x(result.distanceM)}
          y2={y(last.lineM)}
        />
        {result.worst && (
          <line
            className="sight-block"
            x1={x(result.worst.distanceM)}
            y1={PAD_TOP}
            x2={x(result.worst.distanceM)}
            y2={H - PAD_BOTTOM}
          />
        )}
      </svg>
    );
  }

  return (
    <Sheet
      title="Sichtverbindung"
      meta={`${props.label ? `${props.label} · ` : ''}${Math.round(bearing)}° ${compassPoint(bearing)}`}
      onClose={props.onClose}
    >
      {state === 'leer' && (
        <p className="rp-hint err">
          Ohne Geländepaket dieser Region lässt sich kein Schnitt rechnen — unter „Offline" ladbar. Auch der
          Anfangspunkt muss darin liegen.
        </p>
      )}
      {state === 'lade' && <p className="muted">Geländeschnitt wird gerechnet …</p>}

      {result && state === 'ok' && (
        <>
          <div className="sight-verdict" style={{ borderColor: VERDICT[result.verdict].color }}>
            <b style={{ color: VERDICT[result.verdict].color }}>{VERDICT[result.verdict].text}</b>
            <span className="mono">
              {formatLength(result.distanceM)} · {result.fromEleM} m → {result.toEleM} m
            </span>
          </div>

          {chart}

          {result.worst ? (
            <p className="sight-note">
              Höchstes Hindernis bei {formatLength(result.worst.distanceM)}, {result.worst.overM
                .toFixed(1)
                .replace('.', ',')}{' '}
              m über der Sichtlinie.
              {result.neededHeightM != null &&
                ` Frei würde es ab etwa ${result.neededHeightM} m Antennenhöhe am Standort.`}
            </p>
          ) : result.verdict === 'angeschnitten' ? (
            <p className="sight-note">
              Die Sichtlinie ist frei, das Gelände ragt aber in die erste Fresnelzone — die Strecke steht,
              dämpft jedoch. Höher aufbauen hilft.
            </p>
          ) : (
            <p className="sight-note">Nichts im Weg, auch die Fresnelzone bleibt frei.</p>
          )}

          {/* Der wichtigste Satz des Blatts. */}
          <p className="sight-warn">
            Gerechnet ist nur das nackte Gelände: Wald, Häuser und Masten kennt das Höhenmodell nicht.
          </p>
        </>
      )}

      <div className="sect-label">Antennenhöhe über Grund</div>
      <div className="sight-rows">
        <div className="sight-row">
          <span>Hier</span>
          {HEIGHTS.map((h) => (
            <button
              key={h}
              type="button"
              className={`rp-chip${fromHeightM === h ? ' is-on' : ''}`}
              aria-pressed={fromHeightM === h}
              onClick={() => setFromHeightM(h)}
            >
              {h.toString().replace('.', ',')} m
            </button>
          ))}
        </div>
        <div className="sight-row">
          <span>Dort</span>
          {HEIGHTS.map((h) => (
            <button
              key={h}
              type="button"
              className={`rp-chip${toHeightM === h ? ' is-on' : ''}`}
              aria-pressed={toHeightM === h}
              onClick={() => setToHeightM(h)}
            >
              {h.toString().replace('.', ',')} m
            </button>
          ))}
        </div>
      </div>

      <div className="sect-label">Band (bestimmt die Fresnelzone)</div>
      <div className="sight-row">
        {BANDS.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`rp-chip${freqMHz === b.mhz ? ' is-on' : ''}`}
            aria-pressed={freqMHz === b.mhz}
            onClick={() => setFreqMHz(b.mhz)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
