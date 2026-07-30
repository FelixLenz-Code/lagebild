import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MlMap, type Marker, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Coords, TrafficIncident, WaterLevel } from '@lagebild/shared';

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
  traffic: TrafficIncident[];
  pegel: WaterLevel[];
}

export function LageMap({ coords, traffic, pegel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const userMarker = useRef<Marker | null>(null);
  const dataMarkers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [showTraffic, setShowTraffic] = useState(true);
  const [showPegel, setShowPegel] = useState(true);

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
    map.on('load', () => setReady(true));
    mapRef.current = map;
    return () => {
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
    </div>
  );
}
