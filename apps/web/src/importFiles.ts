/**
 * Einlesen fremder Kartendateien: **GPX, KML, KMZ und GeoJSON**.
 *
 * Gegenstück zum GPX-Export in `trackStore.ts`. Wer eine Tour aus Komoot,
 * Outdooractive, Google Earth oder von der Feuerwehr bekommt, soll sie hier
 * öffnen können — Linien werden zu Spuren, einzelne Punkte zu Markierungen,
 * Flächen zu markierten Gebieten.
 *
 * Wie im übrigen Projekt ist der Leser selbst geschrieben (kein Paket) und
 * benutzt **keine DOM-Schnittstellen** — dadurch läuft er unverändert im
 * Prüfskript unter Node (`scripts/check-import.mts`).
 */

import { newId, type DrawFeature } from './drawStore.js';
import { newTrackId, trackLength, type Track, type TrackPoint } from './trackStore.js';

/* ------------------------------------------------------------------ *
 * Ein sehr kleiner XML-Leser
 * ------------------------------------------------------------------ */

export interface XmlNode {
  /** Kleingeschrieben und **ohne Namensraum** (`gx:Track` → `track`). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Aneinandergehängter Text direkt in diesem Element. */
  text: string;
}

/** `kml:Placemark` → `placemark`. Die Namensräume interessieren hier nicht. */
const localName = (raw: string): string => {
  const colon = raw.lastIndexOf(':');
  return (colon < 0 ? raw : raw.slice(colon + 1)).toLowerCase();
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Ende eines Tags suchen — ein `>` in einem Attributwert zählt nicht. */
function tagEnd(src: string, from: number): number {
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(raw))) {
    const value = m[2]!;
    const unquoted = value[0] === '"' || value[0] === "'" ? value.slice(1, -1) : value;
    attrs[localName(m[1]!)] = decodeEntities(unquoted);
  }
  return attrs;
}

/**
 * XML zu einem Baum. Der Leser ist bewusst nachsichtig: unbekannte
 * Anweisungen, Kommentare und falsch geschachtelte Endetags werden
 * übergangen, statt den ganzen Import scheitern zu lassen — fremde Dateien
 * sind selten sauber.
 */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(source.slice(i, lt));

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      top().text += source.slice(lt + 9, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = tagEnd(source, lt + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    const gt = tagEnd(source, lt + 1);
    if (gt < 0) break;
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const name = localName(inner.slice(1).trim());
      // Bis zum passenden Anfang zurückgehen; findet sich keiner, war das
      // Endetag überzählig und wird verworfen.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.name === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s]/);
    const name = localName(space < 0 ? body : body.slice(0, space));
    if (!name) continue;
    const node: XmlNode = {
      name,
      attrs: space < 0 ? {} : parseAttrs(body.slice(space)),
      children: [],
      text: '',
    };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** Erstes direktes Kind mit diesem Namen. */
export const child = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find((c) => c.name === name);

/** Text eines direkten Kindes, ohne umgebende Leerzeichen. */
const childText = (node: XmlNode, name: string): string => (child(node, name)?.text ?? '').trim();

/** Alle Nachfahren mit diesem Namen, in Dokumentreihenfolge. */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/* ------------------------------------------------------------------ *
 * Ergebnis eines Imports
 * ------------------------------------------------------------------ */

export type ImportFormat = 'gpx' | 'kml' | 'kmz' | 'geojson';

export interface ImportLine {
  name: string;
  points: TrackPoint[];
}

export interface ImportPoint {
  name: string;
  lat: number;
  lon: number;
  ele?: number;
  note?: string;
}

export interface ImportArea {
  name: string;
  /** Äußerer Ring, [lon, lat]. */
  ring: [number, number][];
}

export interface ImportResult {
  /** Dateiname, dient auch als Vorlage für Namen ohne eigene Bezeichnung. */
  source: string;
  format: ImportFormat;
  lines: ImportLine[];
  points: ImportPoint[];
  areas: ImportArea[];
  /** Geometrien, mit denen nichts anzufangen war (z. B. Overlays in KML). */
  skipped: number;
  /** Punkte, die beim Ausdünnen weggefallen sind. */
  thinned: number;
  /** [west, süd, ost, nord] über alles Eingelesene. */
  bbox: [number, number, number, number] | null;
}

export class ImportError extends Error {}

/* ------------------------------------------------------------------ *
 * Grenzen — fremde Dateien können sehr groß sein
 * ------------------------------------------------------------------ */

/** Mehr Stützpunkte je Linie bringen auf der Karte nichts und sprengen den localStorage. */
const MAX_LINE_POINTS = 4000;
/** Ausdünnen bis zu dieser Genauigkeit ist verlustfrei genug für jede Karte. */
const THIN_TOLERANCE_M = 4;
/** Sicherheitsnetz gegen Dateien mit Zehntausenden Wegpunkten. */
const MAX_FEATURES = 500;

/* ------------------------------------------------------------------ *
 * Hilfen für Koordinaten
 * ------------------------------------------------------------------ */

const validPoint = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

const num = (s: string | undefined): number => (s == null || s === '' ? NaN : Number(s));

/** Zeitstempel eines Punktes; 0 heißt „keiner vorhanden". */
function timeOf(raw: string): number {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Ausdünnen nach Douglas-Peucker (iterativ, damit auch 100.000 Punkte nicht
 * den Aufrufstapel sprengen). Gerechnet wird in Metern über eine örtliche
 * Näherung — auf Tourlänge genau genug.
 */
function simplify(points: TrackPoint[], toleranceM: number): TrackPoint[] {
  if (points.length < 3) return points;
  const lat0 = (points[0]!.lat * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const x = points.map((p) => p.lon * mx);
  const y = points.map((p) => p.lat * my);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const tol2 = toleranceM * toleranceM;

  while (stack.length) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) continue;
    const ax = x[from]!;
    const ay = y[from]!;
    const bx = x[to]!;
    const by = y[to]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstAt = -1;
    for (let i = from + 1; i < to; i++) {
      const px = x[i]! - ax;
      const py = y[i]! - ay;
      // Abstand zur Strecke A–B; bei A = B genügt der Abstand zu A.
      let d2: number;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ox = px - t * dx;
        const oy = py - t * dy;
        d2 = ox * ox + oy * oy;
      }
      if (d2 > worst) {
        worst = d2;
        worstAt = i;
      }
    }
    if (worst > tol2 && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([from, worstAt], [worstAt, to]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Auf eine handliche Zahl Stützpunkte bringen.
 *
 * Reicht die feine Toleranz nicht, wird sie **verdoppelt und erneut
 * ausgedünnt** — nicht etwa „jeder n-te Punkt" genommen. Gemessen: eine
 * 33-km-Aufzeichnung mit 30.000 Punkten weicht nach Douglas-Peucker um
 * höchstens 4 m ab, nach dem Ausdünnen jedes zweiten Punktes dagegen um 13 m.
 * Wer beim Wandern der eigenen Spur folgt, merkt den Unterschied.
 */
function fitLine(points: TrackPoint[]): { points: TrackPoint[]; dropped: number } {
  const before = points.length;
  let out = points;
  for (let tolerance = THIN_TOLERANCE_M; out.length > MAX_LINE_POINTS && tolerance <= 64; tolerance *= 2) {
    out = simplify(points, tolerance);
  }
  if (out.length > MAX_LINE_POINTS) {
    // Kommt nur bei absurd dichten Dateien vor; dann zählt, dass die App
    // benutzbar bleibt.
    const step = Math.ceil(out.length / MAX_LINE_POINTS);
    const every = out.filter((_, i) => i % step === 0);
    if (every[every.length - 1] !== out[out.length - 1]) every.push(out[out.length - 1]!);
    out = every;
  }
  return { points: out, dropped: before - out.length };
}

/* ------------------------------------------------------------------ *
 * GPX
 * ------------------------------------------------------------------ */

/** `<wpt>`, `<rtept>`, `<trkpt>` — alle drei tragen lat/lon als Attribut. */
function gpxPoint(node: XmlNode): TrackPoint | null {
  const lat = num(node.attrs['lat']);
  const lon = num(node.attrs['lon']);
  if (!validPoint(lat, lon)) return null;
  const ele = num(childText(node, 'ele'));
  return {
    lat,
    lon,
    t: timeOf(childText(node, 'time')),
    ...(Number.isFinite(ele) ? { ele } : {}),
  };
}

function readGpx(root: XmlNode, source: string): Omit<ImportResult, 'bbox' | 'format' | 'source' | 'thinned'> {
  const gpx = child(root, 'gpx');
  if (!gpx) throw new ImportError('Das ist keine GPX-Datei — das Element <gpx> fehlt.');
  const lines: ImportLine[] = [];
  const points: ImportPoint[] = [];
  let skipped = 0;

  for (const trk of descendants(gpx, 'trk')) {
    const base = childText(trk, 'name') || 'Spur';
    const segments = descendants(trk, 'trkseg');
    // Ein Track kann mehrere Abschnitte haben (Pausen im Gerät). Sie werden
    // nicht zusammengezogen — sonst zöge sich eine gerade Linie über die
    // Lücke, die es in Wirklichkeit nie gab.
    const usable = segments
      .map((seg) => descendants(seg, 'trkpt').map(gpxPoint).filter((p): p is TrackPoint => !!p))
      .filter((pts) => pts.length > 1);
    if (!usable.length) {
      skipped++;
      continue;
    }
    usable.forEach((pts, i) =>
      lines.push({ name: usable.length > 1 ? `${base} (${i + 1})` : base, points: pts }),
    );
  }

  for (const rte of descendants(gpx, 'rte')) {
    const pts = descendants(rte, 'rtept')
      .map(gpxPoint)
      .filter((p): p is TrackPoint => !!p);
    if (pts.length > 1) lines.push({ name: childText(rte, 'name') || 'Route', points: pts });
    else skipped++;
  }

  for (const wpt of gpx.children.filter((c) => c.name === 'wpt')) {
    const p = gpxPoint(wpt);
    if (!p) {
      skipped++;
      continue;
    }
    const note = childText(wpt, 'desc') || childText(wpt, 'cmt');
    points.push({
      name: childText(wpt, 'name') || 'Punkt',
      lat: p.lat,
      lon: p.lon,
      ...(p.ele != null ? { ele: p.ele } : {}),
      ...(note ? { note } : {}),
    });
  }

  if (!lines.length && !points.length) {
    throw new ImportError(`In „${source}" steckt keine verwertbare Spur und kein Wegpunkt.`);
  }
  return { lines, points, areas: [], skipped };
}

/* ------------------------------------------------------------------ *
 * KML
 * ------------------------------------------------------------------ */

/**
 * KML-`<coordinates>`: Tupel `lon,lat[,höhe]`, getrennt durch beliebigen
 * Leerraum. Manche Erzeuger setzen zusätzlich Leerzeichen hinter die Kommas —
 * deshalb wird nicht stur an Leerzeichen zerlegt.
 */
function kmlCoords(raw: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const tuple of raw.trim().split(/\s+(?=-?[\d.])/)) {
    const parts = tuple.split(',');
    if (parts.length < 2) continue;
    const lon = num(parts[0]!.trim());
    const lat = num(parts[1]!.trim());
    if (!validPoint(lat, lon)) continue;
    const ele = parts.length > 2 ? num(parts[2]!.trim()) : NaN;
    out.push({ lat, lon, t: 0, ...(Number.isFinite(ele) ? { ele } : {}) });
  }
  return out;
}

/** Beschreibungen sind in KML oft HTML — für eine Zeile Text reicht der Rohtext. */
const plain = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

function readKml(root: XmlNode, source: string): Omit<ImportResult, 'bbox' | 'format' | 'source' | 'thinned'> {
  const kml = child(root, 'kml') ?? root;
  const lines: ImportLine[] = [];
  const points: ImportPoint[] = [];
  const areas: ImportArea[] = [];
  let skipped = 0;

  for (const mark of descendants(kml, 'placemark')) {
    const name = childText(mark, 'name') || 'Markierung';
    const note = plain(childText(mark, 'description'));
    let found = 0;

    // MultiGeometry braucht keine Sonderbehandlung: die Suche geht ohnehin
    // über alle Nachfahren des Placemarks.
    for (const p of descendants(mark, 'point')) {
      const [first] = kmlCoords(child(p, 'coordinates')?.text ?? '');
      if (!first) continue;
      found++;
      points.push({
        name,
        lat: first.lat,
        lon: first.lon,
        ...(first.ele != null ? { ele: first.ele } : {}),
        ...(note ? { note } : {}),
      });
    }

    for (const l of descendants(mark, 'linestring')) {
      const pts = kmlCoords(child(l, 'coordinates')?.text ?? '');
      if (pts.length < 2) continue;
      found++;
      lines.push({ name, points: pts });
    }

    // gx:Track — so legt Google Earth aufgezeichnete Wege ab: Zeit und Ort
    // stehen getrennt, aber in gleicher Reihenfolge.
    for (const t of descendants(mark, 'track')) {
      const whens = t.children.filter((c) => c.name === 'when').map((c) => timeOf(c.text.trim()));
      const pts: TrackPoint[] = [];
      t.children
        .filter((c) => c.name === 'coord')
        .forEach((c, i) => {
          const [lon, lat, ele] = c.text.trim().split(/\s+/).map(Number);
          if (lon == null || lat == null || !validPoint(lat, lon)) return;
          pts.push({
            lat,
            lon,
            t: whens[i] ?? 0,
            ...(ele != null && Number.isFinite(ele) ? { ele } : {}),
          });
        });
      if (pts.length < 2) continue;
      found++;
      lines.push({ name, points: pts });
    }

    for (const poly of descendants(mark, 'polygon')) {
      const outer = child(poly, 'outerboundaryis') ?? poly;
      const ring = kmlCoords(descendants(outer, 'linearring')[0]?.children.find((c) => c.name === 'coordinates')?.text ?? '');
      if (ring.length < 3) continue;
      found++;
      areas.push({ name, ring: ring.map((p) => [p.lon, p.lat] as [number, number]) });
    }

    if (!found) skipped++;
  }

  if (!lines.length && !points.length && !areas.length) {
    throw new ImportError(`In „${source}" steckt keine Geometrie, mit der die Karte etwas anfangen kann.`);
  }
  return { lines, points, areas, skipped };
}

/* ------------------------------------------------------------------ *
 * GeoJSON
 * ------------------------------------------------------------------ */

const NAME_KEYS = ['name', 'Name', 'NAME', 'title', 'Titel', 'bezeichnung', 'ref'];

function readGeoJson(text: string, source: string): Omit<ImportResult, 'bbox' | 'format' | 'source' | 'thinned'> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ImportError(`„${source}" ist kein gültiges GeoJSON.`);
  }
  const lines: ImportLine[] = [];
  const points: ImportPoint[] = [];
  const areas: ImportArea[] = [];
  let skipped = 0;

  const toPoints = (coords: unknown): TrackPoint[] =>
    Array.isArray(coords)
      ? coords
          .map((c) => (Array.isArray(c) ? { lat: Number(c[1]), lon: Number(c[0]), t: 0 } : null))
          .filter((p): p is TrackPoint => !!p && validPoint(p.lat, p.lon))
      : [];

  const handle = (geometry: any, props: Record<string, unknown>) => {
    if (!geometry || typeof geometry.type !== 'string') {
      skipped++;
      return;
    }
    const name =
      (NAME_KEYS.map((k) => props[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined)?.trim() ??
      'Markierung';
    const note = typeof props['description'] === 'string' ? plain(props['description']) : '';
    const c = geometry.coordinates;
    switch (geometry.type) {
      case 'Point': {
        const lat = Number(c?.[1]);
        const lon = Number(c?.[0]);
        if (validPoint(lat, lon)) points.push({ name, lat, lon, ...(note ? { note } : {}) });
        else skipped++;
        return;
      }
      case 'MultiPoint':
        for (const p of toPoints(c)) points.push({ name, lat: p.lat, lon: p.lon, ...(note ? { note } : {}) });
        return;
      case 'LineString': {
        const pts = toPoints(c);
        pts.length > 1 ? lines.push({ name, points: pts }) : skipped++;
        return;
      }
      case 'MultiLineString':
        for (const part of Array.isArray(c) ? c : []) {
          const pts = toPoints(part);
          if (pts.length > 1) lines.push({ name, points: pts });
        }
        return;
      case 'Polygon': {
        const ring = toPoints(Array.isArray(c) ? c[0] : null);
        ring.length > 2
          ? areas.push({ name, ring: ring.map((p) => [p.lon, p.lat] as [number, number]) })
          : skipped++;
        return;
      }
      case 'MultiPolygon':
        for (const poly of Array.isArray(c) ? c : []) {
          const ring = toPoints(Array.isArray(poly) ? poly[0] : null);
          if (ring.length > 2) areas.push({ name, ring: ring.map((p) => [p.lon, p.lat] as [number, number]) });
        }
        return;
      case 'GeometryCollection':
        for (const g of Array.isArray(geometry.geometries) ? geometry.geometries : []) handle(g, props);
        return;
      default:
        skipped++;
    }
  };

  const root = doc as any;
  if (root?.type === 'FeatureCollection' && Array.isArray(root.features)) {
    for (const f of root.features) handle(f?.geometry, f?.properties ?? {});
  } else if (root?.type === 'Feature') {
    handle(root.geometry, root.properties ?? {});
  } else {
    handle(root, {});
  }

  if (!lines.length && !points.length && !areas.length) {
    throw new ImportError(`In „${source}" steckt keine verwertbare Geometrie.`);
  }
  return { lines, points, areas, skipped };
}

/* ------------------------------------------------------------------ *
 * KMZ = ZIP mit einer KML darin
 * ------------------------------------------------------------------ */

/**
 * Nur so viel ZIP, wie für KMZ nötig ist: das zentrale Verzeichnis lesen und
 * den KML-Eintrag entpacken (gespeichert oder „deflate"). Bilder und andere
 * Beigaben werden übergangen — die App zeigt ohnehin nur Geometrie.
 */
async function kmlFromKmz(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Das Ende des zentralen Verzeichnisses steht am Dateiende, hinter einem
  // möglichen Kommentar — deshalb rückwärts nach der Kennung suchen.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError('Die KMZ-Datei ist unvollständig oder beschädigt.');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  let entry: { method: number; offset: number; size: number } | null = null;
  let bestScore = -1;

  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // doc.kml im Wurzelverzeichnis ist der Regelfall; sonst die erste KML.
    if (name.toLowerCase().endsWith('.kml')) {
      const score = name.toLowerCase() === 'doc.kml' ? 2 : name.includes('/') ? 0 : 1;
      if (score > bestScore) {
        bestScore = score;
        entry = { method, offset, size: compressed };
      }
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new ImportError('In der KMZ-Datei steckt keine KML-Datei.');

  // Der örtliche Kopf wiederholt die Namens- und Zusatzlängen; erst dahinter
  // beginnen die Daten.
  if (view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new ImportError('Die KMZ-Datei ist beschädigt.');
  }
  const dataAt =
    entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const raw = bytes.subarray(dataAt, dataAt + entry.size);
  if (entry.method === 0) return decodeText(raw);
  if (entry.method !== 8) throw new ImportError('Die KMZ-Datei benutzt ein unbekanntes Packverfahren.');
  if (typeof DecompressionStream === 'undefined') {
    throw new ImportError('Dieser Browser kann KMZ nicht entpacken — bitte die KML-Datei benutzen.');
  }
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return decodeText(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/* ------------------------------------------------------------------ *
 * Einstieg
 * ------------------------------------------------------------------ */

/**
 * Text entziffern. Ohne Angabe gilt UTF-8; ältere Werkzeuge schreiben aber
 * `encoding="ISO-8859-1"` in den XML-Kopf, und dann werden aus Umlauten
 * sonst Fragezeichen.
 */
function decodeText(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (declared && !/^utf-?8$/.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      /* unbekannte Angabe → UTF-8 versuchen */
    }
  }
  return new TextDecoder().decode(bytes);
}

function formatOf(name: string, bytes: Uint8Array): ImportFormat {
  const lower = name.toLowerCase();
  // Die Kennung am Dateianfang schlägt die Endung — Dateien werden umbenannt.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'kmz';
  if (lower.endsWith('.gpx')) return 'gpx';
  if (lower.endsWith('.kml')) return 'kml';
  if (lower.endsWith('.kmz')) return 'kmz';
  if (lower.endsWith('.geojson') || lower.endsWith('.json')) return 'geojson';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1000)).toLowerCase();
  if (head.includes('<gpx')) return 'gpx';
  if (head.includes('<kml')) return 'kml';
  if (head.trimStart().startsWith('{')) return 'geojson';
  throw new ImportError('Unbekanntes Format. Lesbar sind GPX, KML, KMZ und GeoJSON.');
}

/** Umschließendes Rechteck über alles Eingelesene. */
function boundsOf(r: Pick<ImportResult, 'lines' | 'points' | 'areas'>): ImportResult['bbox'] {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  const add = (lon: number, lat: number) => {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  for (const l of r.lines) for (const p of l.points) add(p.lon, p.lat);
  for (const p of r.points) add(p.lon, p.lat);
  for (const a of r.areas) for (const [lon, lat] of a.ring) add(lon, lat);
  return east < west ? null : [west, south, east, north];
}

/**
 * Eine Datei einlesen. Wirft `ImportError` mit einem Satz, der dem Nutzer
 * sagt, was los ist — nichts davon darf als Fehlerspur im Browser landen.
 */
export async function readImport(name: string, data: ArrayBuffer): Promise<ImportResult> {
  const bytes = new Uint8Array(data);
  if (!bytes.length) throw new ImportError('Die Datei ist leer.');
  const format = formatOf(name, bytes);
  const text = format === 'kmz' ? await kmlFromKmz(bytes) : decodeText(bytes);

  const parsed =
    format === 'geojson'
      ? readGeoJson(text, name)
      : format === 'gpx'
        ? readGpx(parseXml(text), name)
        : readKml(parseXml(text), name);

  let thinned = 0;
  const lines = parsed.lines.slice(0, MAX_FEATURES).map((l) => {
    const fitted = fitLine(l.points);
    thinned += fitted.dropped;
    return { ...l, points: fitted.points };
  });
  const result: ImportResult = {
    source: name,
    format,
    lines,
    points: parsed.points.slice(0, MAX_FEATURES),
    areas: parsed.areas.slice(0, MAX_FEATURES),
    skipped:
      parsed.skipped +
      Math.max(0, parsed.lines.length - lines.length) +
      Math.max(0, parsed.points.length - MAX_FEATURES) +
      Math.max(0, parsed.areas.length - MAX_FEATURES),
    thinned,
    bbox: null,
  };
  result.bbox = boundsOf(result);
  return result;
}

/* ------------------------------------------------------------------ *
 * Übernahme in die Ablagen der App
 * ------------------------------------------------------------------ */

/** Eingelesene Linien als Spuren — dieselbe Ablage wie die eigene Aufzeichnung. */
export function tracksFrom(result: ImportResult): Track[] {
  return result.lines.map((l) => {
    const times = l.points.map((p) => p.t).filter((t) => t > 0);
    return {
      id: newTrackId(),
      name: l.name,
      points: l.points,
      distanceM: Math.round(trackLength(l.points)),
      // Ohne Zeitstempel bleibt beides 0 — die Anzeige lässt Dauer und Datum
      // dann weg, statt den 1.1.1970 zu behaupten.
      startedAt: times.length ? Math.min(...times) : 0,
      endedAt: times.length ? Math.max(...times) : 0,
      source: 'import' as const,
      origin: result.source,
    };
  });
}

/** Eingelesene Punkte und Flächen als eigene Markierungen. */
export function drawFrom(result: ImportResult): DrawFeature[] {
  const points: DrawFeature[] = result.points.map((p) => ({
    id: newId(),
    name: p.name,
    kind: 'point' as const,
    geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] as [number, number] },
  }));
  const areas: DrawFeature[] = result.areas.map((a) => {
    // Markierte Flächen sind in der App geschlossene Ringe.
    const ring = [...a.ring];
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    return {
      id: newId(),
      name: a.name,
      kind: 'area' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
    };
  });
  return [...points, ...areas];
}
