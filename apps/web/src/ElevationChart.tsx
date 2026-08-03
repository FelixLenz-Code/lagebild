import { useState } from 'react';
import type { ElevationProfile } from './offline/terrain.js';
import { formatLength } from './geo.js';

/**
 * Höhenprofil einer Route oder Tour.
 *
 * Wichtiger als die hübsche Kurve sind die drei Zahlen darüber: Anstieg,
 * Abstieg und Spanne. Danach entscheidet sich, ob eine Strecke mit dem Rad
 * oder zu Fuß zumutbar ist — die Länge allein sagt darüber nichts.
 */

const W = 320;
const H = 96;
const PAD_TOP = 8;
const PAD_BOTTOM = 16;

export function ElevationChart({ profile }: { profile: ElevationProfile }) {
  const [at, setAt] = useState<number | null>(null);
  const points = profile.points.filter((p) => p.eleM != null);
  if (points.length < 2 || profile.minM == null || profile.maxM == null) return null;

  const total = profile.points[profile.points.length - 1]!.distanceM;
  // Bei flachem Gelände würde eine automatische Skala jedes Rauschen zum
  // Gebirge machen — deshalb mindestens 50 m Spanne.
  const span = Math.max(50, profile.maxM - profile.minM);
  const mid = (profile.maxM + profile.minM) / 2;
  const low = mid - span / 2;
  const x = (d: number) => (total > 0 ? (d / total) * W : 0);
  const y = (e: number) => PAD_TOP + (1 - (e - low) / span) * (H - PAD_TOP - PAD_BOTTOM);

  const line = points.map((p) => `${x(p.distanceM).toFixed(1)},${y(p.eleM!).toFixed(1)}`).join(' ');
  const area = `${x(points[0]!.distanceM).toFixed(1)},${H - PAD_BOTTOM} ${line} ${x(
    points[points.length - 1]!.distanceM,
  ).toFixed(1)},${H - PAD_BOTTOM}`;

  const hover = at == null ? null : points[Math.max(0, Math.min(points.length - 1, at))];

  return (
    <div className="elev">
      <div className="elev-sum">
        <span className="elev-up">
          ↑ <b>{profile.gainM} m</b>
        </span>
        <span className="elev-down">
          ↓ <b>{profile.lossM} m</b>
        </span>
        <span className="muted">
          {profile.minM}–{profile.maxM} m
        </span>
        <span className="muted elev-src">
          {profile.source === 'file' ? 'Höhen aus der Datei' : 'Höhen aus dem Gelände­paket'}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="elev-chart"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Höhenprofil: ${profile.gainM} Meter Anstieg, ${profile.lossM} Meter Abstieg`}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - box.left) / box.width;
          setAt(Math.round(frac * (points.length - 1)));
        }}
        onPointerLeave={() => setAt(null)}
      >
        <polyline className="elev-area" points={area} />
        <polyline className="elev-line" points={line} />
        {hover && (
          <line className="elev-cursor" x1={x(hover.distanceM)} y1={PAD_TOP} x2={x(hover.distanceM)} y2={H - PAD_BOTTOM} />
        )}
      </svg>

      <div className="elev-foot">
        {hover ? (
          <span className="mono">
            {formatLength(hover.distanceM)} · {Math.round(hover.eleM!)} m
          </span>
        ) : (
          <>
            <span className="mono">0</span>
            <span className="mono">{formatLength(total)}</span>
          </>
        )}
      </div>
    </div>
  );
}
