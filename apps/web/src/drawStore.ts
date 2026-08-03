/** Eigene Markierungen des Nutzers (Punkte/POIs und Flächen), lokal gespeichert. */

export type DrawGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };

export interface DrawFeature {
  id: string;
  name: string;
  /** `line` entsteht beim Einlesen von Touren und beim Messen. */
  kind: 'point' | 'area' | 'line';
  geometry: DrawGeometry;
  /** Einzeln ausgeblendet — bleibt gespeichert, liegt nur nicht auf der Karte. */
  hidden?: boolean;
}

const KEY = 'lagebild.draw';

export function loadDraw(): DrawFeature[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DrawFeature[]) : [];
  } catch {
    return [];
  }
}

export function saveDraw(features: DrawFeature[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(features));
  } catch {
    /* Speicher nicht verfügbar */
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ *
 * Ausgabe: GPX und GeoJSON
 * ------------------------------------------------------------------ */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const point = (tag: string, [lon, lat]: [number, number]): string =>
  `<${tag} lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"`;

/**
 * Markierungen als GPX 1.1.
 *
 * **GPX kennt keine Flächen.** Ein Ring wird deshalb als geschlossene Spur
 * ausgegeben — jedes Wanderprogramm zeigt ihn dann als Linie, nicht als
 * gefülltes Gebiet. Wer die Fläche als Fläche braucht, nimmt GeoJSON.
 */
export function drawToGpx(features: DrawFeature[]): string {
  const parts: string[] = [];
  for (const f of features) {
    if (f.geometry.type === 'Point') {
      parts.push(
        `  ${point('wpt', f.geometry.coordinates)}><name>${esc(f.name)}</name></wpt>`,
      );
    }
  }
  for (const f of features) {
    const coords =
      f.geometry.type === 'LineString'
        ? f.geometry.coordinates
        : f.geometry.type === 'Polygon'
          ? (f.geometry.coordinates[0] ?? [])
          : null;
    if (!coords || coords.length < 2) continue;
    const points = coords.map((c) => `      ${point('trkpt', c)}/>`).join('\n');
    parts.push(
      `  <trk>\n    <name>${esc(f.name)}</name>\n` +
        (f.kind === 'area' ? `    <type>Fläche</type>\n` : '') +
        `    <trkseg>\n${points}\n    </trkseg>\n  </trk>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Lagebild" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>Meine Markierungen</name><time>${new Date().toISOString()}</time></metadata>\n` +
    `${parts.join('\n')}\n</gpx>\n`
  );
}

/** Markierungen als GeoJSON — die einzige Ausgabe, die Flächen behält. */
export function drawToGeoJsonText(features: DrawFeature[]): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature',
        properties: { name: f.name, kind: f.kind },
        geometry: f.geometry,
      })),
    },
    null,
    2,
  );
}

/** Datei zum Herunterladen anbieten. */
export function downloadText(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Dateinamen aus einem Markierungsnamen bauen. */
export const fileNameOf = (name: string, ext: string): string =>
  `${name.replace(/[^\w\d-]+/g, '_').replace(/^_+|_+$/g, '') || 'markierung'}.${ext}`;
