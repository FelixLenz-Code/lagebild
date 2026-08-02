import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type Map as MlMap,
  type Marker,
  type Popup as MlPopup,
  type FilterSpecification,
  type GeoJSONSource,
  type ImageSource,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {
  Coords,
  TrafficIncident,
  WaterLevel,
  WarningFeature,
  Severity,
  RadarData,
  RadarForecast,
  Aircraft,
  AircraftDetails,
  Airport,
  Vessel,
  AprsStation,
  WindPoint,
  WindField,
  WaterLevelHistory,
  NewsItem,
  GeoResult,
  TransitVehicle,
  EarthquakeItem,
  LightningStrike,
  CivilWarning,
  FireDetection,
  RadiationStation,
  RestFacility,
  WebcamSpot,
  GeoJsonGeometry,
  AuroraGrid,
  FireDangerGrid,
  HfMufGrid,
  RouteResult,
  TransitItinerary,
  TransitStopPoint,
} from '@lagebild/shared';
import { fetchAircraftDetails, fetchPegelHistory, type Bbox } from './api.js';
import { registerPmtiles, buildStyle, addLocalPmtiles, ONLINE_PMTILES_URL } from './mapStyle.js';
import { getOfflineFile } from './offlineMaps.js';
import { DrawList } from './DrawList.js';
import { NamePrompt } from './NamePrompt.js';
import { loadDraw, saveDraw, newId, type DrawFeature, type DrawGeometry } from './drawStore.js';
import { inflateGrid, gridToDataUrl, radarSupported, RADAR_LEGEND } from './radarGrid.js';
import { mufToDataUrl, MUF_BOUNDS, MUF_SCALE } from './mufGrid.js';
import {
  ensureMapIcons,
  EMERGENCY_ICON,
  NEWS_STYLE,
  STOP_COLOR,
  STOP_ICON,
  WIND_CLASSES,
} from './mapIcons.js';
import {
  auroraToDataUrl,
  AURORA_BOUNDS,
  fireToDataUrl,
  fireBounds,
  FIRE_LEVELS,
} from './hazardGrids.js';
import { WindAnimation } from './windField.js';
import { shadowPolygon, CIVIL_TWILIGHT } from './sun.js';
import { AprsTargets } from './AprsTargets.js';
import { loadTargets, saveTargets } from './aprsStore.js';
import { LayerMenu, type LayerOption } from './LayerMenu.js';
import { LAYER_CATALOG, type LayerId, type LayerRowId } from './layerCatalog.js';
import {
  kindOfProduct,
  SEVERITY_DE,
  TRAFFIC_DE,
  VESSEL_DE,
  VESSEL_STATUS_DE,
  APRS_KIND_DE,
  formatDateTime,
  radarTimeLabel,
  relativeTime,
  timeHM,
} from './format.js';

const DRAW_COLOR = '#0d9488';
/** Farbe der Routenlinie (kräftig genug, um über allen Ebenen zu tragen). */
const ROUTE_COLOR = '#2f7fd1';
type DrawMode = 'off' | 'point' | 'area';

/** Frisch gezeichnete Markierung, die noch auf ihren Namen wartet. */
interface PendingDraw {
  kind: 'point' | 'area';
  geometry: DrawGeometry;
  defaultName: string;
}

/** Ein Zeitschritt der Radar-Zeitleiste (Quelle-unabhängig). */
interface TimelineFrame {
  timeSec: number;
  forecast: boolean;
}

function drawToGeoJson(features: DrawFeature[], areaVertices: [number, number][]): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = features.map((d) => ({
    type: 'Feature',
    properties: { kind: d.kind, name: d.name },
    geometry: d.geometry,
  }));
  if (areaVertices.length >= 2) {
    out.push({ type: 'Feature', properties: { kind: 'progress' }, geometry: { type: 'LineString', coordinates: areaVertices } });
  }
  for (const v of areaVertices) {
    out.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: v } });
  }
  return { type: 'FeatureCollection', features: out };
}

/** Kachel-URL eines RainViewer-Radar-Frames (Farbschema 4, geglättet). */
function radarTileUrl(host: string, path: string): string {
  return `${host}${path}/256/{z}/{x}/{y}/4/1_1.png`;
}

const SEVERITY_COLOR: Record<Severity, string> = {
  minor: '#b58a10',
  moderate: '#c96f0f',
  severe: '#a92318',
  extreme: '#6c2790',
};

function warningsToGeoJson(features: WarningFeature[]) {
  return {
    type: 'FeatureCollection' as const,
    features: features.map((f) => ({
      type: 'Feature' as const,
      properties: { id: f.id, severity: f.severity, color: SEVERITY_COLOR[f.severity] },
      geometry: f.geometry,
    })),
  };
}

const ALL_SEVERITIES: Severity[] = ['minor', 'moderate', 'severe', 'extreme'];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function trafficPopupHtml(t: TrafficIncident): string {
  const color = t.kind === 'closure' ? '#a92318' : t.kind === 'jam' ? '#c96f0f' : '#b58a10';
  return (
    `<div class="warn-popup">` +
    `<span class="wp-sev" style="background:${color}">${esc(TRAFFIC_DE[t.kind] ?? t.kind)}</span>` +
    `<b>${esc(t.title)}</b>` +
    (t.startsAt ? `<div class="wp-meta">seit ${esc(formatDateTime(t.startsAt))}</div>` : '') +
    (t.description ? `<p class="wp-desc">${esc(t.description)}</p>` : '') +
    `</div>`
  );
}

/** Verlaufskurve als SVG — die Popups sind reines HTML, also wird sie gezeichnet. */
function pegelSparkline(h: WaterLevelHistory): string {
  const W = 276;
  const H = 62;
  const pad = 5;
  const pts = h.points;
  if (pts.length < 2) return '';
  const span = Math.max(1, h.maxCm - h.minCm);
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - h.minCm) / span) * (H - 2 * pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const lastX = x(pts.length - 1).toFixed(1);
  const lastY = y(pts[pts.length - 1]!.v).toFixed(1);
  return (
    `<svg class="pg-spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-hidden="true">` +
    `<path d="${area}" fill="rgba(29,78,115,.14)"/>` +
    `<path d="${line}" fill="none" stroke="#1d4e73" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${lastX}" cy="${lastY}" r="3" fill="#1d4e73"/>` +
    `</svg>`
  );
}

const TREND_ARROW: Record<string, string> = { rising: '▲', falling: '▼', steady: '▬' };

/**
 * Popup einer Messstelle. Der Verlauf wird beim Öffnen nachgeladen — solange
 * steht dort ein Hinweis statt einer leeren Fläche.
 */
function pegelPopupHtml(p: WaterLevel, history?: WaterLevelHistory | null, loading = false): string {
  const rows = [row('Gewässer', p.water || null), row('Wasserstand', p.levelCm != null ? `${p.levelCm} cm` : null)];
  let trendLine = '';
  if (history?.change3hCm != null && history.trend) {
    const sign = history.change3hCm > 0 ? '+' : '';
    trendLine =
      `<div class="pg-trend ${history.trend}">${TREND_ARROW[history.trend] ?? ''} ` +
      `${sign}${history.change3hCm} cm in 3 h</div>`;
  }

  let chart = '';
  if (loading) {
    chart = '<div class="pg-note">Verlauf wird geladen …</div>';
  } else if (history && history.points.length > 1) {
    const first = history.points[0]!;
    const last = history.points[history.points.length - 1]!;
    // Zeitachse und Spannweite in eigene Zeilen — nebeneinander wird es zu eng.
    chart =
      pegelSparkline(history) +
      `<div class="pg-axis"><span>${formatDateTime(first.t)}</span><span>${timeHM(last.t)}</span></div>` +
      `<div class="pg-range">Spanne ${Math.round(history.minCm)}–${Math.round(history.maxCm)} cm</div>`;
  } else if (history) {
    chart = '<div class="pg-note">Kein Verlauf verfügbar.</div>';
  }

  return (
    `<div class="warn-popup pegel-popup"><h4>${esc(p.station)}</h4>` +
    `<div class="wp-rows">${rows.join('')}</div>` +
    trendLine +
    chart +
    (p.measuredAt ? `<div class="wp-time">Messung ${formatDateTime(p.measuredAt)}</div>` : '') +
    `</div>`
  );
}

/** Popup einer Meldung: Schlagzeile, Ressort, Zeitpunkt und Link. */
function newsPopupHtml(item: NewsItem): string {
  const place = item.place;
  return (
    `<div class="warn-popup news-popup">` +
    `<h4>${esc(item.title)}</h4>` +
    (item.summary ? `<p class="wp-desc">${esc(item.summary)}</p>` : '') +
    `<div class="wp-meta">${esc(NEWS_STYLE[item.category ?? 'other']?.label ?? 'Nachricht')}` +
    (item.topic ? ` · ${esc(item.topic)}` : '') +
    (item.publishedAt ? ` · ${esc(relativeTime(item.publishedAt))}` : '') +
    (place ? ` · ${esc(place.name)}${place.approximate ? ' (ungenau)' : ''}` : '') +
    `</div>` +
    `<a class="wp-link" href="${esc(item.url)}" target="_blank" rel="noreferrer">Zur Meldung</a>` +
    `</div>`
  );
}

/** Mittelpunkt einer Geometrie (Schwerpunkt der Stützpunkte, genügt hier). */
function geometryCenter(geometry: GeoJsonGeometry): [number, number] | null {
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumLon += node[0] as number;
      sumLat += node[1] as number;
      count++;
      return;
    }
    for (const child of node) visit(child);
  };
  visit((geometry as { coordinates?: unknown }).coordinates);
  return count ? [sumLon / count, sumLat / count] : null;
}

/** Popup einer Behördenwarnung: Stufe, Herkunft, Text und Handlungshinweis. */
function civilWarningPopupHtml(w: CivilWarning): string {
  const validity = w.expires
    ? `gültig bis ${formatDateTime(w.expires)}`
    : w.onset
      ? `seit ${relativeTime(w.onset)}`
      : '';
  return (
    `<div class="warn-popup">` +
    `<span class="wp-sev" style="background:${SEVERITY_COLOR[w.severity]}">${esc(SEVERITY_DE[w.severity])}</span>` +
    `<b>${esc(w.headline)}</b>` +
    `<div class="wp-region">${esc(w.channel)}${w.areaDesc ? ` · ${esc(w.areaDesc)}` : ''}</div>` +
    (validity ? `<div class="wp-meta">${esc(validity)}</div>` : '') +
    (w.description ? `<p class="wp-desc">${esc(w.description)}</p>` : '') +
    (w.instruction ? `<p class="wp-desc wp-instr">${esc(w.instruction)}</p>` : '') +
    (w.web
      ? `<a class="wp-link" href="${esc(w.web)}" target="_blank" rel="noreferrer">Mehr dazu</a>`
      : '') +
    `</div>`
  );
}

/** Popup eines Blitzes: Zeitpunkt, Ortungsgüte, Zahl der Stationen. */
function lightningPopupHtml(s: LightningStrike): string {
  const accuracy =
    s.accuracyM == null
      ? ''
      : s.accuracyM >= 1000
        ? `± ${(s.accuracyM / 1000).toFixed(1)} km`
        : `± ${s.accuracyM} m`;
  return (
    `<div class="warn-popup">` +
    `<h4>Blitz</h4>` +
    `<div class="wp-meta">${esc(relativeTime(s.time))} · ${esc(formatDateTime(s.time))}</div>` +
    `<div class="wp-meta">${s.stations} Empfangsstationen${accuracy ? ` · ${esc(accuracy)}` : ''}</div>` +
    `<div class="wp-meta">Blitzortung.org (ehrenamtliches Netz)</div>` +
    `</div>`
  );
}

/** Popup einer Rastanlage bzw. eines Ladepunkts. */
function restPopupHtml(f: RestFacility): string {
  const rows: [string, string][] = [];
  if (f.carSpaces != null) rows.push(['Pkw-Stellplätze', String(f.carSpaces)]);
  if (f.lorrySpaces != null) rows.push(['Lkw-Stellplätze', String(f.lorrySpaces)]);
  if (f.chargePoints != null) rows.push(['Ladepunkte', String(f.chargePoints)]);
  if (f.chargePower) rows.push(['Leistung', f.chargePower]);
  if (f.operator) rows.push(['Betreiber', f.operator]);
  return (
    `<div class="warn-popup">` +
    `<h4>${esc(f.title)}</h4>` +
    `<div class="wp-region">${esc(f.road)}${f.subtitle ? ` · ${esc(f.subtitle)}` : ''}</div>` +
    (rows.length
      ? `<div class="wp-rows">${rows
          .map(([k, v]) => `<span class="ac-k">${esc(k)}</span><span class="ac-v">${esc(v)}</span>`)
          .join('')}</div>`
      : '') +
    (f.features.length ? `<p class="wp-desc">${esc(f.features.join(' · '))}</p>` : '') +
    `</div>`
  );
}

/** Himmelsrichtung im Klartext — „Blick 290°" sagt nicht jedem etwas. */
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

/**
 * Popup eines Webcam-Standorts.
 *
 * Bewusst **ohne Kamerabild**: Foto-Webcam.eu erlaubt das Verlinken
 * ausdrücklich, die Bildnutzung ist aber je Kamera geregelt.
 */
function webcamPopupHtml(w: WebcamSpot): string {
  const dir =
    w.bearing == null ? '' : `${COMPASS[Math.round(w.bearing / 45) % 8]} (${w.bearing}°)`;
  const rows: [string, string][] = [];
  if (w.elevationM != null) rows.push(['Höhe', `${w.elevationM} m`]);
  if (dir) rows.push(['Blickrichtung', dir]);
  return (
    `<div class="warn-popup">` +
    `<h4>${esc(w.name)}</h4>` +
    (w.title ? `<div class="wp-region">${esc(w.title)}</div>` : '') +
    (rows.length
      ? `<div class="wp-rows">${rows
          .map(([k, v]) => `<span class="ac-k">${esc(k)}</span><span class="ac-v">${esc(v)}</span>`)
          .join('')}</div>`
      : '') +
    (w.offline ? `<div class="wp-meta">zurzeit offline</div>` : '') +
    `<a class="wp-link" href="${esc(w.url)}" target="_blank" rel="noreferrer">Zum Kamerabild</a>` +
    `<div class="wp-meta">Bild und Rechte liegen bei Foto-Webcam.eu</div>` +
    `</div>`
  );
}

/** Popup einer Wärmeanomalie — mit dem nötigen Vorbehalt. */
function firePopupHtml(f: FireDetection): string {
  const CONF: Record<string, string> = {
    low: 'geringer Vertrauensgrad',
    nominal: 'üblicher Vertrauensgrad',
    high: 'hoher Vertrauensgrad',
  };
  return (
    `<div class="warn-popup">` +
    `<h4>Wärmeanomalie</h4>` +
    `<div class="wp-meta">${esc(relativeTime(f.at))} · ${esc(formatDateTime(f.at))} · ${esc(f.satellite)}</div>` +
    `<div class="wp-meta">Strahlungsleistung ${f.frpMW.toFixed(1).replace('.', ',')} MW · ${esc(CONF[f.confidence] ?? f.confidence)}</div>` +
    `<p class="wp-desc">Satellitenmessung eines heißen Bildpunkts (≈375 m). Auch Industrie, ` +
    `Fackeln oder Feldarbeit können dahinterstecken — kein bestätigter Brand.</p>` +
    `</div>`
  );
}

/** Popup einer Strahlungsmessstelle samt Einordnung des Werts. */
function radiationPopupHtml(s: RadiationStation): string {
  const num = (v: number) => v.toFixed(3).replace('.', ',');
  const v = s.microSievertPerHour;
  // Einordnung im Klartext, nicht nur über die Farbe.
  const judgement =
    v <= 0.2 ? 'im normalen Bereich' : v <= 0.5 ? 'leicht erhöht' : 'deutlich erhöht';
  const rows = [
    ['Messwert', `${num(v)} µSv/h`],
    ['Einordnung', judgement],
    ...(s.cosmic != null ? [['davon kosmisch', `${num(s.cosmic)} µSv/h`]] : []),
    ...(s.terrestrial != null ? [['davon terrestrisch', `${num(s.terrestrial)} µSv/h`]] : []),
  ];
  return (
    `<div class="warn-popup">` +
    `<h4>${esc(s.name || 'Messstelle')}</h4>` +
    `<div class="wp-region">Ortsdosisleistung (Gammastrahlung)</div>` +
    `<div class="wp-rows">` +
    rows
      .map(([k, val]) => `<span class="ac-k">${esc(k!)}</span><span class="ac-v">${esc(val!)}</span>`)
      .join('') +
    `</div>` +
    (s.measuredAt ? `<div class="wp-time">Messung ${formatDateTime(s.measuredAt)}</div>` : '') +
    `<div class="wp-meta">Bundesamt für Strahlenschutz${s.validated ? '' : ' · noch nicht geprüft'}</div>` +
    `</div>`
  );
}

/** Popup eines Erdbebens: Stärke, Ort, Tiefe, Zeitpunkt. */
function quakePopupHtml(q: EarthquakeItem): string {
  return (
    `<div class="warn-popup">` +
    `<h4>Stärke ${q.magnitude.toFixed(1).replace('.', ',')}</h4>` +
    `<b>${esc(q.place)}</b>` +
    `<div class="wp-meta">Tiefe ${Math.round(q.depthKm)} km` +
    (q.time ? ` · ${esc(relativeTime(q.time))}` : '') +
    (q.tsunami ? ' · Tsunami-Hinweis' : '') +
    `</div>` +
    `<a class="wp-link" href="${esc(q.url)}" target="_blank" rel="noreferrer">Bericht (USGS)</a>` +
    `</div>`
  );
}

function warningPopupHtml(w: WarningFeature): string {
  const validity = w.expires
    ? `gültig bis ${new Date(w.expires).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  return (
    `<div class="warn-popup">` +
    `<span class="wp-sev" style="background:${SEVERITY_COLOR[w.severity]}">${esc(SEVERITY_DE[w.severity])}</span>` +
    `<b>${esc(w.headline)}</b>` +
    (w.regionName ? `<div class="wp-region">${esc(w.regionName)}</div>` : '') +
    (validity ? `<div class="wp-meta">${esc(validity)}</div>` : '') +
    (w.description ? `<p class="wp-desc">${esc(w.description)}</p>` : '') +
    (w.instruction ? `<p class="wp-desc wp-instr">${esc(w.instruction)}</p>` : '') +
    `</div>`
  );
}

const EMERGENCY_DE: Record<string, string> = {
  hijack: 'Entführung (7500)',
  'radio-failure': 'Funkausfall (7600)',
  general: 'Luftnotfall (7700)',
};

/** Flughafen kurz benennen: „Frankfurt (FRA)". */
function airportLabel(a: Airport): string {
  const place = a.municipality ?? a.name;
  return a.iata ? `${place} (${a.iata})` : place;
}

/** Eine Zeile im Datenraster des Popups. */
function row(label: string, value: string | null): string {
  return value ? `<div class="ac-k">${esc(label)}</div><div class="ac-v">${esc(value)}</div>` : '';
}

/**
 * Flugzeug-Popup. `details` kommt erst nach dem Antippen dazu (Halter und
 * Flugroute werden einzeln nachgeladen) — bis dahin steht dort ein Hinweis.
 */
function aircraftPopupHtml(a: Aircraft, details?: AircraftDetails | null, loading = false): string {
  const fl = a.altitudeFt != null ? `FL${Math.round(a.altitudeFt / 100)}` : null;
  const altitude = a.onGround
    ? 'am Boden'
    : a.altitudeFt != null
      ? `${a.altitudeFt.toLocaleString('de-DE')} ft (${fl})` +
        (a.selectedAltitudeFt != null && Math.abs(a.selectedAltitudeFt - a.altitudeFt) > 200
          ? ` → ${a.selectedAltitudeFt.toLocaleString('de-DE')} ft`
          : '')
      : null;
  const climb =
    a.verticalRateFpm != null && Math.abs(a.verticalRateFpm) >= 100
      ? `${a.verticalRateFpm > 0 ? '↑ steigt' : '↓ sinkt'} ${Math.abs(Math.round(a.verticalRateFpm)).toLocaleString('de-DE')} ft/min`
      : a.onGround
        ? null
        : 'hält die Höhe';
  const speed = [
    a.groundSpeedKt != null ? `${Math.round(a.groundSpeedKt)} kn über Grund` : null,
    a.indicatedSpeedKt != null ? `IAS ${Math.round(a.indicatedSpeedKt)}` : null,
    a.mach != null && a.mach > 0.3 ? `Mach ${a.mach.toFixed(2).replace('.', ',')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const wind =
    a.windDirDeg != null && a.windKt != null ? `${Math.round(a.windDirDeg)}° mit ${Math.round(a.windKt)} kn` : null;
  const identity = [
    details?.owner ?? details?.airline,
    a.description ?? details?.type ?? a.type,
    a.registration ?? details?.registration,
  ]
    .filter(Boolean)
    .join(' · ');
  const route =
    details?.origin && details.destination
      ? `${airportLabel(details.origin)} → ${airportLabel(details.destination)}`
      : null;

  return (
    `<div class="warn-popup ac-popup">` +
    (a.emergency ? `<span class="wp-sev" style="background:#a92318">${esc(EMERGENCY_DE[a.emergency]!)}</span>` : '') +
    `<b>${esc(a.callsign ?? a.registration ?? a.icao.toUpperCase())}</b>` +
    `<div class="wp-region">${esc(identity || 'Unbekanntes Muster')}</div>` +
    (route ? `<div class="ac-route">${esc(route)}</div>` : '') +
    (loading ? `<div class="ac-route ac-loading">Route wird geladen …</div>` : '') +
    `<div class="ac-grid">` +
    row('Höhe', altitude) +
    row('Steigen', climb) +
    row('Tempo', speed || null) +
    row('Kurs', a.trackDeg != null ? `${Math.round(a.trackDeg)}°` : null) +
    row('Wind', wind) +
    row('Außen', a.outsideTempC != null ? `${Math.round(a.outsideTempC)} °C` : null) +
    row('Squawk', a.squawk) +
    row('Muster', a.type && a.description ? `${a.type} (${a.category ?? '–'})` : null) +
    row('Abstand', a.distanceKm != null ? `${a.distanceKm.toString().replace('.', ',')} km zur Kartenmitte` : null) +
    `</div>` +
    `<div class="wp-meta">Empfangen ${a.seenSec != null ? `vor ${Math.round(a.seenSec)} s` : 'gerade eben'} · ADS-B</div>` +
    `</div>`
  );
}

function vesselPopupHtml(v: Vessel): string {
  const facts = [
    v.speedKt != null ? `Tempo ${v.speedKt.toFixed(1)} kn` : null,
    v.courseDeg != null ? `Kurs ${Math.round(v.courseDeg)}°` : null,
    v.lengthM ? `Länge ${v.lengthM} m` : null,
  ].filter(Boolean);
  return (
    `<div class="warn-popup">` +
    `<b>${esc(v.name ?? `MMSI ${v.mmsi}`)}</b>` +
    `<div class="wp-region">${esc(VESSEL_DE[v.kind] ?? 'Schiff')}${v.status ? ` · ${esc(VESSEL_STATUS_DE[v.status] ?? '')}` : ''}</div>` +
    (facts.length ? `<p class="wp-desc">${esc(facts.join(' · '))}</p>` : '') +
    (v.destination ? `<p class="wp-desc">Ziel: ${esc(v.destination)}</p>` : '') +
    `<div class="wp-meta">Meldung ${esc(timeHM(v.reportedAt))} · MMSI ${v.mmsi}</div>` +
    `</div>`
  );
}

function aircraftToGeoJson(list: Aircraft[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((a) => ({
      type: 'Feature',
      properties: {
        id: a.icao,
        label: a.callsign ?? a.registration ?? '',
        rotate: a.trackDeg ?? 0,
        // Symbol nach Musterklasse und Zustand, z. B. „ac-heavy-air".
        icon: `ac-${a.aircraftClass}-${a.emergency ? 'alert' : a.onGround ? 'ground' : 'air'}`,
        ground: a.onGround,
      },
      geometry: { type: 'Point', coordinates: [a.coordinates.lon, a.coordinates.lat] },
    })),
  };
}

function vesselsToGeoJson(list: Vessel[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((v) => ({
      type: 'Feature',
      properties: {
        id: v.mmsi,
        label: v.name ?? '',
        rotate: v.headingDeg ?? v.courseDeg ?? 0,
        icon: `ship-${['cargo', 'tanker', 'passenger', 'tug', 'fishing'].includes(v.kind) ? v.kind : 'other'}`,
      },
      geometry: { type: 'Point', coordinates: [v.coordinates.lon, v.coordinates.lat] },
    })),
  };
}

function aprsPopupHtml(s: AprsStation): string {
  const facts = [
    s.speedKmh != null && s.speedKmh > 0 ? `${Math.round(s.speedKmh)} km/h` : null,
    s.courseDeg != null && (s.speedKmh ?? 0) > 0 ? `Kurs ${Math.round(s.courseDeg)}°` : null,
    s.altitudeM != null ? `${Math.round(s.altitudeM)} m ü. NN` : null,
  ].filter(Boolean);
  const w = s.weather;
  const wx = w
    ? [
        w.tempC != null ? `${w.tempC} °C` : null,
        w.humidityPct != null ? `${w.humidityPct} % rF` : null,
        w.windKmh != null ? `Wind ${Math.round(w.windKmh)} km/h${w.windGustKmh ? ` (Böen ${Math.round(w.windGustKmh)})` : ''}` : null,
        w.pressureHpa != null ? `${w.pressureHpa} hPa` : null,
        w.rain1hMm ? `Regen 1 h ${w.rain1hMm} mm` : null,
      ].filter(Boolean)
    : [];
  const call = encodeURIComponent(s.name);
  return (
    `<div class="warn-popup">` +
    `<b>${esc(s.showname ?? s.name)}</b>` +
    `<div class="wp-region">${esc(APRS_KIND_DE[s.kind] ?? 'APRS')}${s.symbol ? ` · Symbol ${esc(s.symbol)}` : ''}</div>` +
    (s.comment ? `<p class="wp-desc">${esc(s.comment)}</p>` : '') +
    (facts.length ? `<p class="wp-desc">${esc(facts.join(' · '))}</p>` : '') +
    (wx.length ? `<p class="wp-desc">${esc(wx.join(' · '))}</p>` : '') +
    (s.status ? `<p class="wp-desc wp-instr">${esc(s.status)}</p>` : '') +
    `<div class="wp-meta">Gehört ${esc(relativeTime(s.lastHeard))} · ` +
    `<a href="https://aprs.fi/#!call=a%2F${call}" target="_blank" rel="noreferrer">aprs.fi</a></div>` +
    `</div>`
  );
}

function aprsToGeoJson(list: AprsStation[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((s) => ({
      type: 'Feature',
      properties: {
        id: s.name,
        label: s.showname ?? s.name,
        rotate: s.courseDeg ?? 0,
        icon:
          s.kind === 'weather' ? 'aprs-wx' : (s.speedKmh ?? 0) > 1 && s.courseDeg != null ? 'aprs-move' : 'aprs-fix',
      },
      geometry: { type: 'Point', coordinates: [s.coordinates.lon, s.coordinates.lat] },
    })),
  };
}

/** Beschriftung des Windfelds: Geschwindigkeit an den Gitterpunkten. */
function windLabelsToGeoJson(points: WindPoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p, i) => ({
      type: 'Feature',
      id: i,
      properties: {
        label: `${p.speedKmh}`,
        // Dunkle Schrift mit hellem Rand liest sich auf jedem Untergrund;
        // die Stärke steckt ohnehin in der Farbe der Strömungslinien.
        color: p.speedKmh >= 50 ? '#8f1d14' : '#1f2933',
      },
      geometry: { type: 'Point', coordinates: [p.coordinates.lon, p.coordinates.lat] },
    })),
  };
}

function markerEl(color: string, size = 16, ring = false): HTMLDivElement {
  const el = document.createElement('div');
  el.className = ring ? 'mk mk-user' : 'mk';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.background = color;
  return el;
}

interface Props {
  coords: Coords;
  warnings: WarningFeature[];
  traffic: TrafficIncident[];
  pegel: WaterLevel[];
  radar: RadarData | null;
  /** DWD-Vorhersageradar; wenn vorhanden, hat es Vorrang vor RainViewer. */
  radarForecast: RadarForecast | null;
  /** true, solange die DWD-Vorhersage lädt — dann blitzt RainViewer nicht kurz auf. */
  radarForecastPending: boolean;
  aircraft: Aircraft[];
  vessels: Vessel[];
  aprs: AprsStation[];
  wind: WindField;
  flowAvailable: boolean;
  /** true, wenn der Server einen AIS-Stream hat (sonst keine Schiffs-Ebene). */
  aisAvailable: boolean;
  /** true, wenn ein aprs.fi-Key hinterlegt ist. */
  aprsAvailable: boolean;
  /** true, sobald der Server Blitze empfängt. */
  lightningAvailable: boolean;
  /** Wenn gesetzt: Basiskarte aus dieser Offline-Region (OPFS) statt online. */
  offlineCode: string | null;
  /** Berechnete Route (offline) — Linie, Start- und Zielmarke. */
  route: RouteResult | null;
  /** Gewählte ÖPNV-Verbindung (Fußwege gestrichelt, Fahrten in Linienfarbe). */
  itinerary: TransitItinerary | null;
  /** Weltweites MUF-Gitter für die Ausbreitungsebene. */
  muf: HfMufGrid | null;
  /** Verortete Meldungen für die Nachrichten-Ebene. */
  news: NewsItem[];
  /** Fahrzeuge des öffentlichen Verkehrs (Position geschätzt). */
  vehicles: TransitVehicle[];
  /** Antippen eines Fahrzeugs öffnet dessen Fahrplan. */
  onVehicleClick: (vehicle: TransitVehicle) => void;
  /** Laufweg der geöffneten Fahrt — gefahrener Teil blass, Rest kräftig. */
  vehicleTrip: {
    geometry: [number, number][];
    at: Coords;
    color: string;
    /** Aufschrift des Bandes, das den Laufweg wieder abwählbar macht. */
    label: string;
    /** Zählt hoch, wenn der Rest der Fahrt ins Bild gerückt werden soll. */
    fitKey: number;
  } | null;
  /** Fahrplan der gewählten Fahrt wieder öffnen. */
  onTripOpen: () => void;
  /** Laufweg von der Karte nehmen. */
  onTripClear: () => void;
  /** Notfallpunkte aus dem Offline-Index (Krankenhaus, Apotheke …). */
  emergency: GeoResult[];
  /** Erdbeben der letzten Woche. */
  quakes: EarthquakeItem[];
  /** Blitzentladungen der letzten Minuten. */
  lightning: LightningStrike[];
  /** Behördenwarnungen (BBK/NINA). */
  nina: CivilWarning[];
  /** Wärmeanomalien aus dem Satellitenblick. */
  fires: FireDetection[];
  /** Messstellen der Ortsdosisleistung. */
  radiation: RadiationStation[];
  /** Rastanlagen und Ladepunkte an Autobahnen. */
  rest: RestFacility[];
  /** Standorte öffentlicher Webcams. */
  webcams: WebcamSpot[];
  /** Polarlicht-Gitter und Waldbrandgefahr als Flächen. */
  aurora: AuroraGrid | null;
  fire: FireDangerGrid | null;
  /** Karte auf diesen Punkt schwenken (z.B. aus der Nachrichtenliste). */
  flyTo: { lat: number; lon: number; zoom?: number; key: number } | null;
  /** Haltestellen im Ausschnitt. */
  stops: TransitStopPoint[];
  /** Antippen einer Haltestelle öffnet ihre Abfahrten. */
  onStopClick: (stop: TransitStopPoint) => void;
  /** true, wenn für die Gegend überhaupt ein Suchindex gespeichert ist. */
  stopsAvailable: boolean;
  /** Nicht gewählte Varianten (grau, anklickbar). */
  alternatives: { index: number; route: RouteResult }[];
  /** Auswahl einer Variante durch Antippen der grauen Linie. */
  onSelectRoute: (index: number) => void;
  /** Startpunkt der Route (null = eigener Standort). */
  routeOrigin: Coords | null;
  /** Angetippter Suchtreffer bzw. Routenziel. */
  pin: { lat: number; lon: number; name: string; category?: string } | null;
  /** Zielführung läuft — Kamera folgt der Position. */
  navigating: boolean;
  /** Aktuelle Position und Kurs während der Zielführung. */
  navPosition: Coords | null;
  navBearing: number | null;
  /** Punkt aus dem Kartenmenü als Ziel bzw. Start übernehmen. */
  onPickPoint: (point: Coords, kind: 'destination' | 'origin' | 'place' | 'radio', label?: string) => void;
  /** Großkreis der bewerteten Funkstrecke ([lon, lat]). */
  hfPath: [number, number][] | null;
  /** Der nächste Klick setzt den Standort (Modus aus dem Standort-Menü). */
  pickingLocation: boolean;
  onViewport: (b: Bbox) => void;
  /** Meldet die aktiven Live-Ebenen — diese Daten werden erst dann geladen. */
  onLayersChange: (active: ActiveLayers) => void;
  /** In den Einstellungen abgewählte Ebenen — sie erscheinen gar nicht im Menü. */
  hiddenLayers: LayerRowId[];
  /** Meldet **alle** eingeschalteten Zeilen — Grundlage für gespeicherte Karten. */
  onActiveLayers?: (ids: LayerRowId[]) => void;
  /**
   * Von außen gesetzte Ebenen (gespeicherte Karte, Diashow): genau diese an,
   * alle anderen aus. `key` zählt hoch, damit dieselbe Karte erneut greifen kann.
   */
  applyLayers?: { layers: LayerRowId[]; key: number } | null;
}

/** Ebenen, deren Daten nur bei Bedarf geholt werden. */
export interface ActiveLayers {
  radar: boolean;
  /** Fahrzeuge, Notfallpunkte, Erdbeben, Polarlicht, Waldbrandgefahr. */
  vehicles: boolean;
  emergency: boolean;
  quakes: boolean;
  lightning: boolean;
  /** Behördenwarnungen (BBK/NINA). */
  nina: boolean;
  /** Satelliten-Feuer und Strahlungsmessnetz. */
  fires: boolean;
  radiation: boolean;
  /** Rastanlagen/Ladepunkte und Webcam-Standorte. */
  rest: boolean;
  webcams: boolean;
  aurora: boolean;
  fire: boolean;
  /** Kurzwellen-Ausbreitung (MUF-Fläche). */
  muf: boolean;
  /** Verortete Nachrichten. */
  news: boolean;
  aircraft: boolean;
  vessels: boolean;
  aprs: boolean;
  wind: boolean;
  /** Haltestellen (Bus, Tram, Bahn) aus dem Offline-Index. */
  stops: boolean;
  /** Beobachtete APRS-Rufzeichen (aprs.fi kennt keine Umkreissuche). */
  aprsTargets: string[];
}

export type { LayerId, LayerRowId } from './layerCatalog.js';

/**
 * Darstellung der Symbol-Ebenen. Flugzeuge erst ab Zoom 6, weil das ADS-B-Netz
 * nur einen Umkreis um die Kartenmitte liefert; APRS ist eine kurze
 * Beobachtungsliste und darf deshalb immer mit Beschriftung erscheinen.
 */
const SYMBOL_STYLE: Record<
  'aircraft' | 'vessels' | 'aprs',
  { size: number; minzoom: number; labelZoom: number }
> = {
  aircraft: { size: 0.62, minzoom: 6, labelZoom: 9 },
  vessels: { size: 0.5, minzoom: 5, labelZoom: 9 },
  aprs: { size: 0.55, minzoom: 0, labelZoom: 0 },
};

const ALL_LAYERS_OFF: Record<LayerId, boolean> = {
  warnings: false,
  radar: false,
  flow: false,
  traffic: false,
  pegel: false,
  aircraft: false,
  vessels: false,
  aprs: false,
  wind: false,
  night: false,
  nina: false,
  rest: false,
  webcams: false,
  fires: false,
  radiation: false,
  lightning: false,
  stops: false,
  muf: false,
  news: false,
  vehicles: false,
  emergency: false,
  quakes: false,
  aurora: false,
  fire: false,
};

export function LageMap({
  coords,
  warnings,
  traffic,
  pegel,
  radar,
  radarForecast,
  radarForecastPending,
  aircraft,
  vessels,
  aprs,
  wind: windField,
  flowAvailable,
  aisAvailable,
  aprsAvailable,
  lightningAvailable,
  offlineCode,
  route,
  itinerary,
  muf,
  news,
  vehicles,
  onVehicleClick,
  vehicleTrip,
  onTripOpen,
  onTripClear,
  emergency,
  quakes,
  lightning,
  nina,
  fires,
  radiation,
  rest,
  webcams,
  aurora,
  fire,
  flyTo,
  hfPath,
  stops,
  stopsAvailable,
  onStopClick,
  alternatives,
  onSelectRoute,
  routeOrigin,
  pin,
  navigating,
  navPosition,
  navBearing,
  onPickPoint,
  pickingLocation,
  onViewport,
  onLayersChange,
  hiddenLayers,
  onActiveLayers,
  applyLayers,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const userMarker = useRef<Marker | null>(null);
  const dataMarkers = useRef<Marker[]>([]);
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;
  const onSelectRouteRef = useRef(onSelectRoute);
  onSelectRouteRef.current = onSelectRoute;
  const onPickPointRef = useRef(onPickPoint);
  onPickPointRef.current = onPickPoint;
  const onStopClickRef = useRef(onStopClick);
  onStopClickRef.current = onStopClick;
  const onVehicleClickRef = useRef(onVehicleClick);
  onVehicleClickRef.current = onVehicleClick;
  const onActiveLayersRef = useRef(onActiveLayers);
  onActiveLayersRef.current = onActiveLayers;
  /** Bereits geladene Pegelverläufe (null = Abruf fehlgeschlagen). */
  const pegelHistory = useRef<Map<string, WaterLevelHistory | null>>(new Map());
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const pickingRef = useRef(pickingLocation);
  pickingRef.current = pickingLocation;
  const routeMarkers = useRef<Marker[]>([]);
  const navMarker = useRef<Marker | null>(null);
  const [pointMenu, setPointMenu] = useState<{
    x: number;
    y: number;
    lngLat: Coords;
    /** Name der angetippten eigenen Markierung (sonst null). */
    label?: string | null;
  } | null>(null);
  const warnPopup = useRef<MlPopup | null>(null);
  const warnById = useRef<Map<string, WarningFeature>>(new Map());
  const currentBase = useRef<string>('online');
  const [ready, setReady] = useState(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [activeSev, setActiveSev] = useState<Set<Severity>>(() => new Set(ALL_SEVERITIES));
  // Alle Fachebenen starten aus — der Nutzer schaltet gezielt zu.
  const [on, setOn] = useState<Record<LayerId, boolean>>(() => ({ ...ALL_LAYERS_OFF }));
  const toggleLayer = (id: LayerId) => setOn((prev) => ({ ...prev, [id]: !prev[id] }));
  const {
    warnings: showWarnings,
    traffic: showTraffic,
    pegel: showPegel,
    radar: showRadar,
    flow: showFlow,
    night: showNight,
    aircraft: showAircraft,
    vessels: showVessels,
    aprs: showAprs,
    wind: showWind,
    stops: showStops,
    muf: showMuf,
    news: showNews,
    vehicles: showVehicles,
    emergency: showEmergency,
    quakes: showQuakes,
    lightning: showLightning,
    nina: showNina,
    fires: showFires,
    radiation: showRadiation,
    rest: showRest,
    webcams: showWebcams,
    aurora: showAurora,
    fire: showFire,
  } = on;
  const [menuOpen, setMenuOpen] = useState(false);
  const [radarIdx, setRadarIdx] = useState(0);
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [iconEpoch, setIconEpoch] = useState(0);
  const [aprsTargets, setAprsTargets] = useState<string[]>(() => loadTargets());
  const [aprsOpen, setAprsOpen] = useState(false);
  // Anzeigeoption der Windebene, keine eigene Ebene — bleibt von „Alle aus"
  // unberührt und startet wie die Ebenen selbst ausgeschaltet.
  const [windLabels, setWindLabels] = useState(false);
  useEffect(() => saveTargets(aprsTargets), [aprsTargets]);
  const [drawFeatures, setDrawFeatures] = useState<DrawFeature[]>(() => loadDraw());
  const [drawMode, setDrawMode] = useState<DrawMode>('off');
  const [drawBarOpen, setDrawBarOpen] = useState(false);
  const [areaVertices, setAreaVertices] = useState<[number, number][]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [pending, setPending] = useState<PendingDraw | null>(null);
  const drawModeRef = useRef<DrawMode>('off');
  drawModeRef.current = drawMode;
  const drawCount = useRef({ point: 0, area: 0 });
  drawCount.current = {
    point: drawFeatures.filter((f) => f.kind === 'point').length,
    area: drawFeatures.filter((f) => f.kind === 'area').length,
  };
  useEffect(() => saveDraw(drawFeatures), [drawFeatures]);

  // Live-Daten (Radar, Flüge, Schiffe, APRS) werden nur geladen, wenn ihre Ebene an ist.
  useEffect(
    () =>
      onLayersChange({
        radar: showRadar,
        aircraft: showAircraft,
        vessels: showVessels,
        aprs: showAprs,
        wind: showWind,
        stops: showStops,
        muf: showMuf,
        news: showNews,
        vehicles: showVehicles,
        emergency: showEmergency,
        quakes: showQuakes,
        lightning: showLightning,
        nina: showNina,
        fires: showFires,
        radiation: showRadiation,
        rest: showRest,
        webcams: showWebcams,
        aurora: showAurora,
        fire: showFire,
        aprsTargets,
      }),
    [
      showRadar, showAircraft, showVessels, showAprs, showWind, showStops, showMuf, showNews,
      showVehicles, showEmergency, showQuakes, showLightning, showNina, showFires, showRadiation,
      showAurora, showFire, showRest, showWebcams, aprsTargets,
      onLayersChange,
    ],
  );

  // Vollständige Liste der eingeschalteten Zeilen — die Einstellungen machen
  // daraus auf Wunsch eine gespeicherte Karte.
  const activeIds: LayerRowId[] = [
    ...(Object.keys(on) as LayerId[]).filter((id) => on[id]),
    ...(windLabels ? (['wind-labels'] as const) : []),
  ];
  const activeKey = activeIds.join(',');
  useEffect(() => {
    onActiveLayersRef.current?.(activeKey ? (activeKey.split(',') as LayerRowId[]) : []);
  }, [activeKey]);

  // Eine gespeicherte Karte anwenden: genau ihre Ebenen an, der Rest aus.
  useEffect(() => {
    if (!applyLayers) return;
    const wanted = new Set(applyLayers.layers);
    setOn(() => {
      const next = { ...ALL_LAYERS_OFF };
      for (const id of wanted) if (id !== 'wind-labels') next[id as LayerId] = true;
      return next;
    });
    setWindLabels(wanted.has('wind-labels'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyLayers?.key]);

  // Nachschlagetabellen für die Klick-Popups
  const aircraftById = useRef<Map<string, Aircraft>>(new Map());
  const vesselByMmsi = useRef<Map<number, Vessel>>(new Map());
  const aprsByName = useRef<Map<string, AprsStation>>(new Map());
  /** Nachgeladene Flugdetails (Halter, Route) — je ICAO nur einmal holen. */
  const aircraftDetails = useRef<Map<string, AircraftDetails>>(new Map());
  /** Welches Flugzeug gerade im Popup steht (spätes Nachladen zuordnen). */
  const openAircraft = useRef<string | null>(null);
  useEffect(() => {
    aircraftById.current = new Map(aircraft.map((a) => [a.icao, a]));
  }, [aircraft]);
  useEffect(() => {
    vesselByMmsi.current = new Map(vessels.map((v) => [v.mmsi, v]));
  }, [vessels]);
  useEffect(() => {
    aprsByName.current = new Map(aprs.map((s) => [s.name, s]));
  }, [aprs]);

  // Nachschlagetabelle id → Warnung (für Klick-Popup)
  useEffect(() => {
    warnById.current = new Map(warnings.map((w) => [w.id, w]));
  }, [warnings]);

  // Karte einmalig erzeugen
  useEffect(() => {
    if (!containerRef.current) return;
    registerPmtiles();
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(ONLINE_PMTILES_URL, dark),
      center: [coords.lon, coords.lat],
      zoom: 11,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    // Warn-Popup + Klick/Hover einmalig registrieren (überlebt Style-Wechsel).
    warnPopup.current = new maplibregl.Popup({ maxWidth: '300px' });
    map.on('click', 'warnings-fill', (e) => {
      if (drawModeRef.current !== 'off') return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const wf = id ? warnById.current.get(id) : undefined;
      if (!wf) return;
      warnPopup.current!.setLngLat(e.lngLat).setHTML(warningPopupHtml(wf)).addTo(map);
    });

    // Zeichnen: Klick setzt einen Punkt bzw. eine Flächen-Ecke.
    map.on('click', (e) => {
      // Standort setzen hat Vorrang vor allem anderen.
      if (pickingRef.current) {
        onPickPointRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng }, 'place');
        return;
      }
      const mode = drawModeRef.current;
      const c: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (mode === 'point') {
        // Punkt sofort benennen lassen, statt ihn stumm anzulegen.
        setPending({
          kind: 'point',
          geometry: { type: 'Point', coordinates: c },
          defaultName: `Ort ${drawCount.current.point + 1}`,
        });
      } else if (mode === 'area') {
        setAreaVertices((prev) => [...prev, c]);
      }
    });
    // Flug-/Schiffs-Popups (die Ebenen entstehen erst später — das ist ok).
    map.on('click', 'aircraft', (e) => {
      if (drawModeRef.current !== 'off') return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const ac = id ? aircraftById.current.get(id) : undefined;
      if (!ac) return;
      const known = aircraftDetails.current.get(ac.icao);
      openAircraft.current = ac.icao;
      warnPopup.current!.setLngLat(e.lngLat).setHTML(aircraftPopupHtml(ac, known, !known)).addTo(map);
      if (known) return;
      // Halter und Flugroute stehen woanders — erst auf Zuruf nachladen.
      fetchAircraftDetails(ac.icao, ac.callsign)
        .then((res) => {
          aircraftDetails.current.set(ac.icao, res.data);
          if (openAircraft.current !== ac.icao || !warnPopup.current?.isOpen()) return;
          const current = aircraftById.current.get(ac.icao) ?? ac;
          warnPopup.current.setHTML(aircraftPopupHtml(current, res.data));
        })
        .catch(() => {
          if (openAircraft.current === ac.icao && warnPopup.current?.isOpen()) {
            warnPopup.current.setHTML(aircraftPopupHtml(ac, null));
          }
        });
    });
    map.on('click', 'vessels', (e) => {
      if (drawModeRef.current !== 'off') return;
      const id = e.features?.[0]?.properties?.id as number | undefined;
      const vessel = id != null ? vesselByMmsi.current.get(id) : undefined;
      if (vessel) warnPopup.current!.setLngLat(e.lngLat).setHTML(vesselPopupHtml(vessel)).addTo(map);
    });

    map.on('click', 'aprs', (e) => {
      if (drawModeRef.current !== 'off') return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const station = id ? aprsByName.current.get(id) : undefined;
      if (station) warnPopup.current!.setLngLat(e.lngLat).setHTML(aprsPopupHtml(station)).addTo(map);
    });

    for (const layer of ['warnings-fill', 'aircraft', 'vessels', 'aprs']) {
      map.on('mouseenter', layer, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
      });
    }
    // Nach jedem (Neu-)Laden des Styles die Overlays neu auflegen.
    map.on('style.load', () => setStyleEpoch((n) => n + 1));

    // Sichtbaren Ausschnitt melden (entprellt), damit die Daten dem Zoom folgen.
    const emit = () => {
      const b = map.getBounds();
      onViewportRef.current({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onMoveEnd = () => {
      clearTimeout(debounce);
      debounce = setTimeout(emit, 400);
    };
    map.on('load', () => {
      setReady(true);
      emit();
    });
    map.on('moveend', onMoveEnd);

    mapRef.current = map;
    return () => {
      clearTimeout(debounce);
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auf neuen Standort schwenken + Nutzer-Marker setzen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.flyTo({ center: [coords.lon, coords.lat], zoom: 11, speed: 1.4 });
    if (!userMarker.current) {
      userMarker.current = new maplibregl.Marker({ element: markerEl('var(--accent)', 16, true) });
    }
    userMarker.current.setLngLat([coords.lon, coords.lat]).addTo(map);
  }, [coords, ready]);

  // Basiskarte online ↔ offline (OPFS-PMTiles) umschalten
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const desired = offlineCode ?? 'online';
    if (desired === currentBase.current) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (offlineCode) {
      let cancelled = false;
      getOfflineFile(offlineCode)
        .then((file) => {
          if (cancelled || mapRef.current !== map) return;
          const key = addLocalPmtiles(file);
          currentBase.current = offlineCode;
          // buildStyle setzt das pmtiles://-Präfix selbst — der Schlüssel ist
          // der Dateiname, unter dem das Protokoll die OPFS-Datei kennt.
          map.setStyle(buildStyle(key, dark), { diff: false });
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    currentBase.current = 'online';
    map.setStyle(buildStyle(ONLINE_PMTILES_URL, dark), { diff: false });
  }, [offlineCode, ready]);

  // Warn-Polygone: Quelle + Layer einmalig anlegen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('warnings')) return;
    map.addSource('warnings', { type: 'geojson', data: warningsToGeoJson(warnings) });
    map.addLayer({
      id: 'warnings-fill',
      type: 'fill',
      source: 'warnings',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.28 },
    });
    map.addLayer({
      id: 'warnings-line',
      type: 'line',
      source: 'warnings',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.4 },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, styleEpoch]);

  // Warnebene komplett ein-/ausblenden (eigener Schalter)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const visibility = showWarnings ? 'visible' : 'none';
    for (const id of ['warnings-fill', 'warnings-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
    if (!showWarnings) warnPopup.current?.remove();
  }, [showWarnings, ready, styleEpoch]);

  // Warn-Daten aktualisieren
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('warnings') as maplibregl.GeoJSONSource | undefined;
    src?.setData(warningsToGeoJson(warnings));
  }, [warnings, ready, styleEpoch]);

  // Warn-Layer nach Warnstufe filtern (Legenden-Umschalter)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter: FilterSpecification = ['in', ['get', 'severity'], ['literal', [...activeSev]]];
    if (map.getLayer('warnings-fill')) map.setFilter('warnings-fill', filter);
    if (map.getLayer('warnings-line')) map.setFilter('warnings-line', filter);
  }, [activeSev, ready, styleEpoch]);

  // --- Regenradar: DWD-Vorhersage, sonst RainViewer -----------------------

  /** Die DWD-Vorhersage deckt nur Deutschland ab (sonst leere Frame-Liste). */
  const useDwd = (radarForecast?.frames.length ?? 0) > 0 && radarSupported();

  const timeline: TimelineFrame[] = useMemo(() => {
    if (useDwd && radarForecast) {
      return radarForecast.frames.map((f) => ({
        timeSec: Date.parse(f.time) / 1000,
        forecast: f.forecast,
      }));
    }
    if (radarForecastPending) return [];
    return (radar?.frames ?? []).map((f) => ({ timeSec: f.time, forecast: f.forecast }));
  }, [useDwd, radarForecast, radarForecastPending, radar]);

  // Neue Radar-Daten → auf den aktuellsten gemessenen Frame springen
  useEffect(() => {
    if (timeline.length === 0) return;
    const lastPast = timeline.map((f) => f.forecast).lastIndexOf(false);
    setRadarIdx(lastPast >= 0 ? lastPast : timeline.length - 1);
  }, [timeline]);

  // Radarebene aus → auch die Wiedergabe stoppen
  useEffect(() => {
    if (!showRadar) setRadarPlaying(false);
  }, [showRadar]);

  // RainViewer-Kachel-Layer (nur ohne DWD-Vorhersage), unter den Warnflächen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const rvFrames = radar?.frames ?? [];
    if (showRadar && !useDwd && !radarForecastPending && radar && rvFrames.length > 0) {
      if (!map.getSource('radar')) {
        const url = radarTileUrl(radar.host, rvFrames[Math.min(radarIdx, rvFrames.length - 1)]!.path);
        // RainViewer liefert Radar-Kacheln nur bis Zoom 7; ab z8 kommt eine
        // "zoom level not supported"-Platzhalterkachel. maxzoom: 7 lässt MapLibre
        // die z7-Kacheln überzoomen (geglättet), statt die Platzhalter zu laden.
        map.addSource('radar', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 7 });
        const beforeId = map.getLayer('warnings-fill') ? 'warnings-fill' : undefined;
        map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.7 } }, beforeId);
      }
    } else {
      if (map.getLayer('radar')) map.removeLayer('radar');
      if (map.getSource('radar')) map.removeSource('radar');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRadar, useDwd, radarForecastPending, radar, ready, styleEpoch]);

  // RainViewer: Frame wechseln
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !showRadar || useDwd || !radar) return;
    const src = map.getSource('radar') as maplibregl.RasterTileSource | undefined;
    const frame = radar.frames[Math.min(radarIdx, radar.frames.length - 1)];
    if (src && frame) src.setTiles([radarTileUrl(radar.host, frame.path)]);
  }, [radarIdx, showRadar, useDwd, radar, ready, styleEpoch]);

  // DWD-Frames werden im Browser aus dem Gitter gemalt — einmal je Frame.
  const dwdImages = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    dwdImages.current = new Map();
  }, [radarForecast]);

  const dwdImageUrl = useCallback(
    async (index: number): Promise<string | null> => {
      const fc = radarForecast;
      if (!fc) return null;
      const done = dwdImages.current.get(index);
      if (done) return done;
      const frame = fc.frames[index];
      if (!frame) return null;
      const url = gridToDataUrl(await inflateGrid(frame.data), fc.width, fc.height);
      dwdImages.current.set(index, url);
      return url;
    },
    [radarForecast],
  );

  // DWD-Radarbild als Bildquelle über die vier Eckkoordinaten legen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc = radarForecast;
    if (!showRadar || !useDwd || !fc) {
      if (map.getLayer('radar-dwd')) map.removeLayer('radar-dwd');
      if (map.getSource('radar-dwd')) map.removeSource('radar-dwd');
      return;
    }
    let cancelled = false;
    const coordinates = fc.corners as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
    void dwdImageUrl(Math.min(radarIdx, fc.frames.length - 1))
      .then((url) => {
        if (!url || cancelled || mapRef.current !== map || !map.getStyle()) return;
        const src = map.getSource('radar-dwd') as maplibregl.ImageSource | undefined;
        if (src) {
          src.updateImage({ url, coordinates });
          return;
        }
        map.addSource('radar-dwd', { type: 'image', url, coordinates });
        const beforeId = map.getLayer('warnings-fill') ? 'warnings-fill' : undefined;
        map.addLayer(
          {
            id: 'radar-dwd',
            type: 'raster',
            source: 'radar-dwd',
            paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
          },
          beforeId,
        );
      })
      .catch(() => {
        /* Frame nicht dekodierbar — Karte bleibt ohne Radarbild */
      });
    return () => {
      cancelled = true;
    };
  }, [showRadar, useDwd, radarForecast, radarIdx, ready, styleEpoch, dwdImageUrl]);

  // Alle DWD-Frames im Hintergrund vorbereiten, damit die Animation flüssig läuft.
  useEffect(() => {
    if (!showRadar || !useDwd || !radarForecast) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < radarForecast.frames.length && !cancelled; i++) {
        await dwdImageUrl(i).catch(() => null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showRadar, useDwd, radarForecast, dwdImageUrl]);

  // Abspielen
  useEffect(() => {
    if (!radarPlaying || timeline.length === 0) return;
    const t = setInterval(() => setRadarIdx((i) => (i + 1) % timeline.length), useDwd ? 320 : 500);
    return () => clearInterval(t);
  }, [radarPlaying, timeline, useDwd]);

  // Verkehrsfluss-Layer (TomTom via Proxy) an-/abschalten, unter Radar/Warnungen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (showFlow && flowAvailable) {
      if (!map.getSource('flow')) {
        map.addSource('flow', { type: 'raster', tiles: ['/api/flow/{z}/{x}/{y}.png'], tileSize: 256 });
        const beforeId = ['radar', 'radar-dwd', 'warnings-fill'].find((id) => map.getLayer(id));
        map.addLayer({ id: 'flow', type: 'raster', source: 'flow', paint: { 'raster-opacity': 0.85 } }, beforeId);
      }
    } else {
      if (map.getLayer('flow')) map.removeLayer('flow');
      if (map.getSource('flow')) map.removeSource('flow');
    }
  }, [showFlow, flowAvailable, ready, styleEpoch]);

  // --- Tag/Nacht-Grenze ---------------------------------------------------

  // Minütlich neu rechnen, damit die Grenze mitwandert.
  const [nightTick, setNightTick] = useState(0);
  useEffect(() => {
    if (!showNight) return;
    const t = setInterval(() => setNightTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [showNight]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!showNight) {
      for (const id of ['night-fill', 'twilight-fill']) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of ['night', 'twilight']) if (map.getSource(id)) map.removeSource(id);
      return;
    }
    const now = new Date();
    const twilight = shadowPolygon(now);
    const night = shadowPolygon(now, CIVIL_TWILIGHT);
    const beforeId = ['warnings-fill', 'radar', 'radar-dwd'].find((id) => map.getLayer(id));

    for (const [id, data] of [
      ['twilight', twilight],
      ['night', night],
    ] as const) {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        continue;
      }
      map.addSource(id, { type: 'geojson', data });
      map.addLayer(
        {
          id: `${id}-fill`,
          type: 'fill',
          source: id,
          // Zwei Schichten übereinander ergeben den weichen Dämmerungssaum.
          paint: { 'fill-color': '#0b1a33', 'fill-opacity': id === 'night' ? 0.22 : 0.16 },
        },
        beforeId,
      );
    }
  }, [showNight, nightTick, ready, styleEpoch]);

  // --- Flugzeuge & Schiffe ------------------------------------------------

  // Symbole müssen nach jedem Stilwechsel neu in die Karte geladen werden.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;
    void ensureMapIcons(map).then(() => {
      if (!cancelled) setIconEpoch((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || iconEpoch === 0) return;

    for (const [id, visible, data] of [
      ['aircraft', showAircraft, aircraftToGeoJson(aircraft)],
      ['vessels', showVessels, vesselsToGeoJson(vessels)],
      ['aprs', showAprs, aprsToGeoJson(aprs)],
    ] as const) {
      if (!visible) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        continue;
      }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        continue;
      }
      const style = SYMBOL_STYLE[id];
      map.addSource(id, { type: 'geojson', data });
      map.addLayer({
        id,
        type: 'symbol',
        source: id,
        minzoom: style.minzoom,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': style.size,
          'icon-rotate': ['get', 'rotate'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          // Beschriftung erst, wenn genug Platz ist — sonst wird es unruhig.
          'text-field': ['step', ['zoom'], '', style.labelZoom, ['get', 'label']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': '#1f2933',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });
    }
  }, [showAircraft, showVessels, showAprs, aircraft, vessels, aprs, ready, styleEpoch, iconEpoch]);

  // --- Windfeld: Strömungsbild + Beschriftung -----------------------------

  const windAnim = useRef<WindAnimation | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    const container = map?.getContainer();
    if (!map || !ready || !container) return;
    if (!showWind || windField.points.length === 0) {
      windAnim.current?.stop();
      windAnim.current = null;
      container.querySelector('.wind-canvas')?.remove();
      return;
    }

    // Canvas zwischen Kartenbild und Bedienelemente hängen.
    let canvas = container.querySelector<HTMLCanvasElement>('.wind-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'wind-canvas';
      container.insertBefore(canvas, container.querySelector('.maplibregl-control-container'));
    }
    const anim =
      windAnim.current ??
      new WindAnimation(canvas, map, (speed) => WIND_CLASSES.find((c) => speed < c.max)?.color ?? '#a92318');
    windAnim.current = anim;
    anim.setField(windField);
    anim.resize();

    // Beim Schwenken bleiben die Spuren sonst als Schlieren stehen.
    const redraw = () => anim.reset();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.on('move', redraw);
    map.on('resize', () => anim.resize());
    if (!still) anim.start();

    return () => {
      map.off('move', redraw);
      anim.stop();
    };
  }, [showWind, windField, ready, styleEpoch]);

  // Windgeschwindigkeit als Zahl an den Gitterpunkten
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!showWind || !windLabels || windField.points.length === 0) {
      if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
      if (map.getSource('wind-labels')) map.removeSource('wind-labels');
      return;
    }
    const data = windLabelsToGeoJson(windField.points);
    const src = map.getSource('wind-labels') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    map.addSource('wind-labels', { type: 'geojson', data });
    map.addLayer({
      id: 'wind-labels',
      type: 'symbol',
      source: 'wind-labels',
      minzoom: 6,
      layout: {
        'text-field': ['concat', ['get', 'label'], ' km/h'],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
        'text-halo-blur': 0.4,
      },
    });
  }, [showWind, windLabels, windField, ready, styleEpoch]);

  // Eigene Markierungen: Quelle + Layer anlegen (oberste Ebene)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('draw')) return;
    map.addSource('draw', { type: 'geojson', data: drawToGeoJson(drawFeatures, areaVertices) });
    map.addLayer({ id: 'draw-area-fill', type: 'fill', source: 'draw', filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': DRAW_COLOR, 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'draw-area-line', type: 'line', source: 'draw', filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-color': DRAW_COLOR, 'line-width': 2 } });
    map.addLayer({ id: 'draw-progress', type: 'line', source: 'draw', filter: ['==', ['get', 'kind'], 'progress'], paint: { 'line-color': DRAW_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] } });
    map.addLayer({ id: 'draw-vertex', type: 'circle', source: 'draw', filter: ['==', ['get', 'kind'], 'vertex'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': DRAW_COLOR, 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'draw-point', type: 'circle', source: 'draw', filter: ['==', ['get', 'kind'], 'point'], paint: { 'circle-radius': 7, 'circle-color': DRAW_COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'draw-label', type: 'symbol', source: 'draw', filter: ['in', ['get', 'kind'], ['literal', ['point', 'area']]], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' }, paint: { 'text-color': DRAW_COLOR, 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, styleEpoch]);

  // Markierungs-Daten aktualisieren
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('draw') as maplibregl.GeoJSONSource | undefined;
    src?.setData(drawToGeoJson(drawFeatures, areaVertices));
  }, [drawFeatures, areaVertices, ready, styleEpoch]);

  // Zeichen-Cursor
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = drawMode === 'off' ? '' : 'crosshair';
  }, [drawMode, ready]);

  // Daten-Marker (Verkehr, Pegel) neu aufbauen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    dataMarkers.current.forEach((m) => m.remove());
    dataMarkers.current = [];

    if (showTraffic) {
      for (const t of traffic) {
        if (!t.coordinates) continue;
        const color = t.kind === 'closure' ? 'var(--sev3)' : 'var(--sev2)';
        const m = new maplibregl.Marker({ element: markerEl(color, 13) })
          .setLngLat([t.coordinates.lon, t.coordinates.lat])
          .setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '300px' }).setHTML(trafficPopupHtml(t)))
          .addTo(map);
        dataMarkers.current.push(m);
      }
    }
    if (showPegel) {
      for (const p of pegel) {
        if (!p.coordinates) continue;
        const popup = new maplibregl.Popup({ offset: 12, maxWidth: '320px' }).setHTML(pegelPopupHtml(p));
        // Der Verlauf ist ein eigener Abruf — erst holen, wenn jemand hinschaut.
        if (p.id) {
          popup.on('open', () => {
            const known = pegelHistory.current.get(p.id!);
            if (known !== undefined) {
              popup.setHTML(pegelPopupHtml(p, known));
              return;
            }
            popup.setHTML(pegelPopupHtml(p, null, true));
            fetchPegelHistory(p.id!)
              .then((res) => {
                pegelHistory.current.set(p.id!, res.data);
                if (popup.isOpen()) popup.setHTML(pegelPopupHtml(p, res.data));
              })
              .catch(() => {
                pegelHistory.current.set(p.id!, null);
                if (popup.isOpen()) popup.setHTML(pegelPopupHtml(p, null));
              });
          });
        }
        const m = new maplibregl.Marker({ element: markerEl('var(--accent)', 12) })
          .setLngLat([p.coordinates.lon, p.coordinates.lat])
          .setPopup(popup)
          .addTo(map);
        dataMarkers.current.push(m);
      }
    }
  }, [traffic, pegel, showTraffic, showPegel, ready]);

  /* ---------- Haltestellen ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('stops')) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'stops',
      type: 'symbol',
      source: 'stops',
      minzoom: 12,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.32, 16, 0.5],
        'icon-allow-overlap': false,
        'text-field': ['step', ['zoom'], '', 13, ['get', 'label']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.05],
        'text-anchor': 'top',
        'text-optional': true,
        'text-max-width': 9,
        'text-padding': 3,
        // Bahnhöfe gewinnen, wenn sich Beschriftungen ins Gehege kommen.
        'symbol-sort-key': ['case', ['==', ['get', 'icon'], 'stop-rail'], 0, 1],
      },
      paint: {
        // Auf dunkler Karte helle Schrift mit dunklem Rand — sonst kleben die
        // Namen wie Aufkleber auf dem Hintergrund.
        'text-color': dark ? '#e7e7e9' : '#1f2933',
        'text-halo-color': dark ? '#0f0f10' : '#ffffff',
        'text-halo-width': 1.6,
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('stops') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showStops ? stops : []).map((s, i) => ({
        type: 'Feature',
        properties: {
          index: i,
          label: s.shortName ?? s.name,
          icon: STOP_ICON[s.kind] ?? 'stop-other',
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    });
  }, [stops, showStops, ready, styleEpoch]);

  // Antippen einer Haltestelle: Menü mit „Route hierher".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const stop = index != null ? stopsRef.current[index] : undefined;
      if (stop) onStopClickRef.current(stop);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', 'stops', onClick);
    map.on('mouseenter', 'stops', enter);
    map.on('mouseleave', 'stops', leave);
    return () => {
      map.off('click', 'stops', onClick);
      map.off('mouseenter', 'stops', enter);
      map.off('mouseleave', 'stops', leave);
    };
  }, [ready, styleEpoch]);

  /* ---------- Kurzwellen-Ausbreitung (MUF) ---------- */

  // Bild aus dem Gitter erzeugen und als Bildquelle über die Welt legen.
  const mufUrl = useMemo(() => (muf && showMuf ? mufToDataUrl(muf) : null), [muf, showMuf]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource('muf') as ImageSource | undefined;
    if (!mufUrl) {
      if (map.getLayer('muf')) map.removeLayer('muf');
      if (map.getSource('muf')) map.removeSource('muf');
      return;
    }
    if (source) {
      source.updateImage({ url: mufUrl, coordinates: MUF_BOUNDS });
      return;
    }
    map.addSource('muf', { type: 'image', url: mufUrl, coordinates: MUF_BOUNDS });
    map.addLayer(
      { id: 'muf', type: 'raster', source: 'muf', paint: { 'raster-opacity': 0.85 } },
      map.getLayer('warnings-fill') ? 'warnings-fill' : undefined,
    );
  }, [mufUrl, ready, styleEpoch]);

  // Verortete Meldungen als Symbolebene — Gefahren größer und zuoberst.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('news')) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addSource('news', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'news',
      type: 'symbol',
      source: 'news',
      layout: {
        'icon-image': ['get', 'icon'],
        // Deutlich größer als die Haltestellen — davon gibt es hunderte, von
        // den Meldungen nur wenige, und Gefahren sollen ins Auge springen.
        'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.66, 10, 0.95],
        'icon-allow-overlap': false,
        // Gefahren zuerst platzieren, damit sie beim Gedränge stehen bleiben.
        'symbol-sort-key': ['case', ['==', ['get', 'danger'], true], 0, 1],
        'text-field': ['step', ['zoom'], '', 8, ['get', 'place']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': dark ? '#e7e7e9' : '#1f2933',
        'text-halo-color': dark ? '#0f0f10' : '#ffffff',
        'text-halo-width': 1.5,
        'icon-opacity': ['case', ['==', ['get', 'approximate'], true], 0.75, 1],
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('news') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showNews ? news : [])
        .filter((n) => n.place)
        .map((n, i) => ({
          type: 'Feature',
          properties: {
            index: i,
            icon: `news-${n.category ?? 'other'}`,
            danger: n.category === 'danger',
            approximate: n.place!.approximate,
            place: n.place!.name,
          },
          geometry: { type: 'Point', coordinates: [n.place!.lon, n.place!.lat] },
        })),
    });
  }, [news, showNews, ready, styleEpoch]);

  // Antippen einer Meldung öffnet ihr Popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const located = () => news.filter((n) => n.place);
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const item = index != null ? located()[index] : undefined;
      if (item) warnPopup.current!.setLngLat(e.lngLat).setHTML(newsPopupHtml(item)).addTo(map);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', 'news', onClick);
    map.on('mouseenter', 'news', enter);
    map.on('mouseleave', 'news', leave);
    return () => {
      map.off('click', 'news', onClick);
      map.off('mouseenter', 'news', enter);
      map.off('mouseleave', 'news', leave);
    };
  }, [news, ready, styleEpoch]);

  // In den Einstellungen abgewählte Ebenen bleiben nicht heimlich an.
  const hiddenKey = hiddenLayers.join(',');
  useEffect(() => {
    if (!hiddenLayers.length) return;
    setOn((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of hiddenLayers) {
        if (id !== 'wind-labels' && next[id]) {
          next[id] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey]);

  /* ---------- Busse und Bahnen in Bewegung ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('vehicles')) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addSource('vehicles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'vehicles',
      type: 'symbol',
      source: 'vehicles',
      minzoom: 10,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.34, 15, 0.6],
        'icon-rotate': ['get', 'bearing'],
        // Fahrzeuge dürfen sich überlappen — sie stehen dicht beieinander und
        // ein ausgeblendeter Zug wäre irreführender als ein enges Bild.
        'icon-allow-overlap': true,
        'icon-rotation-alignment': 'map',
        'text-field': ['step', ['zoom'], '', 12, ['get', 'line']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': dark ? '#e7e7e9' : '#1f2933',
        'text-halo-color': dark ? '#0f0f10' : '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('vehicles') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showVehicles ? vehicles : []).map((v, i) => ({
        type: 'Feature',
        properties: {
          index: i,
          icon: `veh-${kindOfProduct(v.product)}`,
          bearing: v.bearing,
          line: v.line,
        },
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      })),
    });
  }, [vehicles, showVehicles, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const v = index != null ? vehicles[index] : undefined;
      if (v) onVehicleClickRef.current(v);
    };
    map.on('click', 'vehicles', onClick);
    return () => {
      map.off('click', 'vehicles', onClick);
    };
  }, [vehicles, ready, styleEpoch]);

  // Laufweg der geöffneten Fahrt: bis zum Fahrzeug blass, danach kräftig.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getSource('vehtrip')) {
      map.addSource('vehtrip', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'vehtrip-past',
        type: 'line',
        source: 'vehtrip',
        filter: ['==', ['get', 'past'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8b8b90', 'line-width': 3, 'line-dasharray': [1.5, 1.4] },
      });
      map.addLayer({
        id: 'vehtrip-ahead',
        type: 'line',
        source: 'vehtrip',
        filter: ['==', ['get', 'past'], false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 15, 7],
        },
      });
    }
    const src = map.getSource('vehtrip') as GeoJSONSource | undefined;
    if (!src) return;
    if (!vehicleTrip || vehicleTrip.geometry.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    // Trennpunkt ist der Stützpunkt, der dem Fahrzeug am nächsten liegt.
    const { geometry, at, color } = vehicleTrip;
    let split = 0;
    let best = Infinity;
    for (let i = 0; i < geometry.length; i++) {
      const d = (geometry[i]![0] - at.lon) ** 2 + (geometry[i]![1] - at.lat) ** 2;
      if (d < best) {
        best = d;
        split = i;
      }
    }
    const features: GeoJSON.Feature[] = [];
    if (split > 0) {
      features.push({
        type: 'Feature',
        properties: { past: true, color },
        geometry: { type: 'LineString', coordinates: geometry.slice(0, split + 1) },
      });
    }
    if (split < geometry.length - 1) {
      features.push({
        type: 'Feature',
        properties: { past: false, color },
        geometry: { type: 'LineString', coordinates: geometry.slice(split) },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }, [vehicleTrip, ready, styleEpoch]);

  // Den Rest der Fahrt auf Wunsch ins Bild rücken.
  const tripFitKey = vehicleTrip?.fitKey ?? 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !tripFitKey || !vehicleTrip) return;
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const [lon, lat] of vehicleTrip.geometry) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    if (west > east) return;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 60, duration: 700, maxZoom: 14 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripFitKey, ready]);

  /* ---------- Notfallpunkte aus dem Offline-Index ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('emergency')) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addSource('emergency', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'emergency',
      type: 'symbol',
      source: 'emergency',
      minzoom: 11,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 0.62],
        'icon-allow-overlap': false,
        'text-field': ['step', ['zoom'], '', 13, ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.15],
        'text-anchor': 'top',
        'text-optional': true,
        'text-max-width': 9,
        // Kliniken zuerst — im Notfall zählt die Reihenfolge.
        'symbol-sort-key': ['case', ['==', ['get', 'icon'], 'emg-hospital'], 0, 1],
      },
      paint: {
        'text-color': dark ? '#e7e7e9' : '#1f2933',
        'text-halo-color': dark ? '#0f0f10' : '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('emergency') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showEmergency ? emergency : []).map((p) => ({
        type: 'Feature',
        properties: {
          name: p.name,
          icon: EMERGENCY_ICON[p.category ?? ''] ?? 'emg-hospital',
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    });
  }, [emergency, showEmergency, ready, styleEpoch]);

  // Antippen eines Notfallpunktes: dasselbe Menü wie bei Haltestellen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const name = e.features?.[0]?.properties?.name as string | undefined;
      setPointMenu({
        x: e.point.x,
        y: e.point.y,
        lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng },
        label: name ?? null,
      });
    };
    map.on('click', 'emergency', onClick);
    return () => {
      map.off('click', 'emergency', onClick);
    };
  }, [ready, styleEpoch]);

  /* ---------- Behördenwarnungen (BBK/NINA) ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('nina')) return;
    map.addSource('nina', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'nina-fill',
      type: 'fill',
      source: 'nina',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 },
    });
    map.addLayer({
      id: 'nina-line',
      type: 'line',
      source: 'nina',
      filter: ['==', ['geometry-type'], 'Polygon'],
      // Gestrichelt: so ist die Behördenwarnung auch dort zu unterscheiden, wo
      // sie über einer DWD-Warnfläche liegt.
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 1.2] },
    });
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addLayer({
      id: 'nina',
      type: 'symbol',
      source: 'nina',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 11, 0.95],
        'icon-allow-overlap': true,
        'text-field': ['step', ['zoom'], '', 8, ['get', 'label']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-optional': true,
        'text-max-width': 11,
      },
      paint: {
        'text-color': dark ? '#e7e7e9' : '#1f2933',
        'text-halo-color': dark ? '#0f0f10' : '#ffffff',
        'text-halo-width': 1.6,
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('nina') as GeoJSONSource | undefined;
    if (!src) return;
    const list = showNina ? nina : [];
    const features: GeoJSON.Feature[] = [];
    list.forEach((w, index) => {
      const color = SEVERITY_COLOR[w.severity];
      features.push({
        type: 'Feature',
        properties: { index, color },
        geometry: w.geometry as GeoJSON.Geometry,
      });
      // Warndreieck in der Mitte der Fläche — kleine Gebiete (eine Straße)
      // wären als Fläche allein kaum zu sehen.
      const center = geometryCenter(w.geometry);
      if (center) {
        features.push({
          type: 'Feature',
          properties: {
            index,
            icon: `nina-${w.severity}`,
            label: w.channel,
          },
          geometry: { type: 'Point', coordinates: center },
        });
      }
    });
    src.setData({ type: 'FeatureCollection', features });
  }, [nina, showNina, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const w = index != null ? nina[index] : undefined;
      if (w) warnPopup.current!.setLngLat(e.lngLat).setHTML(civilWarningPopupHtml(w)).addTo(map);
    };
    for (const id of ['nina', 'nina-fill']) map.on('click', id, onClick);
    return () => {
      for (const id of ['nina', 'nina-fill']) map.off('click', id, onClick);
    };
  }, [nina, ready, styleEpoch]);

  /* ---------- Blitze ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('lightning')) return;
    map.addSource('lightning', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // Zwei Ebenen: ein heller Kern und ein weicher Schein — so sind auch
    // einzelne Entladungen auf hellem wie dunklem Grund zu sehen.
    map.addLayer({
      id: 'lightning-glow',
      type: 'circle',
      source: 'lightning',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'age'], 0, 13, 1, 5],
        'circle-color': '#e3b505',
        'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.35, 1, 0.06],
        'circle-blur': 0.9,
      },
    });
    map.addLayer({
      id: 'lightning',
      type: 'circle',
      source: 'lightning',
      paint: {
        // Frische Blitze sind größer und weiß-gelb, ältere klein und blass —
        // die Alterung ist damit auch ohne Farbsehen erkennbar.
        'circle-radius': ['interpolate', ['linear'], ['get', 'age'], 0, 5, 1, 2],
        'circle-color': [
          'interpolate',
          ['linear'],
          ['get', 'age'],
          0,
          '#fff6c9',
          0.25,
          '#e3b505',
          1,
          '#8a6a12',
        ],
        'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 1, 0.45],
        'circle-stroke-width': ['interpolate', ['linear'], ['get', 'age'], 0, 1.4, 1, 0],
        'circle-stroke-color': '#ffffff',
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('lightning') as GeoJSONSource | undefined;
    if (!src) return;
    const now = Date.now();
    src.setData({
      type: 'FeatureCollection',
      features: (showLightning ? lightning : []).map((s, i) => ({
        type: 'Feature',
        properties: {
          index: i,
          // 0 = eben erst, 1 = am Ende des Zeitfensters (30 Minuten).
          age: Math.max(0, Math.min(1, (now - Date.parse(s.time)) / (30 * 60_000))),
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    });
  }, [lightning, showLightning, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const s = index != null ? lightning[index] : undefined;
      if (s) warnPopup.current!.setLngLat(e.lngLat).setHTML(lightningPopupHtml(s)).addTo(map);
    };
    map.on('click', 'lightning', onClick);
    return () => {
      map.off('click', 'lightning', onClick);
    };
  }, [lightning, ready, styleEpoch]);

  /* ---------- Rastanlagen, Ladepunkte und Webcams ---------- */

  // Beide sind Punktebenen mit Piktogramm und werden gleich aufgebaut.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    for (const id of ['rest', 'webcams'] as const) {
      if (map.getSource(id)) continue;
      map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id,
        type: 'symbol',
        source: id,
        minzoom: id === 'rest' ? 8 : 5,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.36, 14, 0.58],
          'icon-allow-overlap': false,
          'text-field': ['step', ['zoom'], '', 11, ['get', 'label']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
          'text-max-width': 9,
        },
        paint: {
          'text-color': dark ? '#e7e7e9' : '#1f2933',
          'text-halo-color': dark ? '#0f0f10' : '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    }
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('rest') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showRest ? rest : []).map((f, i) => ({
        type: 'Feature',
        properties: {
          index: i,
          icon: f.kind === 'charging' ? 'rest-charging' : 'rest-parking',
          label: f.title,
        },
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      })),
    });
  }, [rest, showRest, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('webcams') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showWebcams ? webcams : []).map((w, i) => ({
        type: 'Feature',
        properties: {
          index: i,
          icon: w.offline ? 'webcam-off' : 'webcam-spot',
          label: w.name,
        },
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
      })),
    });
  }, [webcams, showWebcams, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onRest = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const f = index != null ? rest[index] : undefined;
      if (f) warnPopup.current!.setLngLat(e.lngLat).setHTML(restPopupHtml(f)).addTo(map);
    };
    const onCam = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const w = index != null ? webcams[index] : undefined;
      if (w) warnPopup.current!.setLngLat(e.lngLat).setHTML(webcamPopupHtml(w)).addTo(map);
    };
    map.on('click', 'rest', onRest);
    map.on('click', 'webcams', onCam);
    return () => {
      map.off('click', 'rest', onRest);
      map.off('click', 'webcams', onCam);
    };
  }, [rest, webcams, ready, styleEpoch]);

  /* ---------- Feuer aus dem Satellitenblick ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('fires')) return;
    map.addSource('fires', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'fires',
      type: 'circle',
      source: 'fires',
      paint: {
        // Größe nach Strahlungsleistung: ein Schwelbrand ist kein Flächenbrand.
        'circle-radius': ['interpolate', ['linear'], ['get', 'frp'], 0, 3.5, 20, 6, 100, 11, 400, 18],
        'circle-color': [
          'interpolate',
          ['linear'],
          ['get', 'frp'],
          0,
          '#e0a90b',
          30,
          '#e0521f',
          150,
          '#a92318',
        ],
        'circle-opacity': 0.8,
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff',
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('fires') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showFires ? fires : []).map((f, i) => ({
        type: 'Feature',
        properties: { index: i, frp: f.frpMW },
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      })),
    });
  }, [fires, showFires, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const f = index != null ? fires[index] : undefined;
      if (f) warnPopup.current!.setLngLat(e.lngLat).setHTML(firePopupHtml(f)).addTo(map);
    };
    map.on('click', 'fires', onClick);
    return () => {
      map.off('click', 'fires', onClick);
    };
  }, [fires, ready, styleEpoch]);

  /* ---------- Ortsdosisleistung (Strahlung) ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('radiation')) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    map.addSource('radiation', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'radiation',
      type: 'circle',
      source: 'radiation',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 8],
        // Der natürliche Untergrund liegt bei 0,05–0,18 µSv/h; erst darüber
        // wird die Farbe warm. Die Werte stehen zusätzlich im Popup.
        'circle-color': [
          'interpolate',
          ['linear'],
          ['get', 'value'],
          0.05,
          '#3f8f4a',
          0.15,
          '#7a5cc0',
          0.3,
          '#e0a90b',
          1,
          '#a92318',
        ],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1,
        'circle-stroke-color': dark ? '#0f0f10' : '#ffffff',
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('radiation') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showRadiation ? radiation : []).map((s, i) => ({
        type: 'Feature',
        properties: { index: i, value: s.microSievertPerHour },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    });
  }, [radiation, showRadiation, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const s = index != null ? radiation[index] : undefined;
      if (s) warnPopup.current!.setLngLat(e.lngLat).setHTML(radiationPopupHtml(s)).addTo(map);
    };
    map.on('click', 'radiation', onClick);
    return () => {
      map.off('click', 'radiation', onClick);
    };
  }, [radiation, ready, styleEpoch]);

  /* ---------- Erdbeben ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('quakes')) return;
    map.addSource('quakes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'quakes',
      type: 'circle',
      source: 'quakes',
      paint: {
        // Fläche nach Stärke: ein Beben der Stärke 7 ist kein Punkt wie ein 2,5er.
        'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 4, 5, 9, 7, 18, 9, 30],
        'circle-color': [
          'interpolate',
          ['linear'],
          ['get', 'mag'],
          2.5,
          '#e3b505',
          5,
          '#e07b12',
          6.5,
          '#a92318',
        ],
        'circle-opacity': 0.55,
        'circle-stroke-width': 1.2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('quakes') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (showQuakes ? quakes : []).map((q, i) => ({
        type: 'Feature',
        properties: { index: i, mag: q.magnitude },
        geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
      })),
    });
  }, [quakes, showQuakes, ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const index = e.features?.[0]?.properties?.index as number | undefined;
      const q = index != null ? quakes[index] : undefined;
      if (q) warnPopup.current!.setLngLat(e.lngLat).setHTML(quakePopupHtml(q)).addTo(map);
    };
    map.on('click', 'quakes', onClick);
    return () => {
      map.off('click', 'quakes', onClick);
    };
  }, [quakes, ready, styleEpoch]);

  /* ---------- Waldbrandgefahr und Polarlicht als Flächen ---------- */

  const fireUrl = useMemo(() => (fire && showFire ? fireToDataUrl(fire) : null), [fire, showFire]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const bounds = fire ? fireBounds(fire) : null;
    const source = map.getSource('fire') as ImageSource | undefined;
    if (!fireUrl || !bounds) {
      if (map.getLayer('fire')) map.removeLayer('fire');
      if (map.getSource('fire')) map.removeSource('fire');
      return;
    }
    if (source) {
      source.updateImage({ url: fireUrl, coordinates: bounds });
      return;
    }
    map.addSource('fire', { type: 'image', url: fireUrl, coordinates: bounds });
    map.addLayer(
      { id: 'fire', type: 'raster', source: 'fire', paint: { 'raster-opacity': 0.75 } },
      map.getLayer('warnings-fill') ? 'warnings-fill' : undefined,
    );
  }, [fireUrl, ready, styleEpoch]);

  const auroraUrl = useMemo(
    () => (aurora && showAurora ? auroraToDataUrl(aurora) : null),
    [aurora, showAurora],
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource('aurora') as ImageSource | undefined;
    if (!auroraUrl) {
      if (map.getLayer('aurora')) map.removeLayer('aurora');
      if (map.getSource('aurora')) map.removeSource('aurora');
      return;
    }
    if (source) {
      source.updateImage({ url: auroraUrl, coordinates: AURORA_BOUNDS });
      return;
    }
    map.addSource('aurora', { type: 'image', url: auroraUrl, coordinates: AURORA_BOUNDS });
    map.addLayer(
      { id: 'aurora', type: 'raster', source: 'aurora', paint: { 'raster-opacity': 0.9 } },
      map.getLayer('warnings-fill') ? 'warnings-fill' : undefined,
    );
  }, [auroraUrl, ready, styleEpoch]);

  // Auf einen Punkt schwenken (Nachrichtenliste, Suchtreffer).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTo) return;
    map.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 9, speed: 1.4 });
  }, [flyTo, ready]);

  // Großkreis der bewerteten Funkstrecke.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!map.getSource('hfpath')) {
      map.addSource('hfpath', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'hfpath',
        type: 'line',
        source: 'hfpath',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#a4218c', 'line-width': 3, 'line-dasharray': [2, 1.2] },
      });
    }
    const src = map.getSource('hfpath') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: hfPath
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: hfPath } }]
        : [],
    });
  }, [hfPath, ready, styleEpoch]);

  /* ---------- ÖPNV-Verbindung ---------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('plan')) return;
    map.addSource('plan', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'plan-walk',
      type: 'line',
      source: 'plan',
      filter: ['==', ['get', 'walk'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#5b5b60',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 6],
        'line-dasharray': [1.6, 1.4],
      },
    });
    map.addLayer({
      id: 'plan-ride',
      type: 'line',
      source: 'plan',
      filter: ['==', ['get', 'walk'], false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9],
      },
    });
  }, [ready, styleEpoch]);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('plan') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (itinerary?.legs ?? [])
        .filter((leg) => leg.geometry.length > 1)
        .map((leg) => ({
          type: 'Feature',
          properties: {
            walk: leg.mode === 'WALK',
            color: STOP_COLOR[kindOfProduct(leg.product)] ?? '#1d4e73',
          },
          geometry: { type: 'LineString', coordinates: leg.geometry },
        })),
    });
  }, [itinerary, ready, styleEpoch]);

  // Verbindung ins Bild rücken.
  const planKey = itinerary ? `${itinerary.startTime}:${itinerary.legs.length}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !itinerary) return;
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const leg of itinerary.legs) {
      for (const [lon, lat] of leg.geometry) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    if (west > east) return;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: { top: 60, bottom: 200, left: 50, right: 50 }, duration: 800, maxZoom: 15 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, ready]);

  /* ---------- Route: Linie, Marken, Kamera ---------- */

  // Quelle und Linien einmal je Style anlegen (oben auf allen Ebenen).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || map.getSource('route')) return;
    // Varianten liegen unter der gewählten Route.
    map.addSource('route-alt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-alt-line',
      type: 'line',
      source: 'route-alt',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#8b93a1',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 12],
        'line-opacity': 0.85,
      },
    });
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#0b2b45',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 12, 18, 20],
        'line-opacity': 0.85,
      },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ROUTE_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7, 18, 13],
      },
    });
  }, [ready, styleEpoch]);

  // Varianten zeichnen (mit ihrem Index, damit ein Klick sie auswählt)
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('route-alt') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: alternatives.map((a) => ({
        type: 'Feature',
        properties: { index: a.index },
        geometry: { type: 'LineString', coordinates: a.route.coordinates },
      })),
    });
  }, [alternatives, ready, styleEpoch]);

  // Antippen einer grauen Linie wählt diese Variante.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const index = e.features?.[0]?.properties?.index;
      if (typeof index === 'number') onSelectRouteRef.current(index);
    };
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    map.on('click', 'route-alt-line', onClick);
    map.on('mouseenter', 'route-alt-line', enter);
    map.on('mouseleave', 'route-alt-line', leave);
    return () => {
      map.off('click', 'route-alt-line', onClick);
      map.off('mouseenter', 'route-alt-line', enter);
      map.off('mouseleave', 'route-alt-line', leave);
    };
  }, [ready, styleEpoch]);

  // Geometrie aktualisieren
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('route') as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      route
        ? {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coordinates } }],
          }
        : { type: 'FeatureCollection', features: [] },
    );
  }, [route, ready, styleEpoch]);

  // Start-, Ziel- und Suchmarke (HTML-Marker überstehen Style-Wechsel).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of routeMarkers.current) m.remove();
    routeMarkers.current = [];
    const add = (point: Coords, cls: string, label?: string) => {
      const el = document.createElement('div');
      el.className = `mk-route ${cls}`;
      if (label) el.title = label;
      routeMarkers.current.push(
        new maplibregl.Marker({ element: el, anchor: cls === 'mk-pin' ? 'bottom' : 'center' })
          .setLngLat([point.lon, point.lat])
          .addTo(map),
      );
    };
    if (route) {
      add(route.snappedStart, 'mk-start', 'Start');
      add(route.snappedEnd, 'mk-end', 'Ziel');
    } else if (pin) {
      add({ lat: pin.lat, lon: pin.lon }, 'mk-pin', pin.name);
    }
    if (routeOrigin && !route) add(routeOrigin, 'mk-start', 'Start');
  }, [route, pin, routeOrigin, ready]);

  // Zielführung: Position folgen, Karte in Fahrtrichtung drehen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!navigating || !navPosition) {
      navMarker.current?.remove();
      navMarker.current = null;
      return;
    }
    if (!navMarker.current) {
      const el = document.createElement('div');
      el.className = 'mk mk-nav';
      navMarker.current = new maplibregl.Marker({ element: el });
    }
    navMarker.current.setLngLat([navPosition.lon, navPosition.lat]).addTo(map);
    map.easeTo({
      center: [navPosition.lon, navPosition.lat],
      zoom: Math.max(map.getZoom(), 16),
      bearing: navBearing ?? map.getBearing(),
      pitch: 50,
      duration: 900,
    });
  }, [navigating, navPosition, navBearing, ready]);

  // Nach dem Beenden wieder flach und nach Norden ausrichten.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || navigating) return;
    if (map.getPitch() !== 0 || map.getBearing() !== 0) {
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }, [navigating, ready]);

  // Ganze Route ins Bild rücken, sobald eine neue berechnet wurde.
  const routeKey = route ? `${route.distanceM}:${route.coordinates.length}:${route.profile}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !route || navigating || !route.coordinates.length) return;
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const [lon, lat] of route.coordinates) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: { top: 60, bottom: 180, left: 50, right: 50 }, duration: 800, maxZoom: 16 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, ready]);

  // Eigene Markierungen antippen: Menü mit „Route hierher".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawModeRef.current !== 'off' || pickingRef.current) return;
      const name = e.features?.[0]?.properties?.name as string | undefined;
      setPointMenu({
        x: e.point.x,
        y: e.point.y,
        lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng },
        label: name ?? null,
      });
    };
    for (const layer of ['draw-point', 'draw-area-fill']) map.on('click', layer, onClick);
    return () => {
      for (const layer of ['draw-point', 'draw-area-fill']) map.off('click', layer, onClick);
    };
  }, [ready, styleEpoch]);

  // Langes Antippen / rechte Maustaste öffnet das Punktmenü.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onContext = (e: MapMouseEvent) => {
      if (drawModeRef.current !== 'off') return;
      e.preventDefault();
      setPointMenu({ x: e.point.x, y: e.point.y, lngLat: { lat: e.lngLat.lat, lon: e.lngLat.lng } });
    };
    const close = () => setPointMenu(null);
    // Klicks auf Haltestellen oder eigene Markierungen öffnen das Menü — dieser
    // allgemeine Handler läuft danach und darf es nicht sofort wieder zumachen.
    const closeOnClick = (e: MapMouseEvent) => {
      const layers = ['stops', 'emergency', 'draw-point', 'draw-area-fill'].filter((id) =>
        map.getLayer(id),
      );
      if (layers.length && map.queryRenderedFeatures(e.point, { layers }).length) return;
      setPointMenu(null);
    };
    map.on('contextmenu', onContext);
    map.on('movestart', close);
    map.on('click', closeOnClick);
    return () => {
      map.off('contextmenu', onContext);
      map.off('movestart', close);
      map.off('click', closeOnClick);
    };
  }, [ready]);

  const finishArea = () => {
    if (areaVertices.length >= 3) {
      const ring: [number, number][] = [...areaVertices, areaVertices[0]!];
      setPending({
        kind: 'area',
        geometry: { type: 'Polygon', coordinates: [ring] },
        defaultName: `Fläche ${drawCount.current.area + 1}`,
      });
      return; // Ecken bleiben sichtbar, bis der Name steht.
    }
    setAreaVertices([]);
    setDrawMode('off');
  };
  const cancelArea = () => {
    setAreaVertices([]);
    setDrawMode('off');
  };

  /** Benannte Markierung übernehmen (bzw. beim Verwerfen aufräumen). */
  const resolvePending = (name: string | null) => {
    if (name && pending) {
      setDrawFeatures((prev) => [
        ...prev,
        { id: newId(), name, kind: pending.kind, geometry: pending.geometry },
      ]);
    }
    if (pending?.kind === 'area') {
      setAreaVertices([]);
      setDrawMode('off');
    }
    setPending(null);
  };

  const curFrame = timeline[Math.min(radarIdx, timeline.length - 1)];
  const forecastStart = timeline.findIndex((f) => f.forecast);

  // Inhalt des Ebenen-Menüs: Namen, Farben und Gruppen stehen im Verzeichnis
  // (layerCatalog.ts), hier kommen nur Schaltzustand und das dazu, was von
  // Schlüsseln, geladenen Regionen oder den Einstellungen abhängt.
  const active: Record<LayerRowId, boolean> = { ...on, 'wind-labels': windLabels };
  const availability = {
    flow: flowAvailable,
    ais: aisAvailable,
    aprs: aprsAvailable,
    lightning: lightningAvailable,
  };
  const hidden = new Set(hiddenLayers);
  const layerOptions: LayerOption[] = LAYER_CATALOG.filter((l) => {
    if (hidden.has(l.id)) return false;
    if (l.needs && !availability[l.needs]) return false;
    // Die Windwerte sind eine Anzeigeoption der Windebene — ohne sie sinnlos.
    if (l.id === 'wind-labels') return showWind;
    return true;
  }).map((l) => ({
    id: l.id,
    label: l.label,
    color: l.color,
    group: l.group,
    hint:
      l.id === 'stops' && !stopsAvailable
        ? 'Region unter „Offline" laden'
        : l.id === 'aprs'
          ? aprsTargets.length
            ? `${aprsTargets.length} Rufzeichen`
            : 'Rufzeichen eintragen'
          : l.hint,
    active: active[l.id] ?? false,
    ...(l.sub ? { sub: true } : {}),
    ...(l.id === 'aprs'
      ? { onEdit: () => setAprsOpen(true), editLabel: 'Rufzeichen verwalten' }
      : {}),
  }));

  return (
    <>
      <div className="mapwrap">
        <div ref={containerRef} className="lagemap" />
        <div className="mapcontrols">
        {vehicleTrip && (
          // Solange ein Laufweg auf der Karte liegt, muss er auch wieder
          // wegzubekommen sein — sonst bleibt die Linie für immer stehen.
          <div className="tripbar">
            <button type="button" className="tb-open" onClick={onTripOpen}>
              <span className="tb-dot" style={{ background: vehicleTrip.color }} />
              Laufweg {vehicleTrip.label}
            </button>
            <button type="button" className="tb-clear" onClick={onTripClear} aria-label="Laufweg ausblenden">
              ✕
            </button>
          </div>
        )}
        <div className="maptools">
          <LayerMenu
            options={layerOptions}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onToggle={(id) =>
              id === 'wind-labels' ? setWindLabels((v) => !v) : toggleLayer(id as LayerId)
            }
            onAllOff={() => setOn({ ...ALL_LAYERS_OFF })}
            footer={
              <span className="lm-credit">
                Flüge: adsb.lol · Schiffe: aisstream.io · Haltestellen:{' '}
                <a href="https://transitous.org/" target="_blank" rel="noreferrer">
                  transitous.org
                </a>{' '}
                · Funk:{' '}
                <a href="https://aprs.fi/" target="_blank" rel="noreferrer">
                  aprs.fi
                </a>{' '}
                · Ausbreitung:{' '}
                <a href="https://prop.kc2g.com/" target="_blank" rel="noreferrer">
                  prop.kc2g.com
                </a>{' '}
                (GIRO) und{' '}
                <a href="https://www.hamqsl.com/solar.html" target="_blank" rel="noreferrer">
                  N0NBH
                </a>
              </span>
            }
          />
          <button
            type="button"
            className="chip"
            aria-pressed={drawBarOpen}
            onClick={() =>
              setDrawBarOpen((v) => {
                if (v) {
                  setDrawMode('off');
                  setAreaVertices([]);
                }
                return !v;
              })
            }
          >
            <span className="k" style={{ background: DRAW_COLOR }} />
            Markieren
          </button>
        </div>

        {drawBarOpen && (
          <div className="drawbar">
            <button type="button" className="chip" aria-pressed={drawMode === 'point'} onClick={() => setDrawMode((m) => (m === 'point' ? 'off' : 'point'))}>
              Punkt
            </button>
            <button type="button" className="chip" aria-pressed={drawMode === 'area'} onClick={() => setDrawMode((m) => (m === 'area' ? 'off' : 'area'))}>
              Fläche
            </button>
            {drawMode === 'area' && areaVertices.length > 0 && (
              <>
                <button type="button" className="chip chip-ok" onClick={finishArea} disabled={areaVertices.length < 3}>
                  Fertig
                </button>
                <button type="button" className="chip" onClick={cancelArea}>
                  Abbrechen
                </button>
              </>
            )}
            <button type="button" className="chip" onClick={() => setListOpen(true)}>
              Liste ({drawFeatures.length})
            </button>
            {drawMode !== 'off' && (
              <span className="drawhint">{drawMode === 'point' ? 'Karte antippen für Punkt' : 'Ecken antippen, dann „Fertig"'}</span>
            )}
          </div>
        )}
        </div>

        <button
          type="button"
          className="loc-btn"
          aria-label="Zurück zum Standort"
          title="Zurück zum Standort"
          onClick={() => mapRef.current?.flyTo({ center: [coords.lon, coords.lat], zoom: 11, speed: 1.6 })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>

        {pointMenu && (
          <div className="pointmenu" style={{ left: pointMenu.x, top: pointMenu.y }} role="menu">
            {pointMenu.label && <div className="pm-title">{pointMenu.label}</div>}
            <button
              type="button"
              onClick={() => {
                onPickPoint(pointMenu.lngLat, 'destination', pointMenu.label ?? undefined);
                setPointMenu(null);
              }}
            >
              Route hierher
            </button>
            <button
              type="button"
              onClick={() => {
                onPickPoint(pointMenu.lngLat, 'origin', pointMenu.label ?? undefined);
                setPointMenu(null);
              }}
            >
              Als Start setzen
            </button>
            <button
              type="button"
              onClick={() => {
                onPickPoint(pointMenu.lngLat, 'place', pointMenu.label ?? undefined);
                setPointMenu(null);
              }}
            >
              Hierher wechseln
            </button>
            <button
              type="button"
              onClick={() => {
                onPickPoint(pointMenu.lngLat, 'radio', pointMenu.label ?? undefined);
                setPointMenu(null);
              }}
            >
              Funkstrecke prüfen
            </button>
          </div>
        )}

        <div className="legends">
          {showWarnings && (
            <div className="legend" role="group" aria-label="Warnstufen filtern">
              <span className="legend-title">Warnstufen</span>
              {ALL_SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="legend-item"
                  aria-pressed={activeSev.has(s)}
                  title={SEVERITY_DE[s]}
                  onClick={() =>
                    setActiveSev((prev) => {
                      const next = new Set(prev);
                      if (next.has(s)) next.delete(s);
                      else next.add(s);
                      return next;
                    })
                  }
                >
                  <span className="k" style={{ background: SEVERITY_COLOR[s] }} />
                  {SEVERITY_DE[s]}
                </button>
              ))}
            </div>
          )}
          {showWind && (
            <div className="legend" aria-label="Windstärke">
              <span className="legend-title">Wind km/h</span>
              <div className="radar-scale">
                {WIND_CLASSES.map((c, i) => (
                  <span key={c.id} className="rs-step" title={c.label}>
                    <i style={{ background: c.color }} />
                    {c.max === Infinity ? `>${WIND_CLASSES[i - 1]!.max}` : `<${c.max}`}
                  </span>
                ))}
              </div>
            </div>
          )}
          {showMuf && (
            <div className="legend" aria-label="Höchste brauchbare Frequenz">
              <span className="legend-title">MUF · offene Bänder</span>
              <div className="radar-scale">
                {MUF_SCALE.map((step) => (
                  <span key={step.band} className="rs-step" title={`ab ${step.min} MHz`}>
                    <i style={{ background: step.color }} />
                    {step.band}
                  </span>
                ))}
              </div>
            </div>
          )}
          {showFire && (
            <div className="legend" aria-label="Waldbrandgefahrenindex">
              <span className="legend-title">Waldbrandgefahr</span>
              <div className="radar-scale">
                {FIRE_LEVELS.map((step) => (
                  <span key={step.min} className="rs-step" title={`Stufe ${step.min}`}>
                    <i style={{ background: step.color }} />
                    {step.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {showLightning && (
            <div className="legend" aria-label="Blitze nach Alter">
              <span className="legend-title">Blitze</span>
              <div className="radar-scale">
                <span className="rs-step">
                  <i style={{ background: '#fff6c9', border: '1px solid #b58a10' }} />
                  eben
                </span>
                <span className="rs-step">
                  <i style={{ background: '#e3b505' }} />
                  10 min
                </span>
                <span className="rs-step">
                  <i style={{ background: '#8a6a12' }} />
                  30 min
                </span>
              </div>
            </div>
          )}
          {showRadiation && (
            <div className="legend" aria-label="Ortsdosisleistung">
              <span className="legend-title">Strahlung</span>
              <div className="radar-scale">
                <span className="rs-step">
                  <i style={{ background: '#3f8f4a' }} />
                  0,05
                </span>
                <span className="rs-step">
                  <i style={{ background: '#7a5cc0' }} />
                  0,15
                </span>
                <span className="rs-step">
                  <i style={{ background: '#e0a90b' }} />
                  0,3
                </span>
                <span className="rs-step">
                  <i style={{ background: '#a92318' }} />
                  ab 1 µSv/h
                </span>
              </div>
            </div>
          )}
          {showFires && (
            <div className="legend" aria-label="Feuer aus dem Satellitenblick">
              <span className="legend-title">Feuer MW</span>
              <div className="radar-scale">
                <span className="rs-step">
                  <i style={{ background: '#e0a90b' }} />
                  klein
                </span>
                <span className="rs-step">
                  <i style={{ background: '#e0521f' }} />
                  30
                </span>
                <span className="rs-step">
                  <i style={{ background: '#a92318' }} />
                  ab 150
                </span>
              </div>
            </div>
          )}
          {showQuakes && (
            <div className="legend" aria-label="Erdbebenstärke">
              <span className="legend-title">Erdbeben</span>
              <div className="radar-scale">
                {[
                  { mag: '2,5–4', color: '#e3b505' },
                  { mag: '5', color: '#e07b12' },
                  { mag: 'ab 6,5', color: '#a92318' },
                ].map((step) => (
                  <span key={step.mag} className="rs-step">
                    <i style={{ background: step.color }} />
                    {step.mag}
                  </span>
                ))}
              </div>
            </div>
          )}
          {showAurora && aurora && (
            <div className="legend" aria-label="Polarlicht-Wahrscheinlichkeit">
              <span className="legend-title">Polarlicht</span>
              <div className="radar-scale">
                <span className="rs-step">
                  <i style={{ background: 'rgba(60,186,122,0.35)' }} />
                  gering
                </span>
                <span className="rs-step">
                  <i style={{ background: 'rgba(60,186,122,0.95)' }} />
                  hoch
                </span>
                <span className="rs-step">bis {Math.round(aurora.maxPercent)} %</span>
              </div>
            </div>
          )}
          {showRadar && useDwd && (
            <div className="legend" aria-label="Regenmenge in Millimeter pro Stunde">
              <span className="legend-title">Regen mm/h</span>
              <div className="radar-scale">
                {RADAR_LEGEND.map((step) => (
                  <span key={step.label} className="rs-step">
                    <i style={{ background: step.color }} />
                    {step.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showRadar && timeline.length > 0 && (
        <div className="radarbar" role="group" aria-label="Regenradar-Zeitleiste">
          <button
            type="button"
            className="play"
            aria-label={radarPlaying ? 'Pause' : 'Abspielen'}
            onClick={() => setRadarPlaying((p) => !p)}
          >
            {radarPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>
          <div className="rtrack">
            <input
              type="range"
              min={0}
              max={timeline.length - 1}
              value={Math.min(radarIdx, timeline.length - 1)}
              onChange={(e) => {
                setRadarPlaying(false);
                setRadarIdx(Number(e.target.value));
              }}
              aria-label="Zeitpunkt"
            />
            {/* Ab hier ist alles Vorhersage. */}
            {forecastStart > 0 && (
              <span className="rnow" style={{ left: `${(forecastStart / (timeline.length - 1)) * 100}%` }} />
            )}
          </div>
          <div className="rtime">
            {curFrame ? radarTimeLabel(curFrame.timeSec, curFrame.forecast) : ''}
            <span className="rsrc">{useDwd ? 'DWD · bis +2 h' : 'RainViewer'}</span>
          </div>
        </div>
      )}

      {aprsOpen && (
        <AprsTargets
          targets={aprsTargets}
          stations={aprs}
          onChange={setAprsTargets}
          onClose={() => setAprsOpen(false)}
        />
      )}

      {pending && (
        <NamePrompt
          title={pending.kind === 'point' ? 'Neuer Punkt' : 'Neue Fläche'}
          defaultName={pending.defaultName}
          onSave={(name) => resolvePending(name)}
          onCancel={() => resolvePending(null)}
        />
      )}

      {listOpen && (
        <DrawList
          features={drawFeatures}
          onRename={(id, name) => setDrawFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)))}
          onDelete={(id) => setDrawFeatures((prev) => prev.filter((f) => f.id !== id))}
          onClear={() => {
            setDrawFeatures([]);
            setListOpen(false);
          }}
          onClose={() => setListOpen(false)}
        />
      )}
    </>
  );
}
