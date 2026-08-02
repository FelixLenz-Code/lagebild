/**
 * Aufgezeichnete Spuren („Tracks").
 *
 * Die Punkte liegen im localStorage — eine Stunde Gehen ergibt bei einem Punkt
 * alle drei Sekunden gut 1200 Punkte, also wenige Zehntel Megabyte. Damit das
 * nicht ausufert, werden Punkte beim Aufzeichnen ausgedünnt (siehe
 * `shouldKeep`) und die Zahl der Spuren begrenzt.
 */

export interface TrackPoint {
  lat: number;
  lon: number;
  /** Zeitstempel in Millisekunden. */
  t: number;
  /** Höhe in Metern, wenn das Gerät sie liefert. */
  ele?: number;
}

export interface Track {
  id: string;
  name: string;
  points: TrackPoint[];
  /** Länge in Metern (beim Speichern gerechnet). */
  distanceM: number;
  startedAt: number;
  endedAt: number;
}

const KEY = 'lagebild.tracks';
/** Mehr Spuren als das führt nur zu vollem Speicher. */
const MAX_TRACKS = 30;

export function loadTracks(): Track[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Track[];
    return Array.isArray(parsed) ? parsed.filter((t) => t && Array.isArray(t.points)) : [];
  } catch {
    return [];
  }
}

export function saveTracks(tracks: Track[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tracks.slice(-MAX_TRACKS)));
  } catch {
    /* voller Speicher darf die Aufzeichnung nicht abbrechen */
  }
}

export const newTrackId = (): string =>
  `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Entfernung zweier Punkte in Metern (Haversine). */
export function distanceM(a: TrackPoint, b: TrackPoint): number {
  const RAD = Math.PI / 180;
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Gesamtlänge einer Spur. */
export const trackLength = (points: TrackPoint[]): number =>
  points.reduce((sum, p, i) => (i ? sum + distanceM(points[i - 1]!, p) : 0), 0);

/**
 * Lohnt sich der neue Punkt?
 *
 * Beim Stehen liefert die Ortung weiter Punkte, die nur um die Messgenauigkeit
 * herumspringen — die würden die Spur aufblähen und die Länge künstlich
 * verlängern. Deshalb: mindestens 8 m Abstand oder 30 s Pause.
 */
export function shouldKeep(last: TrackPoint | undefined, next: TrackPoint): boolean {
  if (!last) return true;
  if (next.t - last.t >= 30_000) return true;
  return distanceM(last, next) >= 8;
}

/** Eine Spur als GPX 1.1 — das Format, das jede Wander- und Radsoftware liest. */
export function toGpx(track: Track): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const points = track.points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        (p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '') +
        `<time>${new Date(p.t).toISOString()}</time></trkpt>`,
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Lagebild" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>${esc(track.name)}</name>` +
    `<time>${new Date(track.startedAt).toISOString()}</time></metadata>\n` +
    `  <trk>\n    <name>${esc(track.name)}</name>\n    <trkseg>\n${points}\n    </trkseg>\n  </trk>\n` +
    `</gpx>\n`
  );
}

/** GPX-Datei zum Herunterladen anbieten. */
export function downloadGpx(track: Track): void {
  const blob = new Blob([toGpx(track)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${track.name.replace(/[^\w\d-]+/g, '_') || 'spur'}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Der Browser braucht die URL nur bis zum Klick.
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
