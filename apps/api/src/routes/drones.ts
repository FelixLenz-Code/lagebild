import { Hono } from 'hono';
import type { DroneZone } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { envelope } from '../lib/envelope.js';

/**
 * Drohnen-Zonen — die geografischen Gebiete nach § 21h LuftVO.
 *
 * Quelle ist die **Digitale Plattform Unbemannte Luftfahrt (dipul)** der DFS,
 * die ihre Gebiete als offene Geodienste bereitstellt (Datenlizenz Deutschland
 * Namensnennung 2.0). Es gibt beides, WFS und WMS — und die Wahl zwischen
 * beiden ist hier die eigentliche Entscheidung:
 *
 * **Gemessen** für einen Stadtausschnitt (0,2° × 0,4° um Bremen) liefert der
 * WFS über alle 30 Gebietsarten rund **5 MB**, allein die Bundesautobahnen
 * 2 MB und die Binnenwasserstraßen 1,2 MB — die Korridore sind als Flächen
 * mit sehr vielen Stützpunkten hinterlegt. Für eine Kartenebene ist das
 * unbrauchbar.
 *
 * Deshalb: **Bild vom WMS** (eine Kachel mit allen Gebieten, amtlich
 * eingefärbt, ~2 kB) und die **Sachdaten erst beim Antippen** über
 * `GetFeatureInfo`. Das beantwortet genau die Frage, mit der man die Ebene
 * einschaltet — „darf ich hier starten?" — und überträgt nie Geometrie.
 *
 * `GetFeatureInfo` gibt **kein JSON** heraus (`ForbiddenFormat`), erlaubt sind
 * nur `text/plain` und `text/html`. Der Klartext ist zeilenweise aufgebaut und
 * wird hier gelesen; das ist im Projekt das übliche Vorgehen (RSS, XML, PBF).
 */
export const dronesRoute = new Hono();

const WMS = process.env.DIPUL_WMS ?? 'https://uas-betrieb.de/geoservices/dipul/wms';

/**
 * Die Gebietsarten, die auf die Karte kommen — in der Reihenfolge, in der sie
 * gezeichnet werden. Bewusst ohne `inaktive_temporaere_betriebseinschraenkungen`
 * (abgelaufen) und ohne `haengegleiter` (Hinweis, kein Gebiet).
 */
const LAYERS = [
  'flugbeschraenkungsgebiete',
  'temporaere_betriebseinschraenkungen',
  'kontrollzonen',
  'flughaefen',
  'flugplaetze',
  'militaerische_anlagen',
  'nationalparks',
  'naturschutzgebiete',
  'vogelschutzgebiete',
  'ffh-gebiete',
  'bundesautobahnen',
  'bundesstrassen',
  'bahnanlagen',
  'binnenwasserstrassen',
  'seewasserstrassen',
  'schifffahrtsanlagen',
  'stromleitungen',
  'umspannwerke',
  'kraftwerke',
  'windkraftanlagen',
  'industrieanlagen',
  'behoerden',
  'sicherheitsbehoerden',
  'polizei',
  'justizvollzugsanstalten',
  'militaerische_anlagen',
  'krankenhaeuser',
  'labore',
  'diplomatische_vertretungen',
  'internationale_organisationen',
  'freibaeder',
].join(',');

/** Klartextnamen der Gebietsarten — der Dienst liefert nur die Kennung. */
const ART: Record<string, string> = {
  flugbeschraenkungsgebiete: 'Flugbeschränkungsgebiet (ED-R)',
  temporaere_betriebseinschraenkungen: 'Temporäre Betriebseinschränkung',
  kontrollzonen: 'Kontrollzone eines Flughafens',
  flughaefen: 'Flughafen',
  flugplaetze: 'Flugplatz',
  militaerische_anlagen: 'Militärische Anlage',
  nationalparks: 'Nationalpark',
  naturschutzgebiete: 'Naturschutzgebiet',
  vogelschutzgebiete: 'Vogelschutzgebiet',
  'ffh-gebiete': 'FFH-Gebiet',
  bundesautobahnen: 'Bundesautobahn',
  bundesstrassen: 'Bundesstraße',
  bahnanlagen: 'Bahnanlage',
  binnenwasserstrassen: 'Binnenwasserstraße',
  seewasserstrassen: 'Seewasserstraße',
  schifffahrtsanlagen: 'Schifffahrtsanlage',
  stromleitungen: 'Stromleitung',
  umspannwerke: 'Umspannwerk',
  kraftwerke: 'Kraftwerk',
  windkraftanlagen: 'Windkraftanlage',
  industrieanlagen: 'Industrieanlage',
  behoerden: 'Oberste Bundes- oder Landesbehörde',
  sicherheitsbehoerden: 'Sicherheitsbehörde',
  polizei: 'Polizei',
  justizvollzugsanstalten: 'Justizvollzugsanstalt',
  krankenhaeuser: 'Krankenhaus',
  labore: 'Labor',
  diplomatische_vertretungen: 'Diplomatische Vertretung',
  internationale_organisationen: 'Internationale Organisation',
  freibaeder: 'Freibad oder Badestrand',
};

/**
 * Grobe Einordnung für die Anzeige. **Keine Rechtsauskunft** — welche Regel im
 * Einzelfall gilt, hängt von Gewicht, Klasse, Betriebskategorie und
 * Erlaubnissen ab. Die Zeile sagt nur, warum das Gebiet überhaupt eingetragen
 * ist; verbindlich bleibt dipul.de.
 */
const GRUND: Record<string, string> = {
  flugbeschraenkungsgebiete: 'Gesperrt, außer mit Erlaubnis der zuständigen Stelle',
  temporaere_betriebseinschraenkungen: 'Zeitlich befristet gesperrt',
  kontrollzonen: 'Erlaubnis der Flugsicherung nötig',
  flughaefen: 'Erlaubnis der Flugsicherung nötig',
  flugplaetze: 'Erlaubnis des Betreibers nötig',
  militaerische_anlagen: 'Erlaubnis der Bundeswehr nötig',
  nationalparks: 'Aufstieg und Überflug in der Regel untersagt',
  naturschutzgebiete: 'Aufstieg und Überflug in der Regel untersagt',
  vogelschutzgebiete: 'Aufstieg und Überflug in der Regel untersagt',
  'ffh-gebiete': 'Aufstieg und Überflug in der Regel untersagt',
  bundesautobahnen: 'Seitlicher Abstand einzuhalten',
  bundesstrassen: 'Seitlicher Abstand einzuhalten',
  bahnanlagen: 'Seitlicher Abstand einzuhalten',
  binnenwasserstrassen: 'Seitlicher Abstand einzuhalten',
  seewasserstrassen: 'Seitlicher Abstand einzuhalten',
  schifffahrtsanlagen: 'Seitlicher Abstand einzuhalten',
  stromleitungen: 'Seitlicher Abstand einzuhalten',
  umspannwerke: 'Überflug nur mit Zustimmung des Betreibers',
  kraftwerke: 'Überflug nur mit Zustimmung des Betreibers',
  windkraftanlagen: 'Seitlicher Abstand einzuhalten',
  industrieanlagen: 'Überflug nur mit Zustimmung des Betreibers',
  behoerden: 'Überflug untersagt',
  sicherheitsbehoerden: 'Überflug untersagt',
  polizei: 'Überflug untersagt',
  justizvollzugsanstalten: 'Überflug untersagt',
  krankenhaeuser: 'Überflug untersagt',
  labore: 'Überflug untersagt',
  diplomatische_vertretungen: 'Überflug untersagt',
  internationale_organisationen: 'Überflug untersagt',
  freibaeder: 'Überflug nur mit Zustimmung',
};

/* ---------- Kacheln ---------- */

const R = 20037508.342789244;

/** Kachelrand in Web-Mercator-Metern. */
function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const m = (v: number) => -R + (2 * R * v) / n;
  return [m(x), -m(y + 1), m(x + 1), -m(y)];
}

/**
 *   GET /api/drones/{z}/{x}/{y}.png
 *
 * Eine Kachel mit allen Gebieten, gezeichnet vom Dienst selbst — damit sieht
 * die Ebene aus wie die amtliche Karte.
 */
dronesRoute.get('/:z/:x/:y', async (c) => {
  const z = Number(c.req.param('z'));
  const x = Number(c.req.param('x'));
  const y = Number(c.req.param('y').replace(/\.png$/, ''));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20) return c.body(null, 400);
  const n = 2 ** z;
  if (x < 0 || x >= n || y < 0 || y >= n) return c.body(null, 400);

  const [west, south, east, north] = tileBounds(z, x, y);
  const url =
    `${WMS}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(LAYERS)}` +
    `&styles=&crs=EPSG:3857&bbox=${west},${south},${east},${north}` +
    `&width=256&height=256&format=image/png&transparent=true`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return c.body(null, 502);
    const buf = await res.arrayBuffer();
    return c.body(buf, 200, {
      'content-type': 'image/png',
      // Die Gebiete ändern sich selten; die befristeten Einschränkungen sind
      // der einzige bewegliche Teil, und eine Stunde reicht dafür.
      'cache-control': 'public, max-age=3600',
    });
  } catch {
    return c.body(null, 502);
  }
});

/* ---------- Sachdaten an einem Punkt ---------- */

/**
 * Liest die Klartextantwort von `GetFeatureInfo`.
 *
 * Aufbau: je Gebietsart eine Überschrift `Results for FeatureType '…:name':`,
 * darunter durch Strichzeilen getrennte Blöcke aus `schlüssel = wert`.
 */
function parseFeatureInfo(text: string): DroneZone[] {
  const zones: DroneZone[] = [];
  let layer = '';
  let record: Record<string, string> = {};

  const flush = () => {
    if (!layer || Object.keys(record).length === 0) {
      record = {};
      return;
    }
    const name =
      record.generated_name_DE || record.name || record.generated_name_EN || ART[layer] || 'Gebiet';
    zones.push({
      kind: layer,
      art: ART[layer] ?? layer,
      name,
      lower: limit(record.lower_limit_altitude, record.lower_limit_unit, record.lower_limit_alt_ref),
      upper: limit(record.upper_limit_altitude, record.upper_limit_unit, record.upper_limit_alt_ref),
      legalRef: record.legal_ref?.trim() || null,
      note: GRUND[layer] ?? null,
    });
    record = {};
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^Results for FeatureType '(?:[^:']*:)?([^']+)'/.exec(line);
    if (head) {
      flush();
      layer = head[1]!;
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      flush();
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    // Die Geometrie steht als Platzhalter drin („[GEOMETRY (Polygon) …]") und
    // wird übergangen — genau deshalb wird hier GetFeatureInfo benutzt.
    if (kv && kv[1] !== 'geom' && kv[2]!.trim()) record[kv[1]!] = kv[2]!.trim();
  }
  flush();
  return zones;
}

/** „0 m AGL" bzw. „2500 ft MSL" — leer, wenn der Dienst nichts angibt. */
function limit(value?: string, unit?: string, ref?: string): string | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const parts = [`${Math.round(n)}${unit ? ` ${unit}` : ''}`];
  if (ref) parts.push(ref);
  return parts.join(' ');
}

/**
 *   GET /api/drones/info?lat&lon
 *
 * Welche Gebiete liegen unter diesem Punkt? Gefragt wird mit einem winzigen
 * Ausschnitt (rund 60 m) um die Stelle.
 */
dronesRoute.get('/info', async (c) => {
  const coords = readCoords(c);
  if (!coords) return c.json({ error: 'lat/lon erforderlich' }, 400);

  // Auf ~10 m runden: Nachbarklicks treffen denselben Cache.
  const key = `drones:${coords.lat.toFixed(4)}:${coords.lon.toFixed(4)}`;
  const cache = cached<DroneZone[]>(key, 900);
  if (cache.hit) return c.json(envelope(cache.hit, 'dipul (DFS)', true));

  const x = 6378137 * (coords.lon * (Math.PI / 180));
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + (coords.lat * (Math.PI / 180)) / 2));
  const d = 30;
  const url =
    `${WMS}?service=WMS&version=1.3.0&request=GetFeatureInfo` +
    `&layers=${encodeURIComponent(LAYERS)}&query_layers=${encodeURIComponent(LAYERS)}&styles=` +
    `&crs=EPSG:3857&bbox=${x - d},${y - d},${x + d},${y + d}` +
    `&width=101&height=101&i=50&j=50&info_format=text/plain&feature_count=40`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return c.json(envelope([] as DroneZone[], 'dipul (DFS)'));
    const zones = parseFeatureInfo(await res.text());
    cache.set(zones);
    return c.json(envelope(zones, 'dipul (DFS)'));
  } catch {
    return c.json(envelope([] as DroneZone[], 'dipul (DFS)'));
  }
});
