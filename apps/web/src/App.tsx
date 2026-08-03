import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  Coords,
  RouteProfile,
  RouteResult,
  Severity,
  TransitItinerary,
  TransitLeg,
  TransitDeparture,
  TransitStopPoint,
  TransitTrip,
  TransitVehicle,
  WarningFeature,
} from '@lagebild/shared';
import { FEDERAL_STATES } from '@lagebild/shared';
import { DEFAULT_COORDS, fetchWeather, fetchForecast, fetchWarnings, fetchTraffic, fetchPegel, fetchNews, fetchAir, fetchRadar, fetchRadarForecast, fetchAircraft, fetchVessels, fetchAprs, fetchWind, fetchTransit, fetchStops, fetchStopDepartures, fetchTrip, fetchPlan, fetchHfSpace, fetchHfMuf, fetchVehicles, fetchLightning, fetchNina, fetchFires, fetchRadiation, fetchRest, fetchWebcams, fetchRescue, fetchPollen, fetchQuakes, fetchAurora, fetchFireDanger, fetchHealth, fetchMaps, type Bbox } from './api.js';
import { useApi } from './useApi.js';
import { LageMap, type ActiveLayers } from './LageMap.js';
import { STOP_COLOR } from './mapIcons.js';
import { SearchSheet } from './SearchSheet.js';
import { LocationSheet } from './LocationSheet.js';
import { StopSheet } from './StopSheet.js';
import { VehicleSheet } from './VehicleSheet.js';
import { HfBands, HfDetail } from './HfPanel.js';
import { NewsIcon } from './NewsIcon.js';
import { HfPathSheet } from './HfPathSheet.js';
import { forecastPath } from './hfPath.js';
import { RoutePanel, formatDistance, type PlanMode } from './RoutePanel.js';
import { OfflineRegions } from './OfflineRegions.js';
import { SettingsSheet } from './SettingsSheet.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import {
  loadPresets,
  savePresets,
  type MapPreset,
  type SlideshowSettings,
} from './mapPresets.js';
import type { LayerRowId } from './layerCatalog.js';
import { opfsSupported, listOffline, type PackageKind, type RegionFiles } from './offlineMaps.js';
import { elevationOffline, poisOffline, routeOffline, stopsOffline } from './offline/client.js';
import type { ElevationProfile } from './offline/terrain.js';
import { routeFromLine, viaPointsFromLine } from './offline/router.js';
import { useNavigation } from './navigation.js';
import { STATE_BOUNDS, inStateBounds, statesContaining, statesForCorridor } from './stateBounds.js';
import { loadFavorites, saveFavorites, pointInGeometry, type Place } from './places.js';
import { AlertBanner, collectAlerts } from './AlertBanner.js';
import { TrackPanel, useTrackRecorder } from './TrackPanel.js';
import { trackLength, type Track } from './trackStore.js';
import { drawFrom, tracksFrom, readImport, ImportError, type ImportResult } from './importFiles.js';
import { ImportBox } from './ImportBox.js';
import { lineLength } from './geo.js';
import { type DrawFeature } from './drawStore.js';
import { Sheet } from './Sheet.js';
import {
  WeatherDetail,
  WarningsDetail,
  CivilWarningsDetail,
  TrafficDetail,
  PegelDetail,
  NewsDetail,
  TransitDetail,
} from './details.js';
import { kindOfProduct, relativeTime, departureTime, hourLabel, CONDITION_DE, SEVERITY_VAR, AIR_DE, AIR_COLOR } from './format.js';
import { WeatherIcon } from './WeatherIcon.js';
import { sunAltitude } from './sun.js';

type DetailKey = 'weather' | 'warnings' | 'nina' | 'traffic' | 'pegel' | 'news' | 'transit' | 'hf';

/** Anfangs-Ausschnitt um einen Punkt, bis die Karte ihren echten Ausschnitt meldet. */
function boxAround(c: { lat: number; lon: number }): Bbox {
  return { west: c.lon - 0.2, south: c.lat - 0.12, east: c.lon + 0.2, north: c.lat + 0.12 };
}
/** Leeres Windfeld, solange die Ebene aus ist oder noch nichts geladen wurde. */
const EMPTY_WIND = { points: [], cols: 0, rows: 0, time: null };

const bboxKey = (b: Bbox) =>
  `${b.west.toFixed(2)},${b.south.toFixed(2)},${b.east.toFixed(2)},${b.north.toFixed(2)}`;

export function App() {
  const [coords, setCoords] = useState<Coords>(DEFAULT_COORDS);
  const [place, setPlace] = useState('Berlin-Mitte');
  // Sichtbarer Kartenausschnitt — steuert alle ortsbezogenen Kartendaten.
  const [viewport, setViewport] = useState<Bbox>(() => boxAround(DEFAULT_COORDS));
  const [favorites, setFavorites] = useState<Place[]>(() => loadFavorites());
  const [searchOpen, setSearchOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  /** Der nächste Klick auf die Karte setzt den Standort. */
  const [pickingLocation, setPickingLocation] = useState(false);
  /** Woher der aktuelle Standort stammt (nur Anzeige). */
  const [locationSource, setLocationSource] = useState<'gps' | 'manual'>('gps');

  useEffect(() => saveFavorites(favorites), [favorites]);

  // Standort per Geolocation (auch aus dem Ort-Auswähler aufrufbar).
  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setCoords(c);
        setViewport(boxAround(c));
        setPlace('Mein Standort');
        setLocationSource('gps');
      },
      () => {
        /* Berechtigung verweigert → Standardort behalten */
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);
  // Ortung beim Start ist abschaltbar (Einstellungen) — dann bleibt der
  // zuletzt gewählte Ort stehen, bis von Hand geortet wird.
  const locateOnStart = useRef(loadSettings().locateOnStart);
  useEffect(() => {
    if (locateOnStart.current) locate();
  }, [locate]);

  /** Standort von Hand setzen (Karte) — nie aus der Suche. */
  const selectPlace = (p: Place) => {
    setCoords({ lat: p.lat, lon: p.lon });
    setViewport(boxAround({ lat: p.lat, lon: p.lon }));
    setPlace(p.name);
    setLocationSource('manual');
    setLocationOpen(false);
    setPickingLocation(false);
  };
  const saveFavorite = (p: Place) =>
    setFavorites((prev) =>
      prev.some((f) => Math.abs(f.lat - p.lat) < 1e-6 && Math.abs(f.lon - p.lon) < 1e-6)
        ? prev
        : [...prev, p],
    );
  const removeFavorite = (p: Place) =>
    setFavorites((prev) =>
      prev.filter((f) => !(Math.abs(f.lat - p.lat) < 1e-6 && Math.abs(f.lon - p.lon) < 1e-6)),
    );

  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Hochzählen löst jede Abfrage neu aus — der Aktualisieren-Knopf steckt darin.
  const [refreshTick, setRefreshTick] = useState(0);

  const geoKey = `${coords.lat.toFixed(3)},${coords.lon.toFixed(3)}`;
  const viewKey = bboxKey(viewport);
  const weather = useApi(`weather:${geoKey}`, () => fetchWeather(coords), [coords, refreshTick]);
  const forecast = useApi(`forecast:${geoKey}`, () => fetchForecast(coords), [coords, refreshTick]);
  const warnings = useApi(`warnings:${viewKey}`, () => fetchWarnings(viewport), [viewKey, refreshTick]);
  const traffic = useApi(`traffic:${viewKey}`, () => fetchTraffic(viewport), [viewKey, refreshTick]);
  const pegel = useApi(`pegel:${viewKey}`, () => fetchPegel(viewport), [viewKey, refreshTick]);
  const air = useApi(`air:${geoKey}`, () => fetchAir(coords), [coords, refreshTick]);
  const transit = useApi(`transit:${geoKey}`, () => fetchTransit(coords), [coords, refreshTick]);
  const radar = useApi('radar', () => fetchRadar(), [refreshTick]);
  // Live-Ebenen laden nur, solange sie auf der Karte eingeschaltet sind.
  /** Kartenschwenk auf einen Punkt (Nachrichtenliste). */
  const [flyTo, setFlyTo] = useState<{ lat: number; lon: number; zoom?: number; key: number } | null>(null);
  const showOnMap = useCallback((lat: number, lon: number, zoom = 9) => {
    setFlyTo({ lat, lon, zoom, key: Date.now() });
    setDetail(null);
  }, []);

  /** Gegenstelle der Funkstrecken-Bewertung (Kartenmenü). */
  const [hfTarget, setHfTarget] = useState<Coords | null>(null);
  const [layers, setLayers] = useState<ActiveLayers>({
    radar: false,
    aircraft: false,
    vessels: false,
    aprs: false,
    wind: false,
    stops: false,
    muf: false,
    news: false,
    vehicles: false,
    emergency: false,
    quakes: false,
    lightning: false,
    nina: false,
    fires: false,
    radiation: false,
    rest: false,
    webcams: false,
    rescue: false,
    aurora: false,
    fire: false,
    aprsTargets: [],
  });
  const radarForecast = useApi(
    `radar-forecast:${geoKey}`,
    () => fetchRadarForecast(coords),
    [coords, refreshTick],
    { enabled: layers.radar },
  );
  // Das ADS-B-Netz liefert nur einen Umkreis um die Kartenmitte — bei sehr
  // weitem Ausschnitt wäre das Bild irreführend, also gar nicht erst abfragen.
  const wideViewport = viewport.east - viewport.west > 8;
  // Flug- und Schiffspositionen veralten in Sekunden — pollen, nicht cachen.
  const aircraft = useApi(`aircraft:${viewKey}`, () => fetchAircraft(viewport), [viewKey, refreshTick], {
    enabled: layers.aircraft && !wideViewport,
    refreshMs: 15000,
    cache: false,
  });
  const vessels = useApi(`vessels:${viewKey}`, () => fetchVessels(viewport), [viewKey, refreshTick], {
    enabled: layers.vessels,
    refreshMs: 20000,
    cache: false,
  });
  // APRS fragt gezielt Rufzeichen ab (kein Ausschnitt) — aprs.fi bittet um
  // sparsame Abrufe, deshalb nur bei aktiver Ebene und im Minutentakt.
  const aprsKey = layers.aprsTargets.join(',');
  const aprs = useApi(`aprs:${aprsKey}`, () => fetchAprs(layers.aprsTargets), [aprsKey, refreshTick], {
    enabled: layers.aprs && layers.aprsTargets.length > 0,
    refreshMs: 60000,
    cache: false,
  });
  // Windfeld folgt dem Ausschnitt; das Modell rechnet stündlich, 10 min reichen.
  const wind = useApi(`wind:${viewKey}`, () => fetchWind(viewport), [viewKey, refreshTick], {
    enabled: layers.wind,
    refreshMs: 600000,
    cache: false,
  });
  // Fahrzeugpositionen werden aus dem Fahrplan gerechnet und veralten schnell.
  const vehicles = useApi(
    `vehicles:${viewKey}`,
    () => fetchVehicles(viewport),
    [viewKey, refreshTick],
    { enabled: layers.vehicles, refreshMs: 20000, cache: false },
  );
  // Erdbeben, Polarlicht und Waldbrandgefahr gelten weltweit bzw. landesweit —
  // sie hängen nicht am Ausschnitt und werden selten erneuert.
  // Blitze folgen dem Ausschnitt und veralten schnell — kurz takten, nicht cachen.
  const lightning = useApi(
    `lightning:${viewKey}`,
    () => fetchLightning(viewport, 30),
    [viewKey, refreshTick],
    { enabled: layers.lightning, refreshMs: 20000, cache: false },
  );
  // Behördenwarnungen folgen dem Ausschnitt; sie ändern sich selten, sollen im
  // Ernstfall aber zügig erscheinen.
  const nina = useApi(`nina:${viewKey}`, () => fetchNina(viewport), [viewKey, refreshTick], {
    enabled: layers.nina,
    refreshMs: 120000,
  });
  // Satelliten-Feuer und Strahlungsmessnetz folgen dem Ausschnitt; beide
  // Quellen erneuern sich langsam (FIRMS wenige Male am Tag, ODL stündlich).
  const fires = useApi(`fires:${viewKey}`, () => fetchFires(viewport), [viewKey, refreshTick], {
    enabled: layers.fires,
    refreshMs: 1800_000,
  });
  const radiation = useApi(
    `radiation:${viewKey}`,
    () => fetchRadiation(viewport),
    [viewKey, refreshTick],
    { enabled: layers.radiation, refreshMs: 900_000 },
  );
  // Rastanlagen und Webcams ändern sich in Wochen — stündlich reicht völlig.
  const rest = useApi(`rest:${viewKey}`, () => fetchRest(viewport), [viewKey, refreshTick], {
    enabled: layers.rest,
    refreshMs: 3600_000,
  });
  const webcams = useApi(
    `webcams:${viewKey}`,
    () => fetchWebcams(viewport),
    [viewKey, refreshTick],
    { enabled: layers.webcams, refreshMs: 3600_000 },
  );
  // Rettungspunkte sind praktisch unveränderlich — nur bei aktiver Ebene und
  // ohne eigenes Nachladen; der Server rastert und cacht die Overpass-Abfrage.
  const rescue = useApi(`rescue:${viewKey}`, () => fetchRescue(viewport), [viewKey, refreshTick], {
    enabled: layers.rescue,
  });
  const quakes = useApi('quakes', () => fetchQuakes(), [refreshTick], {
    enabled: layers.quakes,
    refreshMs: 600_000,
  });
  const aurora = useApi('aurora', () => fetchAurora(), [refreshTick], {
    enabled: layers.aurora,
    refreshMs: 600_000,
  });
  const fire = useApi('fire', () => fetchFireDanger(), [refreshTick], {
    enabled: layers.fire,
    refreshMs: 3600_000,
  });
  // Funkwetter wird stündlich erneuert — häufiger abzurufen bringt nichts und
  // widerspricht der Bitte der Quelle.
  const hf = useApi('hf-space', () => fetchHfSpace(), [refreshTick], { refreshMs: 3600_000 });
  // Das Gitter wird auch für die Streckenbewertung gebraucht, nicht nur für die Ebene.
  const muf = useApi('hf-muf', () => fetchHfMuf(), [refreshTick], {
    enabled: layers.muf || hfTarget !== null,
    refreshMs: 900_000,
  });

  /*
   * Warnungen **am Standort** — unabhängig vom Kartenausschnitt und von den
   * Ebenen, denn das Banner soll auch dann erscheinen, wenn die Karte gerade
   * woanders steht. Ein kleines Rechteck um den Punkt genügt; die genaue
   * Prüfung macht danach der Flächentest.
   */
  const homeBox = useMemo<Bbox>(
    () => ({
      west: coords.lon - 0.06,
      south: coords.lat - 0.04,
      east: coords.lon + 0.06,
      north: coords.lat + 0.04,
    }),
    [coords],
  );
  const homeWarnings = useApi(
    `home-warn:${geoKey}`,
    () => fetchWarnings(homeBox),
    [geoKey, refreshTick],
    { refreshMs: 300_000 },
  );
  const homeCivil = useApi(`home-nina:${geoKey}`, () => fetchNina(homeBox), [geoKey, refreshTick], {
    refreshMs: 300_000,
  });
  /** Nur was den Standort wirklich überdeckt — die Rechtecke sind großzügig. */
  const alerts = useMemo(
    () =>
      collectAlerts(
        (homeWarnings.data?.data ?? []).filter((w) => pointInGeometry(coords, w.geometry)),
        (homeCivil.data?.data ?? []).filter((w) => pointInGeometry(coords, w.geometry)),
      ),
    [homeWarnings.data, homeCivil.data, coords],
  );

  const news = useApi(`news:${geoKey}`, () => fetchNews(coords), [coords, refreshTick]);
  // Pollenflug erneuert der DWD einmal täglich — stündlich nachfragen genügt.
  const pollen = useApi(`pollen:${geoKey}`, () => fetchPollen(coords), [coords, refreshTick], {
    refreshMs: 3600_000,
  });
  const health = useApi('health', () => fetchHealth(), [refreshTick]);
  const flowAvailable = health.data?.features?.flow ?? false;
  const aisAvailable = health.data?.features?.ais ?? false;
  const aprsAvailable = health.data?.features?.aprs ?? false;
  const lightningAvailable = health.data?.features?.lightning ?? false;

  const maps = useApi('maps', () => fetchMaps(), [refreshTick]);
  const availableMap: Record<string, RegionFiles> = Object.fromEntries(
    (maps.data?.data ?? []).map((m) => [
      m.code,
      { map: m.map, route: m.route, search: m.search, terrain: m.terrain },
    ]),
  );
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  useEffect(() => saveSettings(settings), [settings]);

  /* ---------- Spuraufzeichnung ---------- */
  const recorder = useTrackRecorder();
  const [trackOpen, setTrackOpen] = useState(false);
  /** Welche gespeicherte Spur liegt gerade auf der Karte? */
  const [shownTrack, setShownTrack] = useState<Track | null>(null);
  // Während der Aufzeichnung zeigt die Karte die laufende Spur, sonst die
  // ausgewählte gespeicherte.
  const trackLine = useMemo<[number, number][]>(() => {
    const source = recorder.recording ? recorder.points : (shownTrack?.points ?? []);
    return source.map((p) => [p.lon, p.lat] as [number, number]);
  }, [recorder.recording, recorder.points, shownTrack]);

  /* ---------- Fremde Dateien einlesen (GPX/KML/KMZ/GeoJSON) ---------- */
  /** Markierungen, die die Karte noch übernehmen muss. */
  const [addDraw, setAddDraw] = useState<{ features: DrawFeature[]; key: number } | null>(null);
  /** Ausschnitt, auf den die Karte springen soll. */
  const [fitBbox, setFitBbox] = useState<{ bbox: [number, number, number, number]; key: number } | null>(null);
  /** Auf das Fenster gezogene Datei — wird an das Einlese-Blatt gereicht. */
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  /** Blatt „Datei einlesen" (aus dem Einzeichnen-Menü oder per Ziehen). */
  const [importOpen, setImportOpen] = useState(false);

  const takeImport = useCallback((result: ImportResult) => {
    const tracks = tracksFrom(result);
    const features = drawFrom(result);
    // Linien landen doppelt: als Markierung (dauerhaft auf der Karte) und als
    // Spur (GPX-Ausgabe, „Zum Start zurück"). Deshalb wird die Spur NICHT
    // zusätzlich eingeblendet — sie läge deckungsgleich unter der Markierung.
    if (tracks.length) recorder.setTracks((prev) => [...prev, ...tracks]);
    if (features.length) setAddDraw({ features, key: Date.now() });
    if (result.bbox) setFitBbox({ bbox: result.bbox, key: Date.now() });
    setImportOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eine Datei auf das Fenster ziehen ist der naheliegende Weg am Rechner.
  // Der Browser würde sie sonst einfach öffnen und die App verlassen.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      setDroppedFile(file);
      setImportOpen(true);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  /* ---------- Gespeicherte Karten und Diashow ---------- */
  const [presets, setPresets] = useState<MapPreset[]>(() => loadPresets().presets);
  const [slideshow, setSlideshow] = useState<SlideshowSettings>(() => loadPresets().slideshow);
  useEffect(() => savePresets({ presets, slideshow }), [presets, slideshow]);
  /** Gerade eingeschaltete Ebenen (meldet die Karte). */
  const [activeLayers, setActiveLayers] = useState<LayerRowId[]>([]);
  /** Von außen gesetzte Ebenen — Vorschau oder laufende Diashow. */
  const [applyLayers, setApplyLayers] = useState<{ layers: LayerRowId[]; key: number } | null>(null);
  const showPreset = useCallback((p: MapPreset) => {
    setApplyLayers({ layers: p.layers, key: Date.now() });
  }, []);
  /** Läuft die Diashow? Dann steht hier, welche Karte gerade dran ist. */
  const [showIndex, setShowIndex] = useState<number | null>(null);
  const [showPaused, setShowPaused] = useState(false);
  const running = showIndex !== null && presets.length > 0;

  // Die laufende Diashow schaltet die Ebenen und stellt nach der Standzeit weiter.
  useEffect(() => {
    if (!running) return;
    const current = presets[showIndex!];
    if (!current) {
      setShowIndex(null);
      return;
    }
    setApplyLayers({ layers: current.layers, key: Date.now() });
    if (showPaused) return;
    const id = window.setTimeout(() => {
      setShowIndex((i) => {
        const next = (i ?? 0) + 1;
        if (next < presets.length) return next;
        // Am Ende: von vorn oder aufhören.
        return slideshow.loop ? 0 : null;
      });
    }, Math.max(3, current.seconds) * 1000);
    return () => window.clearTimeout(id);
  }, [running, showIndex, showPaused, presets, slideshow.loop]);

  // Escape beendet die Diashow — der Weg zurück muss auch am großen Monitor
  // ohne Menü funktionieren.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape schließt zuerst offene Menüs und Blätter — erst wenn nichts
      // mehr offen ist, beendet es die Diashow. Der Lauscher hängt deshalb in
      // der **Erfassungsphase**: React räumt das Menü sonst schon aus dem DOM,
      // bevor ein gewöhnlicher Lauscher überhaupt drankommt.
      if (e.key === 'Escape') {
        if (!document.querySelector('.scrim, .lm-panel, .pointmenu')) setShowIndex(null);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        setShowPaused((p) => !p);
      }
      if (e.key === 'ArrowRight') setShowIndex((i) => ((i ?? 0) + 1) % presets.length);
      if (e.key === 'ArrowLeft') setShowIndex((i) => ((i ?? 0) - 1 + presets.length) % presets.length);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [running, presets.length]);
  const [offlineFiles, setOfflineFiles] = useState<Record<string, RegionFiles>>({});
  const refreshOffline = useCallback(() => {
    if (opfsSupported()) listOffline().then(setOfflineFiles).catch(() => {});
  }, []);
  useEffect(() => {
    refreshOffline();
  }, [refreshOffline]);

  /**
   * Heruntergeladene Region, die einen Punkt enthält und den Teil `kind` hat.
   * Die Rechtecke der Länder überlappen sich stark — es gewinnt das, in dem
   * der Punkt am weitesten vom Rand entfernt liegt.
   */
  const regionFor = useCallback(
    (point: Coords, kind: PackageKind): string | null => {
      let best: string | null = null;
      let bestMargin = -1;
      for (const code of Object.keys(offlineFiles)) {
        if (!offlineFiles[code]?.[kind] || !inStateBounds(point, code)) continue;
        const b = STATE_BOUNDS[code]!;
        const margin = Math.min(
          point.lon - b[0],
          b[2] - point.lon,
          point.lat - b[1],
          b[3] - point.lat,
        );
        if (margin > bestMargin) {
          bestMargin = margin;
          best = code;
        }
      }
      return best;
    },
    [offlineFiles],
  );

  // Offline (kein Netz) + heruntergeladene Region am Standort → Offline-Basiskarte.
  const offlineCode = useMemo(
    () => (online ? null : regionFor(coords, 'map')),
    [online, regionFor, coords],
  );
  const searchCode = useMemo(() => regionFor(coords, 'search'), [regionFor, coords]);

  // Haltestellen kommen aus dem Offline-Suchindex der Region — kein Netz nötig.
  const stopsCode = useMemo(
    () => regionFor({ lat: (viewport.north + viewport.south) / 2, lon: (viewport.east + viewport.west) / 2 }, 'search'),
    [regionFor, viewport],
  );
  const stopsLive = useApi(
    `stops-live:${viewKey}`,
    () => fetchStops(viewport).then((r) => r.data),
    [viewKey, refreshTick],
    { enabled: layers.stops && online, cache: false },
  );
  const stopsOfflineState = useApi(
    `stops-offline:${stopsCode}:${viewKey}`,
    () => (stopsCode ? stopsOffline(stopsCode, viewport, 600) : Promise.resolve([])),
    [stopsCode, viewKey, refreshTick],
    { enabled: layers.stops && !!stopsCode && (!online || !stopsLive.data?.length), cache: false },
  );

  /** Punkte, die im Notfall zählen — alle stehen im Offline-Suchindex. */
  const EMERGENCY_CATEGORIES = [
    'hospital',
    'pharmacy',
    'doctor',
    'police',
    'fire_station',
    'drinking_water',
    'shelter',
  ];
  const emergencyState = useApi(
    `emergency:${stopsCode}:${viewKey}`,
    () => (stopsCode ? poisOffline(stopsCode, EMERGENCY_CATEGORIES, viewport, 400) : Promise.resolve([])),
    [stopsCode, viewKey, refreshTick],
    { enabled: layers.emergency && !!stopsCode, cache: false },
  );

  /** Art einer Haltestelle aus der Kategorie des Offline-Index. */
  const OFFLINE_KIND: Record<string, TransitStopPoint['kind']> = {
    bus_stop: 'bus',
    tram_stop: 'tram',
    station: 'rail',
    ferry_terminal: 'ferry',
  };
  // Die Fahrplandaten haben Vorrang: dort steht nur, was wirklich bedient wird.
  // Der Offline-Index (OpenStreetMap) springt ohne Netz ein.
  const stopPoints: TransitStopPoint[] = useMemo(() => {
    if (stopsLive.data?.length) return stopsLive.data;
    return (stopsOfflineState.data ?? []).map((g) => ({
      ids: [],
      name: g.name,
      lat: g.lat,
      lon: g.lon,
      kind: OFFLINE_KIND[g.category ?? ''] ?? 'other',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopsLive.data, stopsOfflineState.data]);


  /**
   * Angetipptes Fahrzeug: Fahrplan (Fahrtweg) dazu holen. Die Fahrt wird alle
   * 30 s aufgefrischt, solange das Blatt offen ist — Verspätungen ändern sich.
   */
  const [vehicle, setVehicle] = useState<TransitVehicle | null>(null);
  /** Blatt zu, Fahrtweg bleibt: die Fahrt ist weiter gewählt. */
  const [vehicleSheet, setVehicleSheet] = useState(false);
  /** Zählt hoch, wenn der Fahrtweg ins Bild gerückt werden soll. */
  const [tripFit, setTripFit] = useState(0);
  /**
   * Fahrtweg, der aus einer **Abfahrtstafel** stammt (Haltestelle oder
   * ÖPNV-Kachel). Anders als beim angetippten Fahrzeug gibt es dazu keine
   * Position, also auch keinen „schon gefahren"-Teil.
   */
  const [stopTrip, setStopTrip] = useState<
    { geometry: [number, number][]; label: string; color: string } | null
  >(null);
  const showTripOnMap = useCallback((departure: TransitDeparture, trip: TransitTrip) => {
    setStopTrip({
      geometry: trip.geometry,
      label: departure.line || trip.line,
      color: STOP_COLOR[kindOfProduct(departure.product ?? trip.product)] ?? '#1d4e73',
    });
    setVehicle(null);
    setStopDetail(null);
    setDetail(null);
    setTripFit((n) => n + 1);
  }, []);
  const selectVehicle = useCallback((v: TransitVehicle) => {
    setVehicle(v);
    setVehicleSheet(true);
  }, []);
  // Ebene aus → auch die gewählte Fahrt verschwindet.
  useEffect(() => {
    if (!layers.vehicles) setVehicle(null);
  }, [layers.vehicles]);
  const vehicleTripState = useApi(
    `trip:${vehicle?.id ?? ''}`,
    () => (vehicle ? fetchTrip(vehicle.id).then((r) => r.data) : Promise.resolve(null)),
    [vehicle?.id],
    { enabled: !!vehicle, refreshMs: 30000, cache: false },
  );
  // Die Marke wandert weiter — der Fahrtweg wird an der jeweils aktuellen
  // Position getrennt, damit „schon gefahren" stimmt.
  const vehicleNow = useMemo(
    () => (vehicle ? (vehicles.data?.data.find((v) => v.id === vehicle.id) ?? vehicle) : null),
    [vehicle, vehicles.data],
  );

  /* ---------- Routenplanung (rein lokal) ---------- */
  const [destination, setDestination] = useState<(Place & { category?: string }) | null>(null);
  const [routeOrigin, setRouteOrigin] = useState<Place | null>(null);
  /** Zwischenziele in Fahrreihenfolge — der Router hängt die Abschnitte aneinander. */
  const [via, setVia] = useState<Place[]>([]);
  /** Wartet die Karte auf einen Klick für ein Zwischenziel? */
  const [pickingVia, setPickingVia] = useState(false);
  const [pin, setPin] = useState<(Place & { category?: string }) | null>(null);
  const [profile, setProfile] = useState<PlanMode>('car');
  /** ÖPNV-Verbindungen (nur online) samt Auswahl und Wunschzeit. */
  const [itineraries, setItineraries] = useState<TransitItinerary[]>([]);
  const [itineraryIndex, setItineraryIndex] = useState(0);
  const [planTime, setPlanTime] = useState<string | null>(null);
  const [planArriveBy, setPlanArriveBy] = useState(false);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [routeIndex, setRouteIndex] = useState(0);
  /**
   * Eingelesene GPX-Tour, der genau gefolgt werden soll. Sie wird nicht
   * gerechnet, sondern liegt fertig vor — deshalb steht sie neben `routes`
   * und schaltet die Berechnung ab, statt sie zu füttern.
   */
  const [gpxLine, setGpxLine] = useState<
    { coords: [number, number][]; name: string; ele?: (number | undefined)[] } | null
  >(null);
  const [gpxRoute, setGpxRoute] = useState<RouteResult | null>(null);
  /** Eingelesene Tour, für die noch die Art der Übernahme fehlt. */
  const [gpxChoice, setGpxChoice] = useState<
    { name: string; coords: [number, number][]; ele: (number | undefined)[]; source: string } | null
  >(null);
  const gpxRouteRef = useRef<RouteResult | null>(null);
  const [avoidMotorways, setAvoidMotorways] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [muted, setMuted] = useState(() => !loadSettings().voiceGuidance);
  gpxRouteRef.current = gpxRoute;
  /** Was in Leiste und Karte erscheint: die eingelesene Tour hat Vorrang. */
  const shownRoutes = gpxRoute ? [gpxRoute] : routes;
  /** Die gerade gewählte Variante — sie wird gefahren und angesagt. */
  const route = gpxRoute ?? routes[routeIndex] ?? null;

  // Profilwechsel rechnet nur die Fahrzeit der Tour neu; die Linie bleibt.
  useEffect(() => {
    if (!gpxLine || profile === 'transit') {
      setGpxRoute(null);
      return;
    }
    setGpxRoute(routeFromLine(gpxLine.coords, profile as RouteProfile));
  }, [gpxLine, profile]);
  // Beim Start der Zielführung darf nicht neu gerechnet werden, sonst wäre die
  // ausgewählte Variante wieder weg — deshalb nur als Ref, nicht als Abhängigkeit.
  const navigatingRef = useRef(navigating);
  navigatingRef.current = navigating;

  const startPoint: Coords = routeOrigin ? { lat: routeOrigin.lat, lon: routeOrigin.lon } : coords;
  const startKey = `${startPoint.lat.toFixed(5)},${startPoint.lon.toFixed(5)}`;
  const destKey = destination ? `${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}` : '';
  const viaKey = via.map((v) => `${v.lat.toFixed(5)},${v.lon.toFixed(5)}`).join(';');

  // Alle heruntergeladenen Regionen entlang der Luftlinie werden zu einem Netz
  // verbunden — sonst würde eine Route an der Landesgrenze enden.
  const routeCodes = useMemo(() => {
    if (!destination) return [] as string[];
    // Mit Zwischenzielen zählt jeder Abschnitt einzeln — der Umweg über ein
    // Zwischenziel kann durch ein Bundesland führen, das die Luftlinie zwischen
    // Start und Ziel gar nicht berührt.
    const stops: Coords[] = [startPoint, ...via, { lat: destination.lat, lon: destination.lon }];
    const codes = new Set<string>();
    for (let i = 1; i < stops.length; i++) {
      for (const code of statesForCorridor(stops[i - 1]!, stops[i]!)) codes.add(code);
    }
    return [...codes].filter((code) => offlineFiles[code]?.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey, destKey, viaKey, offlineFiles]);

  const routeCodesKey = routeCodes.join(',');

  /**
   * Welche Region könnte für einen Punkt fehlen? Nur ein Hinweis für die
   * Fehlermeldung — die Rechtecke der Bundesländer überlappen sich.
   */
  const regionHint = useCallback(
    (point: Coords): string => {
      const names = statesContaining(point)
        .filter((code) => !offlineFiles[code]?.route)
        .map((code) => FEDERAL_STATES.find((s) => s.code === code)?.name ?? code);
      return names.length ? ` Infrage kommt: ${names.join(', ')}.` : '';
    },
    [offlineFiles],
  );

  useEffect(() => {
    // Einer eingelesenen Tour wird gefolgt, nicht nachgerechnet.
    if (gpxRouteRef.current) return;
    if (!destination) {
      setRoutes([]);
      setRouteError(null);
      return;
    }
    if (profile === 'transit' || !routeCodes.length) {
      setRoutes([]);
      setRouteError(null);
      return;
    }
    let cancelled = false;
    setRouteLoading(true);
    setRouteError(null);
    const target = { lat: destination.lat, lon: destination.lon };
    // Während der Zielführung zählt Tempo, nicht Auswahl — dann nur ein Weg.
    routeOffline(routeCodes, startPoint, target, profile as RouteProfile, {
      alternatives: navigatingRef.current ? 1 : 3,
      avoidMotorways,
      via: via.map((v) => ({ lat: v.lat, lon: v.lon })),
    })
      .then((outcome) => {
        if (cancelled) return;
        setRoutes(outcome.routes);
        setRouteIndex(0);
        if (outcome.status === 'start-off-grid') {
          setRouteError(`Der Startpunkt liegt außerhalb der gespeicherten Regionen.${regionHint(startPoint)}`);
        } else if (outcome.status === 'end-off-grid') {
          setRouteError(`Das Ziel liegt außerhalb der gespeicherten Regionen.${regionHint(target)}`);
        } else if (outcome.status === 'via-off-grid') {
          const at = outcome.offGridVia ?? 0;
          const point = via[at];
          setRouteError(
            `Das ${at + 1}. Zwischenziel liegt außerhalb der gespeicherten Regionen.` +
              (point ? regionHint({ lat: point.lat, lon: point.lon }) : ''),
          );
        } else if (outcome.status === 'no-path') {
          setRouteError(
            'Keine Verbindung gefunden. Führt die Strecke durch eine Region, die noch nicht gespeichert ist?',
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRoutes([]);
          setRouteError('Die Route konnte nicht berechnet werden.');
        }
      })
      .finally(() => {
        if (!cancelled) setRouteLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destKey, startKey, viaKey, profile, routeCodesKey, avoidMotorways, gpxRoute]);

  // ÖPNV läuft nicht über den Offline-Graphen — Fahrpläne kommen aus dem Netz.
  const [planLoading, setPlanLoading] = useState(false);
  useEffect(() => {
    if (profile !== 'transit' || !destination || !online) {
      setItineraries([]);
      return;
    }
    let cancelled = false;
    setPlanLoading(true);
    fetchPlan(startPoint, { lat: destination.lat, lon: destination.lon }, planTime, planArriveBy)
      .then((r) => {
        if (cancelled) return;
        setItineraries(r.data);
        setItineraryIndex(0);
      })
      .catch(() => !cancelled && setItineraries([]))
      .finally(() => !cancelled && setPlanLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, destKey, startKey, planTime, planArriveBy, online]);

  /* ---------- Höhenprofil (aus dem Geländepaket oder aus der Datei) ---------- */
  const [elevation, setElevation] = useState<ElevationProfile | null>(null);
  /** Regionen mit heruntergeladenem Höhenpaket entlang der Strecke. */
  const terrainCodes = useMemo(() => {
    if (!route?.coordinates.length) return [] as string[];
    const first = route.coordinates[0]!;
    const last = route.coordinates[route.coordinates.length - 1]!;
    return statesForCorridor({ lat: first[1], lon: first[0] }, { lat: last[1], lon: last[0] }).filter(
      (code) => offlineFiles[code]?.terrain,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, offlineFiles]);

  useEffect(() => {
    if (!route || route.coordinates.length < 2) {
      setElevation(null);
      return;
    }
    // Ohne Geländepaket bleibt nur, was die eingelesene Datei selbst mitbringt.
    const own = gpxRoute && gpxLine?.ele ? gpxLine.ele : undefined;
    if (!terrainCodes.length && !own) {
      setElevation(null);
      return;
    }
    let cancelled = false;
    elevationOffline(terrainCodes, route.coordinates, own)
      .then((p) => !cancelled && setElevation(p))
      .catch(() => !cancelled && setElevation(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, terrainCodes.join(','), gpxRoute]);

  /** Fußweg einer Verbindung an die Offline-Navigation übergeben. */
  const walkLeg = (leg: TransitLeg) => {
    setRouteOrigin({ name: leg.from.name || 'Mein Standort', lat: leg.from.lat, lon: leg.from.lon });
    setDestination({ name: leg.to.name || destination?.name || 'Ziel', lat: leg.to.lat, lon: leg.to.lon });
    setProfile('foot');
  };

  /** Bei Abweichung von der Route: ab der aktuellen Position neu rechnen. */
  const handleOffRoute = useCallback((position: Coords) => {
    // Bei einer eingelesenen Tour gibt es nichts neu zu rechnen: die Linie ist
    // die Route. Die Leiste zeigt weiterhin „abseits der Route" — der Weg
    // zurück auf die Spur bleibt die Aufgabe des Fahrers.
    if (gpxRouteRef.current) return;
    setRouteOrigin({ name: 'Aktuelle Position', lat: position.lat, lon: position.lon });
  }, []);
  // Zielführung gibt es nur für die selbst gerechneten Profile.
  const navProfile: RouteProfile = profile === 'transit' ? 'foot' : profile;
  const nav = useNavigation(route, navigating, navProfile, muted, handleOffRoute);

  /**
   * GPX-Datei für die Routenplanung einlesen. Genommen wird die **längste**
   * Linie der Datei — Tourenportale legen gern noch Anfahrtsschnipsel dazu.
   */
  const loadGpxRoute = async (file: File) => {
    setRouteError(null);
    try {
      const result = await readImport(file.name, await file.arrayBuffer());
      const longest = result.lines
        .map((l) => ({ line: l, length: trackLength(l.points) }))
        .sort((a, b) => b.length - a.length)[0];
      if (!longest) {
        setRouteError(`In „${file.name}" steckt keine Linie, der man folgen könnte.`);
        return;
      }
      setGpxChoice({
        name: longest.line.name,
        coords: longest.line.points.map((p) => [p.lon, p.lat] as [number, number]),
        // GPX bringt oft eigene Höhen mit — die sind am Gerät gemessen und
        // schlagen jedes Geländemodell.
        ele: longest.line.points.map((p) => p.ele),
        source: result.source,
      });
    } catch (e) {
      setRouteError(
        e instanceof ImportError ? e.message : `„${file.name}" ließ sich nicht lesen.`,
      );
    }
  };

  /** Eingelesene Tour übernehmen — entweder genau so oder auf Straßen gerechnet. */
  const takeGpxRoute = (how: 'exact' | 'roads') => {
    const choice = gpxChoice;
    if (!choice) return;
    const first = choice.coords[0]!;
    const last = choice.coords[choice.coords.length - 1]!;
    setNavigating(false);
    setRouteOrigin({ name: `Start ${choice.name}`, lat: first[1], lon: first[0] });
    setDestination({ name: choice.name, lat: last[1], lon: last[0] });
    setPin(null);
    if (how === 'exact') {
      setVia([]);
      setGpxLine({ coords: choice.coords, name: choice.name, ele: choice.ele });
    } else {
      // Die Stützpunkte werden zu Zwischenzielen; den Rest macht der Router.
      setGpxLine(null);
      setVia(
        viaPointsFromLine(choice.coords).map((p, i) => ({
          name: `${choice.name} ${i + 1}`,
          lat: p.lat,
          lon: p.lon,
        })),
      );
    }
    setGpxChoice(null);
  };

  /** Ziel setzen und die Karte auf Planung umstellen. */
  const startRouteTo = (place: Place, category?: string) => {
    setDestination({ ...place, category });
    setPin({ ...place, category });
    setSearchOpen(false);
    setNavigating(false);
    // Ein neues Ziel beginnt eine neue Fahrt — die alten Zwischenziele lagen
    // auf einem anderen Weg, und eine eingelesene Tour führt woandershin.
    setVia([]);
    setPickingVia(false);
    setGpxLine(null);
  };

  const stopRoute = () => {
    setNavigating(false);
    setDestination(null);
    setRoutes([]);
    setRouteOrigin(null);
    setVia([]);
    setPickingVia(false);
    setGpxLine(null);
    setPin(null);
  };

  /** Zielführung starten — möglichst ab der echten Position. */
  const startNavigation = () => {
    setNavigating(true);
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          setRouteOrigin({
            name: 'Aktuelle Position',
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
          }),
        () => {
          /* ohne Ortung bleibt der geplante Start stehen */
        },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }
  };

  /**
   * Punkt aus dem Kartenmenü (oder aus dem Setzen-Modus). `label` ist gesetzt,
   * wenn eine Haltestelle oder eigene Markierung angetippt wurde.
   */
  const pickPoint = (
    point: Coords,
    kind: 'destination' | 'origin' | 'via' | 'place' | 'radio',
    label?: string,
  ) => {
    if (kind === 'radio') {
      setHfTarget(point);
      return;
    }
    const coordName = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
    const name = label ?? coordName;
    if (kind === 'destination') startRouteTo({ name, ...point });
    else if (kind === 'origin') setRouteOrigin({ name, ...point });
    else if (kind === 'via') {
      // Neue Zwischenziele hängen sich hinten an; umsortiert wird in der Liste.
      setVia((prev) => [...prev, { name, ...point }]);
      setPickingVia(false);
    } else selectPlace({ name: label ?? `Karte ${coordName}`, ...point });
  };

  const transitStops = transit.data?.data ?? [];
  const transitDisruptions = transitStops
    .flatMap((s) => s.departures)
    .filter((d) => d.cancelled || (d.delayMin ?? 0) >= 5 || d.remark).length;
  const nearestStop = transitStops.find((s) => s.departures.length > 0);

  // Eine Warnung liegt als viele Gemeinde-Flächen vor → für Liste/Detail entdoppeln.
  const uniqueWarnings = useMemo(() => {
    const seen = new Map<string, WarningFeature>();
    for (const f of warnings.data?.data ?? []) if (!seen.has(f.id)) seen.set(f.id, f);
    return [...seen.values()];
  }, [warnings.data]);

  // Schwerste Warnstufe im Ausschnitt — färbt die Zahl in der Zählkachel.
  const worstWarning = useMemo(() => {
    const order: Severity[] = ['minor', 'moderate', 'severe', 'extreme'];
    let worst: Severity | null = null;
    for (const w of uniqueWarnings) {
      if (!worst || order.indexOf(w.severity) > order.indexOf(worst)) worst = w.severity;
    }
    return worst;
  }, [uniqueWarnings]);

  const lastSync = weather.savedAt;
  const anyCached = [weather, warnings, traffic, pegel, air, transit, news].some((s) => s.fromCache);
  const anyLoading = [weather, forecast, warnings, traffic, pegel, air, transit, radar, news].some(
    (s) => s.loading,
  );

  /** Alles neu holen — nur sinnvoll, solange eine Verbindung besteht. */
  const refreshAll = useCallback(() => {
    if (!navigator.onLine) return;
    setRefreshTick((n) => n + 1);
    refreshOffline();
  }, [refreshOffline]);

  // Selbsttätiges Aktualisieren im gewählten Takt (0 = aus).
  useEffect(() => {
    if (!settings.autoRefreshMin) return;
    const id = window.setInterval(() => refreshAll(), settings.autoRefreshMin * 60_000);
    return () => window.clearInterval(id);
  }, [settings.autoRefreshMin, refreshAll]);

  const [detail, setDetail] = useState<DetailKey | null>(null);
  /** Angetippte Haltestelle auf der Karte. */
  const [stopDetail, setStopDetail] = useState<TransitStopPoint | null>(null);
  const stopDepartures = useApi(
    `stop-dep:${stopDetail?.ids.join(',') ?? ''}`,
    () => (stopDetail?.ids.length ? fetchStopDepartures(stopDetail.ids).then((r) => r.data) : Promise.resolve([])),
    [stopDetail?.ids.join(',')],
    { enabled: !!stopDetail?.ids.length && online, cache: false },
  );

  const detailInfo: Record<DetailKey, { title: string; source?: string; savedAt: number | null }> = {
    weather: { title: `Wetter — ${place}`, source: weather.data?.source, savedAt: weather.savedAt },
    warnings: { title: 'Amtliche Warnungen', source: warnings.data?.source, savedAt: warnings.savedAt },
    nina: { title: 'Warnungen der Behörden', source: nina.data?.source, savedAt: nina.savedAt },
    traffic: { title: 'Verkehr im Ausschnitt', source: traffic.data?.source, savedAt: traffic.savedAt },
    pegel: { title: 'Pegelstände', source: pegel.data?.source, savedAt: pegel.savedAt },
    transit: { title: 'Bahn / ÖPNV in der Nähe', source: transit.data?.source, savedAt: transit.savedAt },
    news: { title: 'Nachrichten', source: news.data?.source, savedAt: news.savedAt },
    hf: { title: 'Funkwetter', source: hf.data?.source, savedAt: hf.savedAt },
  };
  const detailMeta = (k: DetailKey) => {
    const info = detailInfo[k];
    const parts = [info.source];
    if (info.savedAt) parts.push(`aktualisiert ${relativeTime(new Date(info.savedAt).toISOString())}`);
    return parts.filter(Boolean).join(' · ');
  };

  const w = weather.data?.data;
  const fc = forecast.data?.data ?? null;
  const today = fc?.daily[0];
  const isNight = sunAltitude(new Date(), coords.lat, coords.lon) < -0.833;
  // Vorschau in der Kachel: die nächsten vier vollen Stunden.
  const nextHours = (fc?.hourly ?? []).filter((h) => new Date(h.time).getTime() > Date.now()).slice(0, 4);
  const airNow = air.data?.data ?? null;
  const hfNow = hf.data?.data ?? null;
  const mufGrid = muf.data?.data ?? null;
  // Bandampel für die gewählte Strecke — reine Rechnung, kein weiterer Abruf.
  const hfForecast = useMemo(
    () => (hfTarget && mufGrid ? forecastPath(mufGrid, coords, hfTarget, hfNow?.kIndex ?? null) : null),
    [hfTarget, mufGrid, coords, hfNow?.kIndex],
  );
  const rain24h = fc
    ? Math.round(fc.hourly.slice(0, 24).reduce((sum, h) => sum + (h.precipitationMm ?? 0), 0) * 10) / 10
    : null;

  return (
    <div className={`app${running && slideshow.mapOnly ? ' is-show' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l7 2.5v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V5.5L12 3Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div>
            <b>Lagebild</b>
            <span>Sicher unterwegs</span>
          </div>
        </div>

        <button type="button" className="place-btn" onClick={() => setLocationOpen(true)} title="Standort setzen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.2" />
          </svg>
          <span className="pl-name">{place}</span>
          <svg className="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbtn"
          onClick={() => setSearchOpen(true)}
          title="Ziel suchen"
          aria-label="Ziel suchen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>

        <button
          type="button"
          className={`iconbtn${anyLoading ? ' is-busy' : ''}`}
          onClick={refreshAll}
          disabled={!online}
          title={online ? 'Alle Daten aktualisieren' : 'Ohne Verbindung nicht möglich'}
          aria-label="Alle Daten aktualisieren"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 11a8 8 0 0 0-14-4.5L4 9" />
            <path d="M4 13a8 8 0 0 0 14 4.5L20 15" />
            <path d="M4 4v5h5M20 20v-5h-5" />
          </svg>
        </button>

        <button
          type="button"
          className={`iconbtn${recorder.recording ? ' is-rec' : ''}`}
          onClick={() => setTrackOpen(true)}
          title={recorder.recording ? 'Aufzeichnung läuft' : 'Spur aufzeichnen'}
          aria-label="Spur aufzeichnen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 19c3-1 3-6 6-6s3 4 6 3 2-6 2-6" />
            <circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none" />
            <circle cx="19" cy="10" r="1.8" fill="currentColor" stroke="none" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbtn"
          onClick={() => setSettingsOpen(true)}
          title="Einstellungen und Quellen"
          aria-label="Einstellungen und Quellen"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>

        {opfsSupported() && (
          <button type="button" className="iconbtn" onClick={() => setRegionsOpen(true)} title="Offline-Regionen" aria-label="Offline-Regionen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v11M12 14l-4-4M12 14l4-4M5 20h14" />
            </svg>
          </button>
        )}
      </header>

      <div className="statusline" data-state={online && !anyCached ? 'live' : 'offline'}>
        <span className="live"><i />{online && !anyCached ? 'LIVE' : 'OFFLINE'}</span>
        <span>
          {lastSync ? `Aktualisiert ${relativeTime(new Date(lastSync).toISOString())}` : 'Lade …'}
          {(!online || anyCached) && ' · letzter Stand'}
        </span>
      </div>

      {alerts.length > 0 && <AlertBanner alerts={alerts} onOpen={(d) => setDetail(d)} />}

      <div className="layout">
        <div className="map-col">
          <LageMap
            coords={coords}
            warnings={warnings.data?.data ?? []}
            traffic={traffic.data?.data ?? []}
            pegel={pegel.data?.data ?? []}
            radar={radar.data?.data ?? null}
            radarForecast={radarForecast.data?.data ?? null}
            radarForecastPending={layers.radar && radarForecast.loading}
            aircraft={aircraft.data?.data ?? []}
            vessels={vessels.data?.data ?? []}
            aprs={aprs.data?.data ?? []}
            wind={wind.data?.data ?? EMPTY_WIND}
            flowAvailable={flowAvailable}
            aisAvailable={aisAvailable}
            aprsAvailable={aprsAvailable}
            offlineCode={offlineCode}
            route={route}
            itinerary={profile === 'transit' ? (itineraries[itineraryIndex] ?? null) : null}
            muf={mufGrid}
            news={news.data?.data ?? []}
            flyTo={flyTo}
            hfPath={hfForecast?.line ?? null}
            stops={stopPoints}
            vehicles={vehicles.data?.data ?? []}
            onVehicleClick={selectVehicle}
            onTripOpen={() => (vehicle ? setVehicleSheet(true) : setTripFit((n) => n + 1))}
            onTripClear={() => {
              setVehicle(null);
              setStopTrip(null);
            }}
            vehicleTrip={
              vehicleNow && vehicleTripState.data?.geometry.length
                ? {
                    geometry: vehicleTripState.data.geometry,
                    at: { lat: vehicleNow.lat, lon: vehicleNow.lon },
                    color: STOP_COLOR[kindOfProduct(vehicleNow.product)] ?? '#1d4e73',
                    label: vehicleNow.line,
                    fitKey: tripFit,
                  }
                : stopTrip
                  ? { ...stopTrip, fitKey: tripFit }
                  : null
            }
            emergency={layers.emergency ? (emergencyState.data ?? []) : []}
            quakes={quakes.data?.data ?? []}
            lightning={lightning.data?.data ?? []}
            nina={nina.data?.data ?? []}
            fires={fires.data?.data ?? []}
            radiation={radiation.data?.data ?? []}
            rest={rest.data?.data ?? []}
            webcams={webcams.data?.data ?? []}
            rescue={rescue.data?.data ?? []}
            lightningAvailable={lightningAvailable}
            aurora={aurora.data?.data ?? null}
            fire={fire.data?.data ?? null}
            stopsAvailable={online || !!stopsCode}
            onStopClick={setStopDetail}
            alternatives={shownRoutes.map((r, i) => ({ index: i, route: r })).filter((r) => r.index !== routeIndex)}
            onSelectRoute={setRouteIndex}
            routeOrigin={routeOrigin ? { lat: routeOrigin.lat, lon: routeOrigin.lon } : null}
            pin={destination ? null : pin}
            navigating={navigating}
            navPosition={nav.position}
            navBearing={nav.heading ?? nav.progress?.bearing ?? null}
            onPickPoint={pickPoint}
            onOpenImport={() => setImportOpen(true)}
            pickingLocation={pickingLocation}
            pickingVia={pickingVia}
            routeActive={!!destination}
            onViewport={setViewport}
            track={trackLine}
            trackLive={recorder.recording}
            addDraw={addDraw}
            fitBbox={fitBbox}
            onLayersChange={setLayers}
            hiddenLayers={settings.hiddenLayers}
            onActiveLayers={setActiveLayers}
            applyLayers={applyLayers}
          />
          {pickingLocation && (
            <div className="pickbar" role="status">
              <span>Tippe auf die Karte, um deinen Standort zu setzen.</span>
              <button type="button" className="btn-quiet" onClick={() => setPickingLocation(false)}>
                Abbrechen
              </button>
            </div>
          )}

          {destination && (
            <RoutePanel
              origin={routeOrigin}
              destination={destination}
              via={via}
              onRemoveVia={(i) => setVia((prev) => prev.filter((_, k) => k !== i))}
              onMoveVia={(i, delta) =>
                setVia((prev) => {
                  const next = [...prev];
                  const to = i + delta;
                  if (to < 0 || to >= next.length) return prev;
                  [next[i], next[to]] = [next[to]!, next[i]!];
                  return next;
                })
              }
              pickingVia={pickingVia}
              onPickVia={() => setPickingVia(true)}
              onCancelPickVia={() => setPickingVia(false)}
              profile={profile}
              itineraries={itineraries}
              itineraryIndex={itineraryIndex}
              onSelectItinerary={setItineraryIndex}
              planTime={planTime}
              planArriveBy={planArriveBy}
              onPlanTime={(t, arriveBy) => {
                setPlanTime(t);
                setPlanArriveBy(arriveBy);
              }}
              onWalkLeg={walkLeg}
              online={online}
              route={route}
              routes={shownRoutes}
              routeIndex={gpxRoute ? 0 : routeIndex}
              elevation={elevation}
              onSelectRoute={setRouteIndex}
              avoidMotorways={avoidMotorways}
              onToggleMotorways={() => setAvoidMotorways((v) => !v)}
              loading={profile === 'transit' ? planLoading : routeLoading}
              error={routeError}
              regionReady={routeCodes.length > 0}
              navigating={navigating}
              progress={nav.progress}
              muted={muted}
              onProfile={setProfile}
              onSwap={() => {
                const from: Place = routeOrigin ?? { name: place, lat: coords.lat, lon: coords.lon };
                setRouteOrigin({ name: destination.name, lat: destination.lat, lon: destination.lon });
                setDestination({ ...from });
                // Rückwärts gefahren kommen die Zwischenziele in umgekehrter
                // Reihenfolge — sonst führe die Route im Zickzack.
                setVia((prev) => [...prev].reverse());
              }}
              onGpxFile={loadGpxRoute}
              gpxName={gpxLine?.name ?? null}
              onClearGpx={() => setGpxLine(null)}
              onResetOrigin={() => setRouteOrigin(null)}
              onStartNav={startNavigation}
              onStopNav={() => setNavigating(false)}
              onToggleMute={() =>
                setMuted((m) => {
                  // Der Knopf in der Navigationsleiste ist dieselbe Einstellung.
                  setSettings((prev) => ({ ...prev, voiceGuidance: m }));
                  return !m;
                })
              }
              onClose={stopRoute}
            />
          )}
        </div>

        <section className="tiles-col">
        <Tile title="Wetter" source={weather.data?.source} cached={weather.fromCache} className="warnborder" onOpen={w ? () => setDetail('weather') : undefined}>
          {!w && weather.loading && <p className="muted">Lade …</p>}
          {!w && weather.error && <p className="err">{weather.error}</p>}
          {w && (
            <>
              <div className="wx-main">
                <WeatherIcon icon={w.icon ?? (isNight ? 'clear-night' : undefined)} condition={w.condition} size={46} />
                <span className="wx-temp">{w.tempC != null ? `${Math.round(w.tempC)}°` : '–'}</span>
                <div>
                  <div className="wx-cond">{w.condition ? (CONDITION_DE[w.condition] ?? w.condition) : 'Unbekannt'}</div>
                  <div className="wx-sub">
                    {w.feelsLikeC != null
                      ? `gefühlt ${Math.round(w.feelsLikeC)}°`
                      : w.observedAt
                        ? `Messung ${relativeTime(w.observedAt)}`
                        : ''}
                  </div>
                </div>
              </div>

              {/* Kompakte Vorschau: die nächsten Stunden auf einen Blick. */}
              {nextHours.length > 0 && (
                <div className="wx-peek">
                  {nextHours.map((h) => (
                    <div className="wx-peek-h" key={h.time}>
                      <span className="hh">{hourLabel(h.time)}</span>
                      <WeatherIcon icon={h.icon} condition={h.condition} size={22} />
                      <span className="tt mono">{h.tempC != null ? `${Math.round(h.tempC)}°` : '–'}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="wx-row">
                {today && (
                  <span>
                    Heute{' '}
                    <b>
                      {today.tempMaxC != null ? `${Math.round(today.tempMaxC)}°` : '–'} /{' '}
                      {today.tempMinC != null ? `${Math.round(today.tempMinC)}°` : '–'}
                    </b>
                  </span>
                )}
                <span>Wind <b>{w.windKmh != null ? `${Math.round(w.windKmh)} km/h` : '–'}</b></span>
                {rain24h != null && <span>Regen 24 h <b>{rain24h.toString().replace('.', ',')} mm</b></span>}
              </div>

              {/* Luftqualität sitzt jetzt hier statt in einer eigenen Kachel. */}
              {airNow && (
                <div className="wx-air">
                  <span className="lbl">Luft</span>
                  <span className="val">{airNow.aqi ?? '–'}</span>
                  <span className="u">EAQI</span>
                  {airNow.category && (
                    <span
                      className="badge"
                      style={{
                        marginLeft: 'auto',
                        background: `color-mix(in srgb, ${AIR_COLOR[airNow.category]} 16%, transparent)`,
                        color: AIR_COLOR[airNow.category],
                      }}
                    >
                      {AIR_DE[airNow.category]}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </Tile>

        <Tile title="Im Ausschnitt" source="im Kartenausschnitt gezählt">
          <div className="counts">
            <CountCell
              label="Warnungen"
              value={warnings.data ? uniqueWarnings.length : null}
              loading={warnings.loading}
              color={worstWarning ? SEVERITY_VAR[worstWarning] : undefined}
              onOpen={uniqueWarnings.length ? () => setDetail('warnings') : undefined}
            />
            <CountCell
              label="Verkehr"
              value={traffic.data?.data.length ?? null}
              loading={traffic.loading}
              color={traffic.data?.data.length ? 'var(--sev2)' : undefined}
              onOpen={traffic.data?.data.length ? () => setDetail('traffic') : undefined}
            />
            <CountCell
              label="Pegel"
              value={pegel.data?.data.length ?? null}
              loading={pegel.loading}
              onOpen={pegel.data?.data.length ? () => setDetail('pegel') : undefined}
            />
            <CountCell
              label="Flugzeuge"
              value={layers.aircraft && !wideViewport ? (aircraft.data?.data.length ?? null) : null}
              loading={layers.aircraft && aircraft.loading}
              hint={
                !layers.aircraft
                  ? 'Ebene ausgeschaltet'
                  : wideViewport
                    ? 'Ausschnitt zu groß'
                    : undefined
              }
            />
            <CountCell
              label="Schiffe"
              value={layers.vessels ? (vessels.data?.data.length ?? null) : null}
              loading={layers.vessels && vessels.loading}
              hint={!layers.vessels ? 'Ebene ausgeschaltet' : undefined}
            />
            <CountCell
              label="Funk"
              value={layers.aprs ? (aprs.data?.data.length ?? null) : null}
              loading={layers.aprs && aprs.loading}
              hint={!layers.aprs ? 'Ebene ausgeschaltet' : undefined}
            />
            <CountCell
              label="Behörden"
              value={layers.nina ? (nina.data?.data.length ?? null) : null}
              loading={layers.nina && nina.loading}
              color={nina.data?.data.length ? 'var(--sev4)' : undefined}
              hint={layers.nina ? 'Warnungen von Behörden' : 'Ebene ausgeschaltet'}
              onOpen={nina.data?.data.length ? () => setDetail('nina') : undefined}
            />
            <CountCell
              label="Blitze"
              value={layers.lightning ? (lightning.data?.data.length ?? null) : null}
              loading={layers.lightning && lightning.loading}
              color={lightning.data?.data.length ? 'var(--sev2)' : undefined}
              hint={layers.lightning ? 'letzte 30 Minuten' : 'Ebene ausgeschaltet'}
            />
          </div>
        </Tile>

        <Tile
          title="Bahn / ÖPNV"
          source={transit.data?.source}
          cached={transit.fromCache}
          badge={transitDisruptions > 0 ? `${transitDisruptions} Störung` : undefined}
          badgeKind="warn"
          onOpen={transitStops.length ? () => setDetail('transit') : undefined}
        >
          {!transit.data && transit.loading && <p className="muted">Lade …</p>}
          {transit.data && !nearestStop && <p className="muted">Keine ÖPNV-Daten in der Nähe.</p>}
          {nearestStop && (
            <>
              <div className="stop-head">
                <span className="stop-name">{nearestStop.name}</span>
                {nearestStop.coordinates && (
                  <button
                    type="button"
                    className="rp-chip"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRouteTo({
                        name: nearestStop.name,
                        lat: nearestStop.coordinates!.lat,
                        lon: nearestStop.coordinates!.lon,
                      });
                    }}
                    title={`Route nach ${nearestStop.name}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 20V9a3 3 0 0 1 3-3h5" />
                      <path d="M14 3l3 3-3 3" />
                      <circle cx="9" cy="20" r="1.6" />
                    </svg>
                    Navigieren
                  </button>
                )}
              </div>
              <ul className="list">
                {nearestStop.departures.slice(0, 3).map((d, i) => (
                  <li className="line-item" key={i}>
                    <span className="line-pill">{d.line}</span>
                    <span className="t">{d.direction}</span>
                    <span className={`meta${d.cancelled || (d.delayMin ?? 0) >= 1 ? ' late' : ''}`}>
                      {d.cancelled
                        ? 'fällt aus'
                        : `${departureTime(d.when ?? d.plannedWhen)}${d.delayMin ? ` +${d.delayMin}` : ''}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Tile>

        <Tile
          title="Funkwetter"
          source={hf.data?.source}
          cached={hf.fromCache}
          badge={hfNow?.solarFluxIndex != null ? `SFI ${hfNow.solarFluxIndex}` : undefined}
          badgeKind="ok"
          onOpen={hfNow ? () => setDetail('hf') : undefined}
        >
          {!hfNow && hf.loading && <p className="muted">Lade …</p>}
          {!hfNow && hf.error && <p className="err">{hf.error}</p>}
          {hfNow && (
            <>
              <div className="hf-row">
                <span>Sonnenflecken <b>{hfNow.sunspots ?? '–'}</b></span>
                <span>K <b>{hfNow.kIndex ?? '–'}</b></span>
                <span>Röntgen <b>{hfNow.xray ?? '–'}</b></span>
              </div>
              <HfBands data={hfNow} />
            </>
          )}
        </Tile>

        <Tile
          title="News"
          badge={news.data?.data.length ? `${news.data.data.length}` : undefined}
          badgeKind="ok"
          source={news.data?.source} cached={news.fromCache} wide onOpen={news.data ? () => setDetail('news') : undefined}>
          <Loader state={news} empty="Keine Meldungen.">
            <ul className="news">
              {news.data?.data.slice(0, 5).map((n) => (
                <li className="news-item has-ico" key={n.id}>
                  <NewsIcon category={n.category} size={16} />
                  <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
                  <span className="tm">{n.topic ? `${n.topic} · ` : ''}{relativeTime(n.publishedAt)}</span>
                </li>
              ))}
            </ul>
          </Loader>
        </Tile>

        </section>
      </div>

      {regionsOpen && (
        <OfflineRegions
          available={availableMap}
          offline={offlineFiles}
          onClose={() => setRegionsOpen(false)}
          onChanged={refreshOffline}
        />
      )}

      {searchOpen && (
        <SearchSheet
          coords={coords}
          favorites={favorites}
          offlineCode={searchCode}
          online={online}
          onClose={() => setSearchOpen(false)}
          onRoute={startRouteTo}
          onSaveFavorite={saveFavorite}
          onRemoveFavorite={removeFavorite}
        />
      )}

      {hfTarget && (
        <HfPathSheet
          forecast={hfForecast}
          loading={muf.loading && !mufGrid}
          from={place}
          to={hfTarget}
          onClose={() => setHfTarget(null)}
        />
      )}

      {running && (
        <div className="showbar" role="status">
          <span className="sb-pos">
            {(showIndex ?? 0) + 1}/{presets.length}
          </span>
          <span className="sb-name">{presets[showIndex ?? 0]?.name}</span>
          <span className="sb-layers">
            {(presets[showIndex ?? 0]?.layers.length ?? 0) === 0
              ? 'ohne Ebenen'
              : `${presets[showIndex ?? 0]!.layers.length} Ebenen`}
          </span>
          <div className="sb-actions">
            <button
              type="button"
              onClick={() => setShowIndex((i) => ((i ?? 0) - 1 + presets.length) % presets.length)}
              aria-label="Vorige Karte"
              title="Vorige Karte (←)"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setShowPaused((p) => !p)}
              aria-label={showPaused ? 'Weiter' : 'Anhalten'}
              title={showPaused ? 'Weiter (Leertaste)' : 'Anhalten (Leertaste)'}
            >
              {showPaused ? '▶' : '❚❚'}
            </button>
            <button
              type="button"
              onClick={() => setShowIndex((i) => ((i ?? 0) + 1) % presets.length)}
              aria-label="Nächste Karte"
              title="Nächste Karte (→)"
            >
              ›
            </button>
            <button type="button" onClick={() => setShowIndex(null)} aria-label="Diashow beenden" title="Beenden (Esc)">
              ✕
            </button>
          </div>
          {/* Fortschritt der Standzeit — Schlüssel erzwingt den Neustart je Karte. */}
          {!showPaused && (
            <i
              key={`${showIndex}-${presets[showIndex ?? 0]?.id}`}
              className="sb-bar"
              style={{ animationDuration: `${Math.max(3, presets[showIndex ?? 0]?.seconds ?? 20)}s` }}
            />
          )}
        </div>
      )}

      {trackOpen && (
        <TrackPanel
          tracks={recorder.tracks}
          onTracks={recorder.setTracks}
          live={recorder.points}
          recording={recorder.recording}
          error={recorder.error}
          onStart={recorder.start}
          onStop={() => {
            const name = window.prompt(
              'Name der Spur',
              `Spur ${new Date().toLocaleDateString('de-DE')}`,
            );
            // Abbrechen im Namensdialog beendet die Aufzeichnung trotzdem —
            // die Punkte gingen sonst verloren.
            const saved = recorder.stop(name ?? '');
            if (saved) setShownTrack(saved);
          }}
          onShow={setShownTrack}
          onBackToStart={(point, name) => {
            startRouteTo({ name: `Start von ${name}`, ...point });
            setTrackOpen(false);
          }}
          shownId={shownTrack?.id ?? null}
          onClose={() => setTrackOpen(false)}
        />
      )}

      {gpxChoice && (
        <Sheet
          title="Tour übernehmen"
          meta={gpxChoice.source}
          onClose={() => setGpxChoice(null)}
        >
          <div className="gpxpick">
            <div className="tr-head">
              <b>{gpxChoice.name}</b>
              <span className="tr-meta mono">
                {formatDistance(lineLength(gpxChoice.coords))} · {gpxChoice.coords.length} Stützpunkte
              </span>
            </div>
            <button type="button" className="gpx-opt" onClick={() => takeGpxRoute('exact')}>
              <b>Genau dieser Linie folgen</b>
              <span>
                Die Tour ist die Route. Anweisungen entstehen aus den Richtungswechseln, ohne
                Straßennamen. Funktioniert auch abseits von Straßen und ohne gespeicherte Region.
              </span>
            </button>
            <button type="button" className="gpx-opt" onClick={() => takeGpxRoute('roads')}>
              <b>Auf dem Straßennetz nachrechnen</b>
              <span>
                Die Stützpunkte werden zu Zwischenzielen, der Offline-Router baut daraus echte
                Abbiegehinweise mit Straßennamen. Braucht die gespeicherte Region und weicht ab,
                wo die Tour nicht auf Straßen liegt.
              </span>
            </button>
          </div>
        </Sheet>
      )}

      {importOpen && (
        <Sheet
          title="Datei einlesen"
          meta="GPX · KML · KMZ · GeoJSON"
          onClose={() => setImportOpen(false)}
        >
          <ImportBox
            onCommit={takeImport}
            file={droppedFile}
            onFileHandled={() => setDroppedFile(null)}
          />
        </Sheet>
      )}

      {settingsOpen && (
        <SettingsSheet
          settings={settings}
          onChange={setSettings}
          available={{
            flow: flowAvailable,
            ais: aisAvailable,
            aprs: aprsAvailable,
            lightning: lightningAvailable,
          }}
          onOpenRegions={() => {
            setSettingsOpen(false);
            setRegionsOpen(true);
          }}
          presets={presets}
          onPresets={setPresets}
          slideshow={slideshow}
          onSlideshow={setSlideshow}
          activeLayers={activeLayers}
          onPreview={(p) => {
            showPreset(p);
            setSettingsOpen(false);
          }}
          onStart={() => {
            setSettingsOpen(false);
            setShowPaused(false);
            setShowIndex(0);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {vehicle && vehicleSheet && (
        <VehicleSheet
          vehicle={vehicleNow ?? vehicle}
          trip={vehicleTripState.data ?? null}
          loading={vehicleTripState.loading}
          failed={!vehicleTripState.loading && !vehicleTripState.data}
          onShowOnMap={() => {
            setVehicleSheet(false);
            setTripFit((n) => n + 1);
          }}
          onRouteToStop={(stop) => {
            startRouteTo({ name: stop.name, lat: stop.lat, lon: stop.lon });
            setVehicle(null);
          }}
          onClose={() => setVehicle(null)}
        />
      )}

      {stopDetail && (
        <StopSheet
          stop={stopDetail}
          coords={coords}
          departures={stopDepartures.data}
          loading={stopDepartures.loading}
          offline={!online || !stopDetail.ids.length}
          onRoute={() => {
            startRouteTo({ name: stopDetail.name, lat: stopDetail.lat, lon: stopDetail.lon });
            setStopDetail(null);
          }}
          onOrigin={() => {
            setRouteOrigin({ name: stopDetail.name, lat: stopDetail.lat, lon: stopDetail.lon });
            setStopDetail(null);
          }}
          onShowRoute={showTripOnMap}
          onClose={() => setStopDetail(null)}
        />
      )}

      {locationOpen && (
        <LocationSheet
          current={place}
          coords={coords}
          source={locationSource}
          onClose={() => setLocationOpen(false)}
          onUseGeolocation={() => {
            locate();
            setLocationOpen(false);
          }}
          onPickOnMap={() => {
            setLocationOpen(false);
            setPickingLocation(true);
          }}
        />
      )}

      {detail && (
        <Sheet title={detailInfo[detail].title} meta={detailMeta(detail)} onClose={() => setDetail(null)}>
          {detail === 'weather' && w && (
            <WeatherDetail
              w={w}
              forecast={fc}
              air={airNow}
              pollen={pollen.data?.data ?? null}
              coords={coords}
            />
          )}
          {detail === 'warnings' && <WarningsDetail list={uniqueWarnings} />}
          {detail === 'nina' && <CivilWarningsDetail list={nina.data?.data ?? []} />}
          {detail === 'traffic' && traffic.data && <TrafficDetail list={traffic.data.data} />}
          {detail === 'pegel' && pegel.data && <PegelDetail list={pegel.data.data} />}
          {detail === 'transit' && (
            <TransitDetail
              onShowRoute={showTripOnMap}
              stops={transitStops}
              onRoute={(name, lat, lon) => startRouteTo({ name, lat, lon })}
            />
          )}
          {detail === 'news' && news.data && (
            <NewsDetail list={news.data.data} onShowOnMap={showOnMap} />
          )}
          {detail === 'hf' && hfNow && <HfDetail data={hfNow} />}
        </Sheet>
      )}
    </div>
  );
}

function Tile(props: {
  title: string;
  source?: string;
  badge?: string;
  badgeKind?: 'warn' | 'ok' | 'alert';
  cached?: boolean;
  wide?: boolean;
  pending?: boolean;
  className?: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const cls = ['tile'];
  if (props.className) cls.push(props.className);
  if (props.wide) cls.push('wide');
  if (props.pending) cls.push('pending');
  if (props.onOpen) cls.push('tap');
  const interactive = props.onOpen
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: props.onOpen,
        onKeyDown: (e: ReactKeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onOpen!();
          }
        },
      }
    : {};
  return (
    <article className={cls.join(' ')} {...interactive}>
      <div className="head">
        <h3>{props.title}</h3>
        {props.cached && <span className="offline-tag" title="Offline — letzter Stand">offline</span>}
        {props.badge && <span className={`badge ${props.badgeKind ?? 'warn'}`}>{props.badge}</span>}
        {props.source && !props.badge && !props.cached && <span className="src-tag">{props.source}</span>}
        {props.onOpen && <span className="chevron" aria-hidden="true">›</span>}
      </div>
      {props.children}
    </article>
  );
}

/** Eine Zahl in der Zählkachel — optional antippbar für die Detailliste. */
function CountCell(props: {
  label: string;
  /** null = keine Daten (Ebene aus, zu großer Ausschnitt, Fehler). */
  value: number | null;
  loading?: boolean;
  color?: string;
  hint?: string;
  onOpen?: () => void;
}) {
  const text = props.value != null ? String(props.value) : props.loading ? '…' : '–';
  const inner = (
    <>
      <span className="cc-num" style={props.color ? { color: props.color } : undefined}>
        {text}
      </span>
      <span className="cc-lbl">{props.label}</span>
    </>
  );
  if (!props.onOpen) {
    return (
      <div className="cc" title={props.hint}>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="cc cc-tap"
      title={props.hint}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen!();
      }}
    >
      {inner}
    </button>
  );
}

function Loader<T>(props: {
  state: { loading: boolean; error: string | null; data: { data: T[] } | null };
  empty: string;
  children: ReactNode;
}) {
  const env = props.state.data;
  if (env) return env.data.length === 0 ? <p className="muted">{props.empty}</p> : <>{props.children}</>;
  if (props.state.loading) return <p className="muted">Lade …</p>;
  return <p className="err">{props.state.error ?? 'Fehler'}</p>;
}
