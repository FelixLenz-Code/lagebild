/**
 * Prüflauf für den Datei-Import (GPX/KML/KMZ/GeoJSON):
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-import.mts
 *
 * Der Leser in `apps/web/src/importFiles.ts` benutzt bewusst keine
 * DOM-Schnittstellen — deshalb läuft er hier unverändert unter Node. Die
 * Beispiele decken die Eigenheiten ab, an denen fremde Dateien in der Praxis
 * scheitern: Namensräume, CDATA, Entitäten, ISO-8859-1, mehrere Abschnitte,
 * gx:Track, MultiGeometry und gepackte KMZ.
 */

import { deflateRawSync } from 'node:zlib';
import { ImportError, drawFrom, readImport, tracksFrom } from '../apps/web/src/importFiles.js';
import { toGpx, type Track } from '../apps/web/src/trackStore.js';

let failed = 0;

function check(what: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FEHL ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

const buf = (s: string, encoding: BufferEncoding = 'utf8'): ArrayBuffer => {
  const b = Buffer.from(s, encoding);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/* ------------------------------------------------------------------ *
 * GPX
 * ------------------------------------------------------------------ */

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Komoot" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Tour</name></metadata>
  <wpt lat="53.0793" lon="8.8017">
    <ele>12.5</ele><name>Bremen Hbf</name><desc>Treffpunkt &amp; Start</desc>
  </wpt>
  <wpt lat="200" lon="8.8"><name>kaputt</name></wpt>
  <rte><name>Zufahrt</name>
    <rtept lat="53.07" lon="8.80"/><rtept lat="53.08" lon="8.81"/>
  </rte>
  <trk>
    <name>Weserdeich</name>
    <trkseg>
      <trkpt lat="53.0700" lon="8.8000"><ele>4</ele><time>2026-08-02T09:00:00Z</time></trkpt>
      <trkpt lat="53.0710" lon="8.8020"><ele>5</ele><time>2026-08-02T09:02:00Z</time></trkpt>
      <trkpt lat="53.0720" lon="8.8040"><time>2026-08-02T09:04:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="53.0800" lon="8.8200"/><trkpt lat="53.0810" lon="8.8220"/>
    </trkseg>
  </trk>
</gpx>`;

console.log('\nGPX');
{
  const r = await readImport('tour.gpx', buf(GPX));
  check('Format erkannt', r.format === 'gpx');
  check('zwei Abschnitte bleiben getrennt', r.lines.length === 3, `${r.lines.length} Linien (2 Segmente + 1 Route)`);
  check('Abschnitte durchnummeriert', r.lines[0]!.name === 'Weserdeich (1)' && r.lines[1]!.name === 'Weserdeich (2)');
  check('Route übernommen', r.lines[2]!.name === 'Zufahrt');
  check('Wegpunkt gelesen', r.points.length === 1 && r.points[0]!.name === 'Bremen Hbf');
  check('Entität aufgelöst', r.points[0]!.note === 'Treffpunkt & Start');
  check('Höhe gelesen', r.points[0]!.ele === 12.5);
  check('unmögliche Koordinate verworfen', r.skipped === 1, `skipped=${r.skipped}`);
  check('Zeitstempel gelesen', r.lines[0]!.points[0]!.t === Date.parse('2026-08-02T09:00:00Z'));
  check('Punkte ohne Zeit bekommen 0', r.lines[1]!.points[0]!.t === 0);
  check(
    'Rechteck stimmt',
    !!r.bbox && near(r.bbox[0], 8.8) && near(r.bbox[3], 53.081),
    r.bbox?.map((n) => n.toFixed(4)).join(', '),
  );

  const tracks = tracksFrom(r);
  check('Spur mit Zeit trägt Datum', tracks[0]!.startedAt > 0);
  check('Spur ohne Zeit bleibt bei 0', tracks[1]!.startedAt === 0);
  check('Länge gerechnet', tracks[0]!.distanceM > 150 && tracks[0]!.distanceM < 400, `${tracks[0]!.distanceM} m`);
  check('Herkunft vermerkt', tracks[0]!.source === 'import' && tracks[0]!.origin === 'tour.gpx');
}

/* Der eigene Export muss wieder hereinkommen (Rundlauf). */
console.log('\nEigener GPX-Export');
{
  const track: Track = {
    id: 'x',
    name: 'Spur mit "Anführung" & Co',
    points: [
      { lat: 53.07, lon: 8.8, t: 1_754_000_000_000, ele: 3 },
      { lat: 53.0705, lon: 8.8009, t: 1_754_000_060_000 },
    ],
    distanceM: 80,
    startedAt: 1_754_000_000_000,
    endedAt: 1_754_000_060_000,
  };
  const r = await readImport('export.gpx', buf(toGpx(track)));
  check('eine Spur zurück', r.lines.length === 1 && r.lines[0]!.points.length === 2);
  check('Name unverfälscht', r.lines[0]!.name === track.name, r.lines[0]!.name);
  check('Zeit erhalten', r.lines[0]!.points[0]!.t === track.startedAt);

  // Spur ohne Zeitstempel: der Export darf keinen 1.1.1970 behaupten.
  const noTime: Track = { ...track, points: track.points.map((p) => ({ ...p, t: 0 })), startedAt: 0, endedAt: 0 };
  check('Export ohne Zeit lässt <time> weg', !toGpx(noTime).includes('1970'));
}

/* ------------------------------------------------------------------ *
 * KML
 * ------------------------------------------------------------------ */

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
 <kml:Document>
  <kml:name>Sammlung</kml:name>
  <kml:Folder>
   <kml:Placemark>
    <kml:name>Standort</kml:name>
    <kml:description><![CDATA[<b>Halle 3</b> — Zugang über die <i>Nordseite</i>]]></kml:description>
    <kml:Point><kml:coordinates>8.8017,53.0793,12</kml:coordinates></kml:Point>
   </kml:Placemark>
   <kml:Placemark>
    <kml:name>Zufahrt und Sperrkreis</kml:name>
    <kml:MultiGeometry>
     <kml:LineString><kml:coordinates>
        8.80,53.07,0
        8.81,53.08,0
        8.82,53.09,0
     </kml:coordinates></kml:LineString>
     <kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>
        8.79,53.06 8.83,53.06 8.83,53.10 8.79,53.10 8.79,53.06
     </kml:coordinates></kml:LinearRing></kml:outerBoundaryIs>
     <kml:innerBoundaryIs><kml:LinearRing><kml:coordinates>8.80,53.07 8.81,53.07 8.81,53.08 8.80,53.07</kml:coordinates></kml:LinearRing></kml:innerBoundaryIs>
     </kml:Polygon>
    </kml:MultiGeometry>
   </kml:Placemark>
   <kml:Placemark><kml:name>Aufzeichnung</kml:name>
    <gx:Track>
      <kml:when>2026-08-02T10:00:00Z</kml:when>
      <kml:when>2026-08-02T10:01:00Z</kml:when>
      <gx:coord>8.800 53.070 10</gx:coord>
      <gx:coord>8.802 53.071 12</gx:coord>
    </gx:Track>
   </kml:Placemark>
   <kml:Placemark><kml:name>Bildüberlagerung</kml:name><kml:Style/></kml:Placemark>
  </kml:Folder>
 </kml:Document>
</kml:kml>`;

console.log('\nKML');
{
  const r = await readImport('sammlung.kml', buf(KML));
  check('Format erkannt', r.format === 'kml');
  check('Namensräume abgestreift', r.points.length === 1, `${r.points.length} Punkte`);
  check('CDATA und HTML zu Klartext', r.points[0]!.note === 'Halle 3 — Zugang über die Nordseite', r.points[0]!.note);
  check('Höhe aus dem dritten Wert', r.points[0]!.ele === 12);
  check('MultiGeometry: Linie und Fläche', r.lines.length === 2 && r.areas.length === 1);
  check('nur der äußere Ring', r.areas[0]!.ring.length === 5, `${r.areas[0]!.ring.length} Stützpunkte`);
  check('gx:Track gelesen', r.lines.some((l) => l.name === 'Aufzeichnung'));
  const gxTrack = r.lines.find((l) => l.name === 'Aufzeichnung')!;
  check('gx:Track hat Zeit aus <when>', gxTrack.points[1]!.t === Date.parse('2026-08-02T10:01:00Z'));
  check('gx:Track Reihenfolge lon/lat', near(gxTrack.points[0]!.lat, 53.07) && near(gxTrack.points[0]!.lon, 8.8));
  check('Placemark ohne Geometrie übergangen', r.skipped === 1, `skipped=${r.skipped}`);

  const draw = drawFrom(r);
  check('Markierungen erzeugt', draw.length === 2 && draw[0]!.kind === 'point' && draw[1]!.kind === 'area');
  const ring = (draw[1]!.geometry as { coordinates: [number, number][][] }).coordinates[0]!;
  check('Ring bleibt geschlossen', ring[0]![0] === ring[ring.length - 1]![0]);
}

/* Umlaute aus alten Werkzeugen. */
console.log('\nZeichensatz');
{
  const latin = `<?xml version="1.0" encoding="ISO-8859-1"?><gpx version="1.1"><wpt lat="48.1" lon="11.6"><name>Grünanlage Höhe Süd</name></wpt></gpx>`;
  const r = await readImport('alt.gpx', buf(latin, 'latin1'));
  check('ISO-8859-1 richtig entziffert', r.points[0]!.name === 'Grünanlage Höhe Süd', r.points[0]!.name);
}

/* ------------------------------------------------------------------ *
 * KMZ — ZIP mit doc.kml
 * ------------------------------------------------------------------ */

/** Minimaler ZIP-Schreiber, nur für diesen Prüflauf. */
function makeZip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

console.log('\nKMZ');
{
  const zip = makeZip([
    // Eine Beigabe vor der KML — der Leser muss den richtigen Eintrag finden.
    { name: 'images/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), deflate: false },
    { name: 'files/andere.kml', data: Buffer.from('<kml/>', 'utf8'), deflate: true },
    { name: 'doc.kml', data: Buffer.from(KML, 'utf8'), deflate: true },
  ]);
  const r = await readImport('tour.kmz', zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) as ArrayBuffer);
  check('doc.kml gefunden und entpackt', r.format === 'kmz' && r.points.length === 1 && r.lines.length === 2);

  // Auch ungepackt gespeicherte KMZ kommen vor.
  const stored = makeZip([{ name: 'doc.kml', data: Buffer.from(KML, 'utf8'), deflate: false }]);
  const r2 = await readImport(
    'gespeichert.kmz',
    stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.length) as ArrayBuffer,
  );
  check('ungepackter Eintrag gelesen', r2.points.length === 1);

  // Endung .kml, Inhalt aber ZIP — kommt beim Umbenennen vor.
  const r3 = await readImport('falschbenannt.kml', zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) as ArrayBuffer);
  check('ZIP-Kennung schlägt die Endung', r3.format === 'kmz');
}

/* ------------------------------------------------------------------ *
 * GeoJSON
 * ------------------------------------------------------------------ */

console.log('\nGeoJSON');
{
  const geo = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'Sammelplatz' }, geometry: { type: 'Point', coordinates: [8.8, 53.07] } },
      {
        type: 'Feature',
        properties: { title: 'Anfahrt' },
        geometry: { type: 'MultiLineString', coordinates: [[[8.8, 53.07], [8.81, 53.08]], [[8.82, 53.09], [8.83, 53.1]]] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [[[8.79, 53.06], [8.83, 53.06], [8.83, 53.1], [8.79, 53.06]]] },
      },
      { type: 'Feature', properties: { name: 'ohne' }, geometry: null },
    ],
  });
  const r = await readImport('lage.geojson', buf(geo));
  check('Format erkannt', r.format === 'geojson');
  check('Punkt, zwei Linien, eine Fläche', r.points.length === 1 && r.lines.length === 2 && r.areas.length === 1);
  check('Name aus title', r.lines[0]!.name === 'Anfahrt');
  check('leere Geometrie übergangen', r.skipped === 1);
}

/* ------------------------------------------------------------------ *
 * Große Dateien und Fehlerfälle
 * ------------------------------------------------------------------ */

console.log('\nAusdünnen');
{
  // 30.000 Punkte auf einem mäandernden Weg mit Ortungsrauschen — so sieht
  // eine Aufzeichnung mit einem Punkt je Sekunde wirklich aus. Eine gerade
  // Linie wäre kein Prüfstein: die ließe sich immer auf zwei Punkte kürzen.
  const original: { lat: number; lon: number }[] = [];
  for (let i = 0; i < 30_000; i++) {
    const along = i / 30_000; // 0 … 1 entspricht rund 33 km
    original.push({
      lat: 53 + along * 0.3 + Math.sin(along * 120) * 0.004 + Math.sin(i * 1.7) * 0.00003,
      lon: 8.8 + along * 0.3 + Math.cos(along * 90) * 0.005 + Math.cos(i * 2.3) * 0.00003,
    });
  }
  const big =
    `<gpx version="1.1"><trk><name>Lang</name><trkseg>` +
    original.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"/>`).join('') +
    `</trkseg></trk></gpx>`;
  const t0 = Date.now();
  const r = await readImport('lang.gpx', buf(big));
  const line = r.lines[0]!;
  check('unter der Obergrenze', line.points.length <= 4000, `${line.points.length} von 30.000`);
  check('Anfang und Ende erhalten', near(line.points[0]!.lat, original[0]!.lat) &&
    near(line.points[line.points.length - 1]!.lat, original[29_999]!.lat));
  check('gemeldet, wie viel wegfiel', r.thinned === 30_000 - line.points.length);
  check('schnell genug', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);

  // Entscheidend ist nicht die Zahl der Punkte, sondern ob der Verlauf
  // derselbe bleibt: größter Abstand eines Originalpunktes zur gekürzten
  // Linie, in Metern.
  const mx = 111320 * Math.cos((53.15 * Math.PI) / 180);
  const my = 110540;
  const seg = line.points.map((p) => [p.lon * mx, p.lat * my] as const);
  let worst = 0;
  for (let i = 0; i < original.length; i += 10) {
    const px = original[i]!.lon * mx;
    const py = original[i]!.lat * my;
    let best = Infinity;
    for (let s = 1; s < seg.length; s++) {
      const [ax, ay] = seg[s - 1]!;
      const [bx, by] = seg[s]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const ox = px - (ax + t * dx);
      const oy = py - (ay + t * dy);
      const d2 = ox * ox + oy * oy;
      if (d2 < best) best = d2;
    }
    worst = Math.max(worst, Math.sqrt(best));
  }
  // Die Schranke ist die zuletzt benutzte Toleranz (hier 8 m, weil 4 m das
  // Ortungsrauschen nicht wegbekommt und die Zahl der Punkte zu hoch bliebe).
  check('Verlauf bleibt erhalten', worst <= 8, `größte Abweichung ${worst.toFixed(1)} m`);
}

console.log('\nFehlerfälle');
for (const [name, data, erwartet] of [
  ['leer.gpx', '', 'Die Datei ist leer.'],
  ['text.gpx', 'einfach nur Text', '<gpx>'],
  ['leer2.gpx', '<gpx version="1.1"></gpx>', 'keine verwertbare Spur'],
  ['kaputt.geojson', '{ "type": ', 'gültiges GeoJSON'],
  ['unbekannt.dat', 'irgendwas', 'Unbekanntes Format'],
] as const) {
  let message = '';
  try {
    await readImport(name, buf(data));
  } catch (e) {
    message = e instanceof ImportError ? e.message : `falsche Fehlerart: ${String(e)}`;
  }
  check(`${name} meldet den Grund`, message.includes(erwartet), message || 'kein Fehler geworfen');
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen\n` : '\nAlle Prüfungen bestanden\n');
process.exit(failed ? 1 : 0);
