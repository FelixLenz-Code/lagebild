import { useEffect, useRef, useState } from 'react';
import maplibregl, {
  type Map as MlMap,
  type Marker,
  type Popup as MlPopup,
  type StyleSpecification,
  type FilterSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Coords, TrafficIncident, WaterLevel, WarningFeature, Severity } from '@lagebild/shared';
import type { Bbox } from './api.js';
import { SEVERITY_DE } from './format.js';

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

// Reine Raster-Karte auf Basis der OpenStreetMap-Kacheln — ohne API-Key.
// Für den Offline-Betrieb pro Bundesland später gegen Vektor-Kacheln (PMTiles) tauschen.
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap-Mitwirkende',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

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
  onViewport: (b: Bbox) => void;
}

export function LageMap({ coords, warnings, traffic, pegel, onViewport }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const userMarker = useRef<Marker | null>(null);
  const dataMarkers = useRef<Marker[]>([]);
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;
  const warnPopup = useRef<MlPopup | null>(null);
  const warnById = useRef<Map<string, WarningFeature>>(new Map());
  const [ready, setReady] = useState(false);
  const [activeSev, setActiveSev] = useState<Set<Severity>>(() => new Set(ALL_SEVERITIES));
  const [showTraffic, setShowTraffic] = useState(true);
  const [showPegel, setShowPegel] = useState(true);

  // Nachschlagetabelle id → Warnung (für Klick-Popup)
  useEffect(() => {
    warnById.current = new Map(warnings.map((w) => [w.id, w]));
  }, [warnings]);

  // Karte einmalig erzeugen
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [coords.lon, coords.lat],
      zoom: 11,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

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

    // Klick auf ein Warngebiet → Popup mit dem Warntext
    warnPopup.current = new maplibregl.Popup({ maxWidth: '300px' });
    map.on('click', 'warnings-fill', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const wf = id ? warnById.current.get(id) : undefined;
      if (!wf) return;
      warnPopup.current!.setLngLat(e.lngLat).setHTML(warningPopupHtml(wf)).addTo(map);
    });
    map.on('mouseenter', 'warnings-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'warnings-fill', () => {
      map.getCanvas().style.cursor = '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Warn-Daten aktualisieren
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('warnings') as maplibregl.GeoJSONSource | undefined;
    src?.setData(warningsToGeoJson(warnings));
  }, [warnings, ready]);

  // Warn-Layer nach Warnstufe filtern (Legenden-Umschalter)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const filter: FilterSpecification = ['in', ['get', 'severity'], ['literal', [...activeSev]]];
    if (map.getLayer('warnings-fill')) map.setFilter('warnings-fill', filter);
    if (map.getLayer('warnings-line')) map.setFilter('warnings-line', filter);
  }, [activeSev, ready]);

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
          .setPopup(new maplibregl.Popup({ offset: 12 }).setText(t.title))
          .addTo(map);
        dataMarkers.current.push(m);
      }
    }
    if (showPegel) {
      for (const p of pegel) {
        if (!p.coordinates) continue;
        const label = `${p.station}: ${p.levelCm != null ? `${p.levelCm} cm` : '–'}`;
        const m = new maplibregl.Marker({ element: markerEl('var(--accent)', 12) })
          .setLngLat([p.coordinates.lon, p.coordinates.lat])
          .setPopup(new maplibregl.Popup({ offset: 12 }).setText(label))
          .addTo(map);
        dataMarkers.current.push(m);
      }
    }
  }, [traffic, pegel, showTraffic, showPegel, ready]);

  return (
    <div className="mapwrap">
      <div ref={containerRef} className="lagemap" />
      <div className="maptools">
        <button
          type="button"
          className="chip"
          aria-pressed={showTraffic}
          onClick={() => setShowTraffic((v) => !v)}
        >
          <span className="k" style={{ background: 'var(--sev3)' }} />
          Verkehr
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={showPegel}
          onClick={() => setShowPegel((v) => !v)}
        >
          <span className="k" style={{ background: 'var(--accent)' }} />
          Pegel
        </button>
      </div>

      <div className="legend" role="group" aria-label="Warnstufen filtern">
        <div className="legend-title">Warnstufen</div>
        <div className="legend-items">
          {ALL_SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              className="legend-item"
              aria-pressed={activeSev.has(s)}
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
      </div>
    </div>
  );
}
