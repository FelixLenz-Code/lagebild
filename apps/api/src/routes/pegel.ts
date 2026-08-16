import { Hono } from 'hono';
import type { WaterLevel, WaterLevelHistory, WaterLevelPoint, Coords } from '@lagebild/shared';
import { readCoords, readBbox, inBbox, bboxCenter } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { distanceKm } from '../lib/distance.js';

/**
 * Pegelstände aus PEGELONLINE (WSV) — nächstgelegene Messstellen inkl.
 * aktuellem Wert und Trend.
 * https://www.pegelonline.wsv.de/webservices/rest-api/v2/
 */
export const pegelRoute = new Hono();

interface RawCharacteristicValue {
  shortname?: string;
  longname?: string;
  value?: number;
}

interface RawTimeseries {
  shortname?: string;
  unit?: string;
  currentMeasurement?: { value?: number; timestamp?: string };
  characteristicValues?: RawCharacteristicValue[];
}

interface RawStation {
  uuid?: string;
  shortname?: string;
  longname?: string;
  longitude?: number;
  latitude?: number;
  water?: { longname?: string; shortname?: string };
  timeseries?: RawTimeseries[];
}

const PO_BASE = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json';
function stationsUrl(center: Coords, radiusKm: number): string {
  return (
    `${PO_BASE}?latitude=${center.lat}&longitude=${center.lon}&radius=${radiusKm}` +
    `&includeTimeseries=true&includeCurrentMeasurement=true&includeCharacteristicValues=true`
  );
}

/**
 * Einstufung des Wasserstands.
 *
 * **Warum nicht die amtlichen Meldestufen der Länder?** Die gibt es nur je
 * Bundesland und je Pegel, und das Länderübergreifende Hochwasserportal (LHP)
 * beantwortet seine Webservices von außen mit leerem Rumpf — darauf lässt sich
 * nichts bauen. PEGELONLINE liefert dagegen zu jeder Messstelle die **amtlichen
 * Kennwerte** der WSV mit (MNW, MW, MHW, HHW, an vielen Pegeln zusätzlich die
 * Meldemarken M I und M II sowie den höchsten Schifffahrtswasserstand HSW).
 * Daraus lässt sich bundesweit einheitlich einordnen, wo der Pegel gerade
 * steht — und die Schwellen stehen als Zahlen daneben, sodass die Einstufung
 * nachprüfbar bleibt.
 *
 * An **Tidepegeln** gibt es kein MHW; dort gilt die übliche Staffelung über dem
 * mittleren Tidehochwasser: ab 1,5 m Sturmflut, ab 2,5 m schwere, ab 3,5 m sehr
 * schwere Sturmflut.
 */
function classify(
  value: number | null,
  marks: Record<string, number>,
): { stage: WaterLevel['stage']; stageNote: string | null } {
  if (value == null) return { stage: null, stageNote: null };
  const cm = (n: number) => `${Math.round(n)} cm`;

  // Tidepegel: MThw/MTnw statt MW/MHW.
  const mthw = marks.MThw;
  if (mthw != null) {
    if (value >= mthw + 350) return { stage: 'severe', stageNote: `mehr als 3,5 m über MThw (${cm(mthw)})` };
    if (value >= mthw + 250) return { stage: 'flood', stageNote: `schwere Sturmflut: über 2,5 m über MThw (${cm(mthw)})` };
    if (value >= mthw + 150) return { stage: 'raised', stageNote: `Sturmflut: über 1,5 m über MThw (${cm(mthw)})` };
    if (marks.MTnw != null && value < marks.MTnw) return { stage: 'low', stageNote: `unter mittlerem Tideniedrigwasser (${cm(marks.MTnw)})` };
    return { stage: 'normal', stageNote: `im Tidebereich (MThw ${cm(mthw)})` };
  }

  if (marks.HHW != null && value >= marks.HHW) {
    return { stage: 'severe', stageNote: `über dem höchsten bekannten Wert (${cm(marks.HHW)})` };
  }
  // Meldemarke II bzw. der höchste Schifffahrtswasserstand — was zuerst zutrifft.
  const hoch = marks.M_II ?? marks.HSW;
  if (hoch != null && value >= hoch) {
    return { stage: 'flood', stageNote: `über ${marks.M_II != null ? 'Marke II' : 'HSW'} (${cm(hoch)})` };
  }
  if (marks.M_I != null && value >= marks.M_I) {
    return { stage: 'flood', stageNote: `über Marke I (${cm(marks.M_I)})` };
  }
  if (marks.MHW != null && value >= marks.MHW) {
    return { stage: 'flood', stageNote: `über mittlerem Hochwasser (${cm(marks.MHW)})` };
  }
  if (marks.MW != null && value >= marks.MW) {
    return { stage: 'raised', stageNote: `über Mittelwasser (${cm(marks.MW)})` };
  }
  if (marks.MNW != null && value < marks.MNW) {
    return { stage: 'low', stageNote: `unter mittlerem Niedrigwasser (${cm(marks.MNW)})` };
  }
  if (marks.MW != null || marks.MNW != null) return { stage: 'normal', stageNote: null };
  return { stage: null, stageNote: null };
}

/** Die Kennwerte, die für die Einstufung und das Popup gebraucht werden. */
const KENNWERTE = ['MNW', 'MW', 'MHW', 'HHW', 'NNW', 'M_I', 'M_II', 'HSW', 'MThw', 'MTnw', 'HThw'];

function toLevel(s: RawStation): WaterLevel {
  // Zeitreihe "W" = Wasserstand (in cm)
  const w = (s.timeseries ?? []).find((t) => t.shortname === 'W');
  const marks: Record<string, number> = {};
  for (const cv of w?.characteristicValues ?? []) {
    const name = cv.shortname?.trim();
    if (name && KENNWERTE.includes(name) && Number.isFinite(cv.value)) marks[name] = cv.value as number;
  }
  const levelCm = w?.currentMeasurement?.value ?? null;
  const { stage, stageNote } = classify(levelCm, marks);
  return {
    id: s.uuid,
    station: s.shortname ?? s.longname ?? 'Pegel',
    water: s.water?.longname ?? s.water?.shortname ?? '',
    levelCm,
    trend: null,
    measuredAt: w?.currentMeasurement?.timestamp ?? null,
    coordinates: { lat: s.latitude as number, lon: s.longitude as number },
    stage,
    stageNote,
    marks,
  };
}

const hasCoords = (s: RawStation) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude);

pegelRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  const coords = readCoords(c);
  if (!bbox && !coords) return c.json({ error: 'bbox oder lat/lon erforderlich' }, 400);

  // Kartenausschnitt: Mittelpunkt + Radius (halbe Diagonale) abfragen, dann filtern.
  if (bbox) {
    const center = bboxCenter(bbox);
    const radiusKm = Math.min(Math.max(distanceKm(center, { lat: bbox.north, lon: bbox.east }), 5), 320);
    const key = `pegel:bbox:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
    const cache = cached<WaterLevel[]>(key);
    if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

    const stations = await fetchJson<RawStation[]>(stationsUrl(center, radiusKm), { timeoutMs: 12000 });
    const levels = stations
      .filter(hasCoords)
      .map(toLevel)
      .filter((l) => inBbox(l.coordinates!, bbox))
      .sort((a, b) => distanceKm(center, a.coordinates!) - distanceKm(center, b.coordinates!))
      .slice(0, 150);
    cache.set(levels);
    return c.json(envelope(levels, 'PEGELONLINE (WSV)'));
  }

  // Fallback: Umkreis um einen Punkt.
  const radiusKm = Math.min(Number(c.req.query('radiusKm') ?? 40) || 40, 150);
  const key = `pegel:${coords!.lat.toFixed(2)}:${coords!.lon.toFixed(2)}:${radiusKm}`;
  const cache = cached<WaterLevel[]>(key);
  if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

  const stations = await fetchJson<RawStation[]>(stationsUrl(coords!, radiusKm));
  const levels = stations
    .filter(hasCoords)
    .map(toLevel)
    .sort((a, b) => distanceKm(coords!, a.coordinates!) - distanceKm(coords!, b.coordinates!))
    .slice(0, 8);
  cache.set(levels);
  return c.json(envelope(levels, 'PEGELONLINE (WSV)'));
});

/**
 * Verlauf einer Messstelle. PEGELONLINE liefert Minutenwerte (7 Tage sind über
 * 10.000 Punkte) — hier wird auf gut 120 Stützpunkte ausgedünnt, das reicht für
 * die Kurve im Popup und hält die Antwort klein.
 */
pegelRoute.get('/history', async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!/^[0-9a-f-]{20,40}$/i.test(id)) return c.json({ error: 'id erforderlich' }, 400);
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 3) || 3, 1), 14);

  const key = `pegel-hist:${id}:${days}`;
  const cache = cached<WaterLevelHistory>(key, 600);
  if (cache.hit) return c.json(envelope(cache.hit, 'PEGELONLINE (WSV)', true));

  const raw = await fetchJson<{ timestamp?: string; value?: number }[]>(
    `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/${encodeURIComponent(id)}/W/measurements.json?start=P${days}D`,
    { timeoutMs: 15000 },
  );
  const all = raw.filter((m) => m.timestamp && Number.isFinite(m.value)) as { timestamp: string; value: number }[];
  if (!all.length) {
    return c.json(envelope({ points: [], minCm: 0, maxCm: 0, change3hCm: null, trend: null }, 'PEGELONLINE (WSV)'));
  }

  const step = Math.max(1, Math.ceil(all.length / 120));
  const points: WaterLevelPoint[] = [];
  for (let i = 0; i < all.length; i += step) points.push({ t: all[i]!.timestamp, v: all[i]!.value });
  // Der letzte Messwert soll immer dabei sein — er steht im Popup als Zahl.
  const last = all[all.length - 1]!;
  if (points[points.length - 1]?.t !== last.timestamp) points.push({ t: last.timestamp, v: last.value });

  const values = all.map((m) => m.value);
  // Vergleichswert von vor drei Stunden für den Trend.
  const threeHoursAgo = new Date(last.timestamp).getTime() - 3 * 3600_000;
  const past = all.find((m) => new Date(m.timestamp).getTime() >= threeHoursAgo);
  const change = past ? Math.round(last.value - past.value) : null;

  const history: WaterLevelHistory = {
    points,
    minCm: Math.min(...values),
    maxCm: Math.max(...values),
    change3hCm: change,
    trend: change == null ? null : change > 2 ? 'rising' : change < -2 ? 'falling' : 'steady',
  };
  cache.set(history);
  return c.json(envelope(history, 'PEGELONLINE (WSV)'));
});
