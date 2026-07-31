import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type Map as MlMap,
  type Marker,
  type Popup as MlPopup,
  type FilterSpecification,
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
  Vessel,
} from '@lagebild/shared';
import type { Bbox } from './api.js';
import { registerPmtiles, buildStyle, addLocalPmtiles, ONLINE_PMTILES_URL } from './mapStyle.js';
import { getOfflineFile } from './offlineMaps.js';
import { DrawList } from './DrawList.js';
import { NamePrompt } from './NamePrompt.js';
import { loadDraw, saveDraw, newId, type DrawFeature, type DrawGeometry } from './drawStore.js';
import { inflateGrid, gridToDataUrl, radarSupported, RADAR_LEGEND } from './radarGrid.js';
import { ensureMapIcons } from './mapIcons.js';
import { shadowPolygon, CIVIL_TWILIGHT } from './sun.js';
import { SEVERITY_DE, TRAFFIC_DE, VESSEL_DE, VESSEL_STATUS_DE, formatDateTime, radarTimeLabel, timeHM } from './format.js';

const DRAW_COLOR = '#0d9488';
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

function pegelPopupHtml(p: WaterLevel): string {
  const level = p.levelCm != null ? `${p.levelCm} cm` : '–';
  return (
    `<div class="warn-popup">` +
    `<b>${esc(p.station)}</b>` +
    (p.water ? `<div class="wp-region">${esc(p.water)}</div>` : '') +
    `<p class="wp-desc">Wasserstand: ${esc(level)}${p.measuredAt ? ` · ${esc(formatDateTime(p.measuredAt))}` : ''}</p>` +
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

function aircraftPopupHtml(a: Aircraft): string {
  const alt = a.onGround ? 'am Boden' : a.altitudeFt != null ? `${a.altitudeFt.toLocaleString('de-DE')} ft` : '–';
  const climb =
    a.verticalRateFpm != null && Math.abs(a.verticalRateFpm) >= 100
      ? ` (${a.verticalRateFpm > 0 ? '↑' : '↓'} ${Math.abs(Math.round(a.verticalRateFpm))} ft/min)`
      : '';
  const emergency =
    a.emergency === 'hijack'
      ? 'Entführung (7500)'
      : a.emergency === 'radio-failure'
        ? 'Funkausfall (7600)'
        : a.emergency === 'general'
          ? 'Luftnotfall (7700)'
          : null;
  return (
    `<div class="warn-popup">` +
    (emergency ? `<span class="wp-sev" style="background:#a92318">${esc(emergency)}</span>` : '') +
    `<b>${esc(a.callsign ?? a.registration ?? a.icao.toUpperCase())}</b>` +
    `<div class="wp-region">${esc([a.description ?? a.type, a.registration].filter(Boolean).join(' · ') || 'Unbekanntes Muster')}</div>` +
    `<p class="wp-desc">Höhe ${esc(alt)}${esc(climb)}<br>` +
    `Tempo ${a.groundSpeedKt != null ? `${Math.round(a.groundSpeedKt)} kn` : '–'} · ` +
    `Kurs ${a.trackDeg != null ? `${Math.round(a.trackDeg)}°` : '–'}</p>` +
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
        icon: a.emergency ? 'plane-alert' : a.onGround ? 'plane-ground' : 'plane-air',
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
  flowAvailable: boolean;
  /** true, wenn der Server einen AIS-Stream hat (sonst kein Schiffs-Chip). */
  aisAvailable: boolean;
  /** Wenn gesetzt: Basiskarte aus dieser Offline-Region (OPFS) statt online. */
  offlineCode: string | null;
  onViewport: (b: Bbox) => void;
  /** Meldet die aktiven Live-Ebenen — diese Daten werden erst dann geladen. */
  onLayersChange: (active: ActiveLayers) => void;
}

/** Ebenen, deren Daten nur bei Bedarf geholt werden. */
export interface ActiveLayers {
  radar: boolean;
  aircraft: boolean;
  vessels: boolean;
}

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
  flowAvailable,
  aisAvailable,
  offlineCode,
  onViewport,
  onLayersChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const userMarker = useRef<Marker | null>(null);
  const dataMarkers = useRef<Marker[]>([]);
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;
  const warnPopup = useRef<MlPopup | null>(null);
  const warnById = useRef<Map<string, WarningFeature>>(new Map());
  const currentBase = useRef<string>('online');
  const [ready, setReady] = useState(false);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [activeSev, setActiveSev] = useState<Set<Severity>>(() => new Set(ALL_SEVERITIES));
  // Alle Fachebenen starten aus — der Nutzer schaltet gezielt zu.
  const [showWarnings, setShowWarnings] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [showPegel, setShowPegel] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  const [radarIdx, setRadarIdx] = useState(0);
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [showNight, setShowNight] = useState(false);
  const [showAircraft, setShowAircraft] = useState(false);
  const [showVessels, setShowVessels] = useState(false);
  const [iconEpoch, setIconEpoch] = useState(0);
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

  // Live-Daten (Radar, Flüge, Schiffe) werden nur geladen, wenn ihre Ebene an ist.
  useEffect(
    () => onLayersChange({ radar: showRadar, aircraft: showAircraft, vessels: showVessels }),
    [showRadar, showAircraft, showVessels, onLayersChange],
  );

  // Nachschlagetabellen für die Klick-Popups
  const aircraftById = useRef<Map<string, Aircraft>>(new Map());
  const vesselByMmsi = useRef<Map<number, Vessel>>(new Map());
  useEffect(() => {
    aircraftById.current = new Map(aircraft.map((a) => [a.icao, a]));
  }, [aircraft]);
  useEffect(() => {
    vesselByMmsi.current = new Map(vessels.map((v) => [v.mmsi, v]));
  }, [vessels]);

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
      if (ac) warnPopup.current!.setLngLat(e.lngLat).setHTML(aircraftPopupHtml(ac)).addTo(map);
    });
    map.on('click', 'vessels', (e) => {
      if (drawModeRef.current !== 'off') return;
      const id = e.features?.[0]?.properties?.id as number | undefined;
      const vessel = id != null ? vesselByMmsi.current.get(id) : undefined;
      if (vessel) warnPopup.current!.setLngLat(e.lngLat).setHTML(vesselPopupHtml(vessel)).addTo(map);
    });

    for (const layer of ['warnings-fill', 'aircraft', 'vessels']) {
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
          map.setStyle(buildStyle(`pmtiles://${key}`, dark), { diff: false });
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

    for (const [id, on, data] of [
      ['aircraft', showAircraft, aircraftToGeoJson(aircraft)],
      ['vessels', showVessels, vesselsToGeoJson(vessels)],
    ] as const) {
      if (!on) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        continue;
      }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        continue;
      }
      map.addSource(id, { type: 'geojson', data });
      map.addLayer({
        id,
        type: 'symbol',
        source: id,
        // Weit herausgezoomt zeigt das ADS-B-Netz nur einen Umkreis um die
        // Kartenmitte — dann lieber gar nichts, statt ein schiefes Bild.
        minzoom: 6,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': id === 'aircraft' ? 0.62 : 0.5,
          'icon-rotate': ['get', 'rotate'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          // Beschriftung erst, wenn genug Platz ist — sonst wird es unruhig.
          'text-field': ['step', ['zoom'], '', 9, ['get', 'label']],
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
  }, [showAircraft, showVessels, aircraft, vessels, ready, styleEpoch, iconEpoch]);

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
        const m = new maplibregl.Marker({ element: markerEl('var(--accent)', 12) })
          .setLngLat([p.coordinates.lon, p.coordinates.lat])
          .setPopup(new maplibregl.Popup({ offset: 12, maxWidth: '300px' }).setHTML(pegelPopupHtml(p)))
          .addTo(map);
        dataMarkers.current.push(m);
      }
    }
  }, [traffic, pegel, showTraffic, showPegel, ready]);

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

  return (
    <>
      <div className="mapwrap">
        <div ref={containerRef} className="lagemap" />
        <div className="mapcontrols">
        <div className="maptools">
          <button
            type="button"
            className="chip"
            aria-pressed={showWarnings}
            title="Amtliche Warngebiete (NINA/DWD) ein- oder ausblenden"
            onClick={() => setShowWarnings((v) => !v)}
          >
            <span className="k" style={{ background: SEVERITY_COLOR.severe }} />
            Warnungen
          </button>
          <button type="button" className="chip" aria-pressed={showRadar} onClick={() => setShowRadar((v) => !v)}>
            <span className="k" style={{ background: '#3f83d4' }} />
            Regenradar
          </button>
          {flowAvailable && (
            <button type="button" className="chip" aria-pressed={showFlow} onClick={() => setShowFlow((v) => !v)}>
              <span className="k" style={{ background: 'linear-gradient(90deg,#2c9e5b,#e0a90b,#c0392b)' }} />
              Verkehrsfluss
            </button>
          )}
          <button type="button" className="chip" aria-pressed={showTraffic} onClick={() => setShowTraffic((v) => !v)}>
            <span className="k" style={{ background: 'var(--sev3)' }} />
            Verkehr
          </button>
          <button type="button" className="chip" aria-pressed={showPegel} onClick={() => setShowPegel((v) => !v)}>
            <span className="k" style={{ background: 'var(--accent)' }} />
            Pegel
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={showAircraft}
            title="Flugverkehr aus dem offenen ADS-B-Netz"
            onClick={() => setShowAircraft((v) => !v)}
          >
            <span className="k" style={{ background: '#1d4e73' }} />
            Flugzeuge
          </button>
          {aisAvailable && (
            <button
              type="button"
              className="chip"
              aria-pressed={showVessels}
              title="Schiffsverkehr aus dem AIS-Netz"
              onClick={() => setShowVessels((v) => !v)}
            >
              <span className="k" style={{ background: '#2c7448' }} />
              Schiffe
            </button>
          )}
          <button
            type="button"
            className="chip"
            aria-pressed={showNight}
            title="Tag- und Nachtgrenze (Dämmerung schattiert)"
            onClick={() => setShowNight((v) => !v)}
          >
            <span className="k" style={{ background: '#0b1a33' }} />
            Tag/Nacht
          </button>
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
