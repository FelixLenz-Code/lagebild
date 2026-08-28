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
import { DEFAULT_COORDS, fetchWeather, fetchForecast, fetchWarnings, fetchTraffic, fetchPegel, fetchNews, fetchBlaulicht, fetchAir, fetchRadar, fetchRadarForecast, fetchAircraft, fetchBosAircraft, fetchVessels, fetchAprs, fetchWind, fetchTransit, fetchStops, fetchStopDepartures, fetchTrip, fetchPlan, fetchHfSpace, fetchHfMuf, fetchVehicles, fetchJourney, fetchLightning, fetchNina, fetchFires, fetchRadiation, fetchRest, fetchWebcams, fetchRescue, fetchFireWater, fetchPollen, fetchQuakes, fetchAurora, fetchFireDanger, fetchHealth, fetchMaps, fetchAvalanche, fetchAvalancheRegions, type Bbox } from './api.js';
import { useApi } from './useApi.js';
import { withCache } from './cache.js';
import { LageMap, type ActiveLayers, type MapApi } from './LageMap.js';
import { ShareSheet } from './ShareSheet.js';
import { EmergencySheet } from './EmergencySheet.js';
import { EscapeSheet } from './EscapeSheet.js';
import { SightSheet } from './SightSheet.js';
import { SatelliteSheet } from './SatelliteSheet.js';
import {
  groundTrack,
  loadSatSelection,
  loadSatSet,
  positionsAt,
  satrecOf,
  saveSatSelection,
  type SatPosition,
  type StoredSatSet,
} from './satStore.js';
import { MapSheet } from './MapSheet.js';
import { PointSheet } from './PointSheet.js';
import { clearShareUrl, readShareUrl } from './share.js';
import { STOP_COLOR } from './mapIcons.js';
import { SearchSheet } from './SearchSheet.js';
import { EMERGENCY_CATEGORIES } from './rescueSearch.js';
import { LocationSheet } from './LocationSheet.js';
import { StopSheet } from './StopSheet.js';
import { VehicleSheet } from './VehicleSheet.js';
import { TrackSheet } from './TrackSheet.js';
import { HfBands, HfDetail } from './HfPanel.js';
import { BlaulichtIcon, NewsIcon } from './NewsIcon.js';
import { HfPathSheet } from './HfPathSheet.js';
import { forecastPath } from './hfPath.js';
import { RoutePanel, formatDistance, type PlanMode } from './RoutePanel.js';
import { OfflineRegions } from './OfflineRegions.js';
import { SettingsSheet } from './SettingsSheet.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { applyTheme, useDark } from './theme.js';
import {
  loadPresets,
  savePresets,
  type MapPreset,
  type SlideshowSettings,
} from './mapPresets.js';
import type { LayerRowId } from './layerCatalog.js';
import { WORLD_CODE, opfsSupported, listOffline, regionAt, type PackageKind, type RegionFiles } from './offlineMaps.js';
import { PMTILES_OVERRIDE, serverPmtilesUrl } from './mapStyle.js';
import { contoursOffline, elevationOffline, poisOffline, reachOffline, routeOffline, shadowOffline, stopsOffline, terrainImageOffline, trailsOffline } from './offline/client.js';
import type { TrailFeature } from './offline/trails.js';
import { imageFromRgba } from './gridImage.js';
import type { ContourLine, ElevationProfile } from './offline/terrain.js';
import type { ReachResult } from './offline/router.js';

/**
 * Zeitbudget der Erreichbarkeitsebene. Eine Stunde deckt die drei Stufen ab,
 * die auf der Karte unterschieden werden (15/30/60 min) — und begrenzt zugleich,
 * wie groß das durchsuchte Netz werden kann.
 */
const REACH_BUDGET_S = 3600;
import { routeFromLine, viaPointsFromLine } from './offline/router.js';
import { useNavigation } from './navigation.js';
import { statesContaining, statesForCorridor } from './stateBounds.js';
import {
  loadFavorites,
  saveFavorites,
  pointInGeometry,
  loadWatched,
  saveWatched,
  newPlaceId,
  MAX_WATCHED,
  type Place,
  type WatchedPlace,
} from './places.js';
import { WatchedPlacesSheet, useWatchedStatus, worstSeverity } from './WatchedPlaces.js';
import { AlertBanner, collectAlerts } from './AlertBanner.js';
import { TrackPanel, useTrackRecorder } from './TrackPanel.js';
import { trackLength, type Track } from './trackStore.js';
import { drawFrom, tracksFrom, readImport, ImportError, type ImportResult } from './importFiles.js';
import { ImportBox } from './ImportBox.js';
import { CompassSheet } from './CompassSheet.js';
import { lineLength } from './geo.js';
import { newId, type DrawFeature } from './drawStore.js';
import { Sheet } from './Sheet.js';
import {
  WeatherDetail,
  WarningsDetail,
  CivilWarningsDetail,
  TrafficDetail,
  PegelDetail,
  NewsDetail,
  BlaulichtDetail,
  BosAirDetail,
  TransitDetail,
} from './details.js';
import { kindOfProduct, relativeTime, departureTime, hourLabel, CONDITION_DE, SEVERITY_VAR, AIR_DE, AIR_COLOR } from './format.js';
import { WeatherIcon } from './WeatherIcon.js';
import { nowcastAt, nowcastText, type Nowcast } from './radarNowcast.js';
import { sunAltitude, sunAzimuth } from './sun.js';
import { MissionSheet } from './MissionSheet.js';
import { HazmatSheet, type HazmatZone } from './HazmatSheet.js';
import { activeMission, logEvent, logOnce, subscribeMissions } from './missionLog.js';
import { syncBackgroundTargets } from './backgroundWarnings.js';
import { RouteSituationView, useRouteSituation } from './RouteSituation.js';
import { situationNow } from './situationNow.js';
import { SituationLight } from './SituationLight.js';
import { fireDangerAt } from './hazardGrids.js';
import { sunTimes } from './sun.js';

type DetailKey = 'weather' | 'warnings' | 'nina' | 'traffic' | 'pegel' | 'news' | 'blaulicht' | 'bosair' | 'transit' | 'hf';

/** Anfangs-Ausschnitt um einen Punkt, bis die Karte ihren echten Ausschnitt meldet. */
function boxAround(c: { lat: number; lon: number }): Bbox {
  return { west: c.lon - 0.2, south: c.lat - 0.12, east: c.lon + 0.2, north: c.lat + 0.12 };
}
/** Leeres Windfeld, solange die Ebene aus ist oder noch nichts geladen wurde. */
const EMPTY_WIND = { points: [], cols: 0, rows: 0, time: null };

const bboxKey = (b: Bbox) =>
  `${b.west.toFixed(2)},${b.south.toFixed(2)},${b.east.toFixed(2)},${b.north.toFixed(2)}`;

/**
 * Die Reiter der schmalen Ansicht. Jede Kachel trägt einen davon (`tab`), die
 * Leiste unten schaltet um. „Suche" ist bewusst **kein** Reiter: Sie öffnet ein
 * Blatt über dem, was gerade zu sehen ist, und wechselt die Ansicht nicht.
 */
type MobileTab = 'karte' | 'lage' | 'oepnv' | 'mehr';

/** Die Einträge der unteren Leiste, in dieser Reihenfolge. */
const TABS: { key: MobileTab | 'suche'; label: string; path: string }[] = [
  { key: 'karte', label: 'Karte', path: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15' },
  { key: 'suche', label: 'Suche', path: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-3.5-3.5' },
  { key: 'lage', label: 'Lage', path: 'M12 3l9.5 17H2.5zM12 10v4M12 17h.01' },
  { key: 'oepnv', label: 'ÖPNV', path: 'M6 3h12v13a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM6 11h12M9 22l-2 2M15 22l2 2M9.5 15h5' },
  { key: 'mehr', label: 'Mehr', path: 'M4 7h16M4 12h16M4 17h16' },
];

/**
 * Die Werkzeuge — **eine** Liste für beide Gestalten: auf dem Handy der Reiter
 * „Mehr", am Rechner das Blatt hinter dem Werkzeug-Knopf in der Kopfzeile.
 *
 * Was im Notfall zählt, steht bewusst **nicht** hier, sondern hinter dem roten
 * Knopf: Wer das Notfallblatt sucht, soll keine Liste lesen müssen.
 */
const MORE_TOOLS: { key: string; label: string; hint: string; path: string }[] = [
  { key: 'kartenblatt', label: 'Kartenblatt drucken', hint: 'Ausschnitt mit UTM-Gitter, Maßstab und Nummern', path: 'M6 3h9l5 5v13H6zM15 3v5h5M9 13h8M9 17h5' },
  { key: 'satelliten', label: 'Satellitenüberflüge', hint: 'ISS, Wetter- und Funksatelliten — offline gerechnet', path: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M5 5l3 3M19 5l-3 3M5 19l3-3M19 19l-3-3' },
  { key: 'kompass', label: 'Kompass und Peilung', hint: 'Richtung halten, Kreuzpeilung', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M15 9l-2 5-5 2 2-5z' },
  { key: 'gefahrgut', label: 'Gefahrgut nachschlagen', hint: 'orangefarbene Tafel: Abstände, Betroffene, Fluchtweg', path: 'M12 3 2 20h20zM12 9v5M12 17.2v.2' },
  { key: 'logbuch', label: 'Einsatz-Logbuch', hint: 'nur während eines Einsatzes — Ereignisse mit Uhrzeit', path: 'M6 3h11a2 2 0 0 1 2 2v16H8a2 2 0 0 1-2-2zM6 7h13M10 11h6M10 15h4' },
  { key: 'verfolgen', label: 'Fahrt verfolgen', hint: 'Bus, Tram oder Zug suchen und live mitfahren', path: 'M8 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M6 9h12M9 21l-2-3M15 21l2-3M9.5 14.5h.2M14.3 14.5h.2' },
  { key: 'spur', label: 'Spur aufzeichnen', hint: 'Weg mitschreiben, als GPX sichern', path: 'M5 19c4 0 3-7 7-7s3-7 7-7' },
  { key: 'teilen', label: 'Karte teilen', hint: 'Ausschnitt und Ebenen als Link', path: 'M6 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M8 10.5l8-4M8 13.5l8 4' },
  { key: 'offline', label: 'Offline-Regionen', hint: 'Karte, Routing und Suche ins Gerät laden', path: 'M12 3v11M12 14l-4-4M12 14l4-4M5 20h14' },
  { key: 'einstellungen', label: 'Einstellungen und Quellen', hint: 'Ebenen abwählen, Diashow, Herkunft der Daten', path: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.3 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.3V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z' },
];

export function App({ onLock }: { onLock: () => Promise<void> }) {
  /**
   * Auf schmalen Geräten ist die App keine gestauchte Schreibtisch-Ansicht,
   * sondern hat eine eigene Gestalt: **volle Karte** und unten eine Leiste,
   * die auf die anderen Ansichten umschaltet. Welcher Reiter gerade gilt, sagt
   * dieser Zustand; am Rechner spielt er keine Rolle — dort steht ohnehin alles
   * nebeneinander, und die Leiste ist ausgeblendet.
   */
  const [tab, setTab] = useState<MobileTab>('karte');
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
  // Ein geteilter Link hat Vorrang: Wer ihn öffnet, will genau diesen
  // Ausschnitt sehen und nicht die eigene Straße.
  const sharedView = useRef(readShareUrl());
  useEffect(() => {
    if (locateOnStart.current && !sharedView.current) locate();
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
  /** Kompass: angepeilter Punkt und ob das Blatt offen ist. */
  const [bearingTarget, setBearingTarget] = useState<{ name: string; lat: number; lon: number } | null>(null);
  const [compassOpen, setCompassOpen] = useState(false);
  /** „Was ist hier?" — Steckbrief einer angetippten Stelle. */
  const [pointInfo, setPointInfo] = useState<{ point: Coords; label: string | null } | null>(null);
  /** Fluchtrouting: die Stelle, von der weg gerechnet werden soll. */
  const [escapeFrom, setEscapeFrom] = useState<{
    danger: Coords;
    label: string | null;
    /** Vorgabe für den Sicherheitsabstand, z. B. aus dem Gefahrgut-Blatt. */
    minDistanceM?: number;
  } | null>(null);
  /** Sichtverbindung: die angepeilte Gegenstelle. */
  const [sightTo, setSightTo] = useState<{ point: Coords; label: string | null } | null>(null);
  const [satOpen, setSatOpen] = useState(false);

  const [mapSheetOpen, setMapSheetOpen] = useState(false);
  /** Werkzeugblatt (am Rechner der Ersatz für den „Mehr"-Reiter). */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [missionOpen, setMissionOpen] = useState(false);
  /** Angenommene Austrittsstelle eines Gefahrstoffs (Blatt offen) … */
  const [hazmatAt, setHazmatAt] = useState<{ point: Coords; label: string } | null>(null);
  /** … und der Bereich, den die Karte davon zeigt. */
  const [hazmatZone, setHazmatZone] = useState<HazmatZone | null>(null);
  /**
   * Läuft gerade ein Einsatz? Nur dafür, den Knopf zu kennzeichnen — die
   * Aufzeichnung selbst entscheidet `missionLog` bei jedem Eintrag neu.
   */
  const [missionRunning, setMissionRunning] = useState(() => activeMission() != null);
  useEffect(() => subscribeMissions(() => setMissionRunning(activeMission() != null)), []);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [layers, setLayers] = useState<ActiveLayers>({
    radar: false,
    aircraft: false,
    vessels: false,
    aprs: false,
    wind: false,
    stops: false,
    muf: false,
    news: false,
    blaulicht: false,
    bosair: false,
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
    water: false,
    reach: false,
    shadow: false,
    aurora: false,
    fire: false,
    terrain: false,
    trails: false,
    contours: false,
    avalanche: false,
    satellites: false,
    aprsTargets: [],
  });

  /* ---------- Satelliten auf der Karte ---------- */
  /** Das geladene Bahndaten-Paket (einmal aus dem Gerät gelesen). */
  const [satSet, setSatSet] = useState<StoredSatSet | null>(null);
  /** Welche Satelliten auf der Karte liegen sollen. */
  const [satSelected, setSatSelected] = useState<string[]>(() => loadSatSelection());
  const [satPositions, setSatPositions] = useState<SatPosition[]>([]);
  const [satTracks, setSatTracks] = useState<{ id: string; name: string; lines: [number, number][][] }[]>(
    [],
  );
  useEffect(() => {
    loadSatSet()
      .then(setSatSet)
      .catch(() => setSatSet(null));
  }, []);
  useEffect(() => saveSatSelection(satSelected), [satSelected]);
  /**
   * Positionen laufend nachrechnen, solange die Ebene an ist. Ein Satellit
   * legt in der Sekunde rund acht Kilometer zurück — alle fünf Sekunden neu
   * ist auf der Karte flüssig genug und kostet nichts, weil die Rechnung
   * lokal ist.
   */
  useEffect(() => {
    if (!layers.satellites || !satSet || !satSelected.length) {
      setSatPositions([]);
      setSatTracks([]);
      return;
    }
    const tick = () =>
      setSatPositions(positionsAt(satSet.set, satSelected, Date.now(), coords));
    tick();
    const timer = window.setInterval(tick, 5000);
    return () => window.clearInterval(timer);
  }, [layers.satellites, satSet, satSelected, coords]);
  // Die Bodenspur ändert sich langsam — sie wird nur bei Auswahl-Wechsel und
  // dann alle zwei Minuten neu gezogen, nicht im Takt der Position.
  useEffect(() => {
    if (!layers.satellites || !satSet || !satSelected.length) return;
    const build = () => {
      const wanted = new Set(satSelected);
      setSatTracks(
        satSet.set.satellites
          .filter((t) => {
            const sat = satrecOf(t);
            return sat && wanted.has(sat.id);
          })
          .map((t) => ({
            id: satrecOf(t)!.id,
            name: t.name,
            lines: groundTrack(t, Date.now()),
          })),
      );
    };
    build();
    const timer = window.setInterval(build, 120000);
    return () => window.clearInterval(timer);
  }, [layers.satellites, satSet, satSelected]);
  // Wird jetzt **immer** geladen, nicht mehr nur bei eingeschalteter
  // Radarebene: Daraus entsteht die Aussage „Regen erreicht dich um …", und
  // die soll auch dann dastehen, wenn niemand ans Radar gedacht hat.
  // Serverseitig sind die Daten drei Minuten gecacht, die Antwort ist klein.
  const radarForecast = useApi(
    `radar-forecast:${geoKey}`,
    () => fetchRadarForecast(coords),
    [coords, refreshTick],
    { refreshMs: 300_000 },
  );

  /** „Wann erreicht mich der Regen?" — aus derselben Vorhersage gerechnet. */
  const [nowcast, setNowcast] = useState<Nowcast | null>(null);
  useEffect(() => {
    const data = radarForecast.data?.data;
    if (!data?.frames.length) {
      setNowcast(null);
      return;
    }
    let cancelled = false;
    nowcastAt(data)
      .then((n) => !cancelled && setNowcast(n))
      .catch(() => !cancelled && setNowcast(null));
    return () => {
      cancelled = true;
    };
  }, [radarForecast.data]);
  const rainAhead = nowcast ? nowcastText(nowcast) : null;
  // Das ADS-B-Netz liefert nur einen Umkreis um die Kartenmitte — bei sehr
  // weitem Ausschnitt wäre das Bild irreführend, also gar nicht erst abfragen.
  const wideViewport = viewport.east - viewport.west > 8;
  // Flug- und Schiffspositionen veralten in Sekunden — pollen, nicht cachen.
  const aircraft = useApi(`aircraft:${viewKey}`, () => fetchAircraft(viewport), [viewKey, refreshTick], {
    enabled: layers.aircraft && !wideViewport,
    refreshMs: 15000,
    cache: false,
  });
  // BOS-Mittel sind selten und wichtig: Anders als beim allgemeinen Flugbild
  // lohnt die Abfrage auch über einem weiten Ausschnitt — der Umkreis um die
  // Kartenmitte deckt ein gutes Stück Deutschland ab.
  const bosair = useApi(`bosair:${viewKey}`, () => fetchBosAircraft(viewport), [viewKey, refreshTick], {
    enabled: layers.bosair,
    refreshMs: 20000,
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
  // Löschwasser: dieselbe Überlegung wie bei den Rettungspunkten, nur dichter —
  // der Server nimmt deshalb nur kleine Ausschnitte an.
  const fireWater = useApi(`water:${viewKey}`, () => fetchFireWater(viewport), [viewKey, refreshTick], {
    enabled: layers.water,
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
  /**
   * Nur was den Standort wirklich überdeckt — die Rechtecke sind großzügig.
   * Ungefiltert nach Stufe: Das Banner siebt selbst, die Lage-Ampel braucht
   * dagegen auch die milderen Warnungen.
   */
  const homeWeatherWarnings = useMemo(
    () => (homeWarnings.data?.data ?? []).filter((w) => pointInGeometry(coords, w.geometry)),
    [homeWarnings.data, coords],
  );
  const homeCivilWarnings = useMemo(
    () => (homeCivil.data?.data ?? []).filter((w) => pointInGeometry(coords, w.geometry)),
    [homeCivil.data, coords],
  );
  const alerts = useMemo(
    () => collectAlerts(homeWeatherWarnings, homeCivilWarnings),
    [homeWeatherWarnings, homeCivilWarnings],
  );

  /**
   * Warnungen, die den Standort betreffen, gehören ins Logbuch — aber jede nur
   * einmal: Dieselbe Warnung liegt bei jeder Aktualisierung wieder vor.
   * Läuft kein Einsatz, passiert hier nichts.
   */
  useEffect(() => {
    for (const a of alerts) logOnce(`warn:${a.id}`, 'warning', `${a.origin}: ${a.headline}`, coords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts, coords.lat, coords.lon]);

  const news = useApi(`news:${geoKey}`, () => fetchNews(coords), [coords, refreshTick]);
  // Blaulicht-Meldungen sind Pressetexte, keine Live-Lage — der Feed selbst
  // erneuert sich alle paar Minuten, häufigeres Nachfragen brächte nichts.
  const blaulicht = useApi(`blaulicht:${geoKey}`, () => fetchBlaulicht(coords), [coords, refreshTick], {
    refreshMs: 300_000,
  });
  /** Nur die Meldungen zu tatsächlichen Vorfällen — der Rest ist Pressearbeit. */
  const blaulichtIncidents = useMemo(
    () => (blaulicht.data?.data ?? []).filter((b) => b.incident),
    [blaulicht.data],
  );
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
  /**
   * Was der Server je Region anbietet.
   *
   * **Achtung bei neuen Paketarten:** Die Felder stehen hier einzeln — eine
   * neue Art muss in `PACKAGE_EXT`, im Server-Verzeichnis, in `KINDS` der
   * Offline-Ansicht **und hier** auftauchen, sonst wird sie nie angeboten und
   * damit nie heruntergeladen.
   */
  const availableMap: Record<string, RegionFiles> = Object.fromEntries(
    (maps.data?.data ?? []).map((m) => [
      m.code,
      { map: m.map, route: m.route, search: m.search, terrain: m.terrain, pop: m.pop },
    ]),
  );
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  useEffect(() => saveSettings(settings), [settings]);

  /**
   * Nachtsicht und große Bedienziele hängen am Wurzelelement, nicht an einzelnen
   * Bauteilen: Der Rotfilter muss über **allem** liegen, auch über der Karte und
   * über Blättern, und die Vergrößerung soll jeden Knopf treffen — auch die, die
   * erst später dazukommen.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-night-red', settings.nightRed);
    root.toggleAttribute('data-big-targets', settings.bigTargets);
  }, [settings.nightRed, settings.bigTargets]);

  /** Hell oder dunkel — dieselbe Antwort für Oberfläche und Karte. */
  const dark = useDark(settings.theme);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

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

  /** Heruntergeladene Region, die einen Punkt enthält und den Teil `kind` hat. */
  const regionFor = useCallback(
    (point: Coords, kind: PackageKind): string | null => regionAt(offlineFiles, point, kind),
    [offlineFiles],
  );

  /**
   * Basiskarte: liegt die Region am Standort im Gerät, wird sie genommen —
   * auch mit Netz, denn aus dem OPFS kommt sie schneller und ohne Verkehr.
   */
  const offlineCode = useMemo(() => regionFor(coords, 'map'), [regionFor, coords]);

  /**
   * Sonst die Datei, die der **Server** für diese Gegend hat: PMTiles liest
   * daraus per HTTP-Range nur die gebrauchten Kacheln, ein Download ist dafür
   * nicht nötig. So hat eine frisch eingerichtete Installation vom ersten
   * Aufruf an eine Karte — vorher hing die Basiskarte an einer fremden
   * Demo-Datei, die der Browser gar nicht laden durfte.
   */
  const serverMapUrl = useMemo(() => {
    if (PMTILES_OVERRIDE) return PMTILES_OVERRIDE;
    const code = regionAt(availableMap, coords, 'map');
    return code ? serverPmtilesUrl(code) : null;
    // availableMap wird bei jedem Lauf neu gebaut; der Inhalt zählt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maps.data, coords]);

  /**
   * Die grobe Weltkarte des Servers als Untergrund, solange keine im Gerät
   * liegt: Ein Bundesland-Ausschnitt endet an seiner Grenze, und wer
   * herauszoomt, säße sonst vor einer leeren Fläche.
   */
  const worldServerUrl = useMemo(
    () => (availableMap[WORLD_CODE]?.map ? serverPmtilesUrl(WORLD_CODE) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maps.data],
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

  /* ---------- Eine bestimmte Fahrt verfolgen ---------- */

  /**
   * Anders als beim angetippten Fahrzeug hängt die verfolgte Fahrt **nicht am
   * Kartenausschnitt**: Ihre Position wird aus ihrem eigenen Fahrplan
   * gerechnet. Sie bleibt damit auch dann richtig, wenn die Ebene aus ist oder
   * der Zug längst aus dem Bild gefahren ist — genau darum geht es beim
   * Verfolgen.
   */
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [trackId, setTrackId] = useState<string | null>(null);
  /** Soll die Karte der Fahrt nachziehen? */
  const [trackFollow, setTrackFollow] = useState(false);
  const journeyState = useApi(
    `journey:${trackId ?? ''}`,
    () => (trackId ? fetchJourney(trackId).then((r) => r.data) : Promise.resolve(null)),
    [trackId],
    { enabled: !!trackId, refreshMs: 15000, cache: false },
  );
  const journey = journeyState.data;

  /** Eine Fahrt in Verfolgung nehmen — von der Suche oder aus einem Blatt. */
  const startTracking = useCallback((tripId: string) => {
    setTrackId(tripId);
    setJourneyOpen(true);
    // Zwei Fahrtwege gleichzeitig wären auf der Karte nicht zu unterscheiden.
    setVehicle(null);
    setStopTrip(null);
    setTripFit((n) => n + 1);
  }, []);
  const stopTracking = useCallback(() => {
    setTrackId(null);
    setTrackFollow(false);
  }, []);

  // Karte nachziehen, solange „folgen" eingeschaltet ist. Abhängig nur von den
  // Koordinaten: Jede Auffrischung liefert ein neues Objekt, aber nicht
  // zwangsläufig eine neue Stelle — sonst ruckelte die Karte ohne Anlass.
  const followLat = trackFollow ? (journey?.position?.lat ?? null) : null;
  const followLon = trackFollow ? (journey?.position?.lon ?? null) : null;
  useEffect(() => {
    if (followLat == null || followLon == null) return;
    setFlyTo({ lat: followLat, lon: followLon, zoom: 13, key: Date.now() });
  }, [followLat, followLon]);

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
  /**
   * Lagebild der gewählten Strecke: Warnungen, Regen, Wind und Verkehr entlang
   * der Fahrt, jeweils zu der Zeit, zu der man dort ist. Nur online — die
   * Auswertung ist lokal, die Daten dafür sind es nicht.
   */
  const situation = useRouteSituation(route, online && profile !== 'transit', refreshTick);

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

  /** Verlangt der Server ein Passwort? Nur dann gibt es „Gerät absperren". */
  const authRequired = health.data?.auth === true;

  /* ---------- Ansicht teilen ---------- */
  const [shareOpen, setShareOpen] = useState(false);
  const [mapApi, setMapApi] = useState<MapApi | null>(null);
  // Ein geteilter Link bringt Ausschnitt und Ebenen mit — einmal beim Start
  // anwenden und den Hash danach entfernen, damit er nicht kleben bleibt.
  useEffect(() => {
    const shared = sharedView.current;
    if (!shared) return;
    setCoords({ lat: shared.lat, lon: shared.lon });
    setViewport(boxAround({ lat: shared.lat, lon: shared.lon }));
    setPlace('Geteilte Ansicht');
    setFlyTo({ lat: shared.lat, lon: shared.lon, zoom: shared.zoom, key: Date.now() });
    if (shared.layers.length) setApplyLayers({ layers: shared.layers, key: Date.now() });
    clearShareUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Meine Orte ---------- */
  const [watched, setWatched] = useState<WatchedPlace[]>(() => loadWatched());
  /**
   * Der Service Worker kommt an den localStorage nicht heran — die Orte, an
   * denen er im Hintergrund nach Warnungen sehen soll, werden ihm deshalb in
   * die gemeinsame Datenbank gelegt. Das kostet nichts, solange niemand die
   * Hintergrund-Warnungen eingeschaltet hat: Ohne Anmeldung liest sie niemand.
   */
  useEffect(() => {
    void syncBackgroundTargets(coords, watched);
  }, [coords, watched]);
  const [watchedOpen, setWatchedOpen] = useState(false);
  useEffect(() => saveWatched(watched), [watched]);
  const watchedStates = useWatchedStatus(watched, refreshTick);
  const watchedWorst = worstSeverity(watchedStates);
  const watchedAlerts = Object.values(watchedStates).reduce((n, s) => n + s.alerts.length, 0);
  /** Für die Karte: Ort samt seiner Warnlage (`ok` oder die schwerste Stufe). */
  const watchedPoints = useMemo(
    () =>
      watched.map((p) => ({
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        state: watchedStates[p.id]?.alerts[0]?.severity ?? 'ok',
      })),
    [watched, watchedStates],
  );

  const addWatched = (place: { name: string; lat: number; lon: number }) => {
    setWatched((prev) =>
      prev.length >= MAX_WATCHED ||
      prev.some((p) => Math.abs(p.lat - place.lat) < 1e-4 && Math.abs(p.lon - place.lon) < 1e-4)
        ? prev
        : [...prev, { id: newPlaceId(), ...place }],
    );
  };

  /* ---------- Wander- und Radwegenetz ---------- */
  const [trails, setTrails] = useState<TrailFeature[]>([]);
  /** Das Paket ist noch ohne Wegenetz gebaut — dann bleibt die Ebene leer. */
  const [trailsStale, setTrailsStale] = useState(false);
  useEffect(() => {
    if (!layers.trails || !viewport) {
      setTrails([]);
      return;
    }
    // Bei sehr weitem Ausschnitt bringt die Ebene nichts als Rechenlast — die
    // Kartenebene blendet sich unter Zoom 10 ohnehin aus.
    const span = Math.max(viewport.north - viewport.south, viewport.east - viewport.west);
    if (span > 1.2) {
      setTrails([]);
      return;
    }
    const codes = statesForCorridor(
      { lat: viewport.south, lon: viewport.west },
      { lat: viewport.north, lon: viewport.east },
    ).filter((code) => offlineFiles[code]?.route);
    if (!codes.length) {
      setTrails([]);
      return;
    }
    let cancelled = false;
    trailsOffline(codes, viewport, 7)
      .then((r) => {
        if (cancelled) return;
        setTrails(r.features);
        setTrailsStale(r.stale);
      })
      .catch(() => !cancelled && setTrails([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.trails, viewKey, offlineFiles]);

  /* ---------- Erreichbarkeit ---------- */

  /**
   * Wie weit komme ich in einer Stunde? Gerechnet wird **einmal** mit dem
   * größten Budget; die Stufen 15 und 30 Minuten stecken schon in den
   * Fahrzeiten je Abschnitt und werden auf der Karte nur eingefärbt. Ein
   * eigener Lauf je Stufe würde dieselbe Suche dreimal machen.
   */
  const [reach, setReach] = useState<ReachResult | null>(null);
  const [reachBusy, setReachBusy] = useState(false);
  const [reachProfile, setReachProfile] = useState<RouteProfile>('car');
  const reachOrigin = startPoint;
  useEffect(() => {
    if (!layers.reach) {
      setReach(null);
      return;
    }
    const codes = statesForCorridor(reachOrigin, reachOrigin).filter((code) => offlineFiles[code]?.route);
    if (!codes.length) {
      setReach(null);
      return;
    }
    let cancelled = false;
    setReachBusy(true);
    reachOffline(codes, reachOrigin, reachProfile, REACH_BUDGET_S)
      .then((r) => !cancelled && setReach(r))
      .catch(() => !cancelled && setReach(null))
      .finally(() => !cancelled && setReachBusy(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.reach, reachOrigin.lat, reachOrigin.lon, reachProfile, offlineFiles]);


  /* ---------- Höhenprofil der angezeigten Spur ---------- */
  const [trackProfile, setTrackProfile] = useState<ElevationProfile | null>(null);
  useEffect(() => {
    const points = shownTrack?.points ?? [];
    if (points.length < 2) {
      setTrackProfile(null);
      return;
    }
    const line = points.map((p) => [p.lon, p.lat] as [number, number]);
    // Eigene Höhen aus der Aufzeichnung bzw. der eingelesenen Datei haben
    // Vorrang — die wurden am Gerät gemessen.
    const own = points.map((p) => p.ele);
    const codes = statesForCorridor(
      { lat: points[0]!.lat, lon: points[0]!.lon },
      { lat: points[points.length - 1]!.lat, lon: points[points.length - 1]!.lon },
    ).filter((code) => offlineFiles[code]?.terrain);
    if (!codes.length && !own.some((e) => e != null)) {
      setTrackProfile(null);
      return;
    }
    let cancelled = false;
    elevationOffline(codes, line, own)
      .then((r) => !cancelled && setTrackProfile(r))
      .catch(() => !cancelled && setTrackProfile(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownTrack, offlineFiles]);

  /* ---------- Lawinenlage ---------- */
  /**
   * Zwei Abrufe mit sehr unterschiedlicher Haltbarkeit:
   *
   * Die **Lage** hängt am `refreshTick` und erneuert sich damit beim Neuladen,
   * beim Knopf „Aktualisieren" und im selbsttätigen Takt — halbstündlich, denn
   * öfter veröffentlichen die Warndienste nicht. Die **Flächen** holt die App
   * einmal; sie ändern sich höchstens zur neuen Saison und liegen im
   * Zwischenspeicher, damit sie auch ohne Netz da sind.
   */
  const avalanche = useApi('avalanche', () => fetchAvalanche(), [refreshTick], {
    enabled: layers.avalanche,
    refreshMs: 1_800_000,
  });
  const [avalancheRegions, setAvalancheRegions] = useState<Map<string, GeoJSON.Geometry> | null>(null);
  useEffect(() => {
    if (!layers.avalanche || avalancheRegions) return;
    let cancelled = false;
    withCache('avalanche-regions', () => fetchAvalancheRegions())
      .then((r) => {
        if (cancelled) return;
        setAvalancheRegions(
          new Map(r.value.regions.map((x) => [x.id, x.geometry as unknown as GeoJSON.Geometry])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [layers.avalanche, avalancheRegions]);

  /** Lage und Flächen zusammenführen — nur Regionen, für die es beides gibt. */
  const avalancheFeatures = useMemo(() => {
    const report = avalanche.data?.data;
    if (!report || !avalancheRegions) return null;
    const features: GeoJSON.Feature[] = [];
    for (const r of report.regions) {
      const geometry = avalancheRegions.get(r.id);
      if (!geometry) continue;
      features.push({
        type: 'Feature',
        properties: {
          id: r.id,
          danger: r.danger,
          dangerBelow: r.dangerBelow ?? null,
          dangerAbove: r.dangerAbove ?? null,
          boundary: r.boundary ?? null,
          problems: r.problems.join(', '),
          text: r.text ?? null,
          source: r.source,
          validUntil: r.validUntil,
        },
        geometry,
      });
    }
    return { type: 'FeatureCollection' as const, features };
  }, [avalanche.data, avalancheRegions]);

  /* ---------- Höhenlinien ---------- */
  const [contours, setContours] = useState<ContourLine[]>([]);
  useEffect(() => {
    if (!layers.contours || !viewport) {
      setContours([]);
      return;
    }
    // Weiter als ein Grad ergibt keine lesbare Höhenkarte mehr und kostet nur
    // Rechenzeit — die Ebene blendet sich unter Zoom 10 ohnehin aus.
    const span = Math.max(viewport.north - viewport.south, viewport.east - viewport.west);
    if (span > 1) {
      setContours([]);
      return;
    }
    const codes = statesForCorridor(
      { lat: viewport.south, lon: viewport.west },
      { lat: viewport.north, lon: viewport.east },
    ).filter((code) => offlineFiles[code]?.terrain);
    if (!codes.length) {
      setContours([]);
      return;
    }
    let cancelled = false;
    contoursOffline(codes, viewport)
      .then((r) => !cancelled && setContours(r.lines))
      .catch(() => !cancelled && setContours([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers.contours, viewKey, offlineFiles]);

  /* ---------- Geländeebene ---------- */
  const [terrainImage, setTerrainImage] = useState<
    { url: string; bounds: [number, number, number, number]; key: number } | null
  >(null);
  /** Region mit Höhenpaket in der Mitte des Ausschnitts. */
  const terrainCode = useMemo(
    () => regionFor(coords, 'terrain'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coords.lat, coords.lon, offlineFiles],
  );
  /**
   * Regionen mit Einwohner-Paket in der Nähe. Die Pakete überlappen sich an
   * den Rändern — welche Region tatsächlich zählt, entscheidet der Worker
   * anhand des Mittelpunkts der Abfrage, damit niemand doppelt gezählt wird.
   */
  const popCodes = useMemo(
    () => statesForCorridor(coords, coords).filter((code) => offlineFiles[code]?.pop),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coords.lat, coords.lon, offlineFiles],
  );
  useEffect(() => {
    if (!layers.terrain || !terrainCode) {
      setTerrainImage(null);
      return;
    }
    let cancelled = false;
    terrainImageOffline(terrainCode)
      .then((img) => {
        if (cancelled || !img) return;
        const url = imageFromRgba(img.width, img.height, img.rgba);
        if (url) setTerrainImage({ url, bounds: img.bounds, key: Date.now() });
      })
      .catch(() => !cancelled && setTerrainImage(null));
    return () => {
      cancelled = true;
    };
  }, [layers.terrain, terrainCode]);

  /* ---------- Schattenwurf ---------- */

  /**
   * Uhrzeit, für die der Schatten gilt — in Minuten seit Mitternacht des
   * heutigen Tages. `null` heißt „jetzt" und wandert mit der Uhr mit.
   */
  const [shadowMinutes, setShadowMinutes] = useState<number | null>(null);
  const [shadowImage, setShadowImage] = useState<
    { url: string; bounds: [number, number, number, number]; key: number; night: boolean } | null
  >(null);
  /**
   * Solange „jetzt" gilt, wandert der Schatten mit der Sonne — alle fünf
   * Minuten reicht dafür völlig (die Sonne läuft 1,25° in dieser Zeit).
   */
  const [shadowTick, setShadowTick] = useState(0);
  useEffect(() => {
    if (!layers.shadow || shadowMinutes != null) return;
    const t = setInterval(() => setShadowTick((n) => n + 1), 300_000);
    return () => clearInterval(t);
  }, [layers.shadow, shadowMinutes]);

  /** Sonnenstand zur gewählten Zeit am Standort. */
  const shadowSun = useMemo(() => {
    const when = new Date();
    if (shadowMinutes != null) {
      when.setHours(Math.floor(shadowMinutes / 60), shadowMinutes % 60, 0, 0);
    }
    return {
      when,
      altitude: sunAltitude(when, coords.lat, coords.lon),
      azimuth: sunAzimuth(when, coords.lat, coords.lon),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowMinutes, coords.lat, coords.lon, shadowTick]);

  useEffect(() => {
    if (!layers.shadow || !terrainCode) {
      setShadowImage(null);
      return;
    }
    let cancelled = false;
    shadowOffline(terrainCode, shadowSun.altitude, shadowSun.azimuth)
      .then((img) => {
        if (cancelled || !img) return;
        const url = imageFromRgba(img.width, img.height, img.rgba);
        if (url) setShadowImage({ url, bounds: img.bounds, key: Date.now(), night: img.night });
      })
      .catch(() => !cancelled && setShadowImage(null));
    return () => {
      cancelled = true;
    };
  }, [layers.shadow, terrainCode, shadowSun.altitude, shadowSun.azimuth]);


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
  const loadGpxRoute = async (file: File): Promise<string | null> => {
    setRouteError(null);
    try {
      const result = await readImport(file.name, await file.arrayBuffer());
      const longest = result.lines
        .map((l) => ({ line: l, length: trackLength(l.points) }))
        .sort((a, b) => b.length - a.length)[0];
      if (!longest) {
        const message = `In „${file.name}" steckt keine Linie, der man folgen könnte.`;
        setRouteError(message);
        return message;
      }
      setGpxChoice({
        name: longest.line.name,
        coords: longest.line.points.map((p) => [p.lon, p.lat] as [number, number]),
        // GPX bringt oft eigene Höhen mit — die sind am Gerät gemessen und
        // schlagen jedes Geländemodell.
        ele: longest.line.points.map((p) => p.ele),
        source: result.source,
      });
      // Die Suche kann sich schließen — die Wahl der Folgeart übernimmt jetzt
      // das Übernahme-Blatt.
      setSearchOpen(false);
      return null;
    } catch (e) {
      const message = e instanceof ImportError ? e.message : `„${file.name}" ließ sich nicht lesen.`;
      setRouteError(message);
      return message;
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
    if (navigating) logEvent('route', 'Zielführung beendet', coords);
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
    logEvent('route', `Zielführung gestartet: ${destination?.name ?? 'Ziel'}`, coords);
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
    kind: 'destination' | 'origin' | 'via' | 'place' | 'radio' | 'bearing' | 'watch' | 'info' | 'sight' | 'hazmat',
    label?: string,
  ) => {
    if (kind === 'radio') {
      setHfTarget(point);
      return;
    }
    if (kind === 'sight') {
      setSightTo({ point, label: label ?? null });
      return;
    }
    if (kind === 'hazmat') {
      setHazmatAt({ point, label: label ?? 'angetippte Stelle' });
      return;
    }
    if (kind === 'info') {
      setPointInfo({ point, label: label ?? null });
      return;
    }
    if (kind === 'watch') {
      addWatched({
        name: label ?? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
        ...point,
      });
      setWatchedOpen(true);
      return;
    }
    if (kind === 'bearing') {
      setBearingTarget({
        name: label ?? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
        ...point,
      });
      setCompassOpen(true);
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
    blaulicht: { title: 'Blaulicht-Meldungen', source: blaulicht.data?.source, savedAt: blaulicht.savedAt },
    bosair: { title: 'BOS-Luftfahrzeuge', source: bosair.data?.source, savedAt: bosair.savedAt },
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

  /**
   * Die Lage-Ampel: aus allem, was hier gilt, eine Stufe und ein Satz. Rein
   * gerechnet aus Daten, die ohnehin geladen sind — die Waldbrandgefahr geht
   * nur ein, wenn ihre Ebene das Gitter schon geholt hat; für eine Zahl ein
   * bundesweites Raster nachzuladen wäre es nicht wert.
   */
  const nowSituation = useMemo(
    () =>
      situationNow({
        weatherWarnings: homeWeatherWarnings,
        civilWarnings: homeCivilWarnings,
        weather: w ?? null,
        nowcast,
        air: airNow,
        fireDanger: fire.data?.data ? fireDangerAt(fire.data.data, coords.lat, coords.lon) : null,
        sunsetMs: sunTimes(new Date(), coords.lat, coords.lon).sunset?.getTime() ?? null,
        online,
        lastSyncMs: lastSync ?? null,
      }),
    [homeWeatherWarnings, homeCivilWarnings, w, nowcast, airNow, fire.data, coords, online, lastSync],
  );

  /** Was die Werkzeugliste auf dem „Mehr"-Reiter öffnet. */
  const MORE_ACTIONS: Record<string, () => void> = {
    notfall: () => setEmergencyOpen(true),
    // Ohne angetippte Stelle gilt der eigene Standort als Gefahrenort — das
    // ist der häufigste Fall: Man steht darin.
    flucht: () => setEscapeFrom({ danger: coords, label: 'Mein Standort' }),
    kartenblatt: () => setMapSheetOpen(true),
    satelliten: () => setSatOpen(true),
    kompass: () => setCompassOpen(true),
    logbuch: () => setMissionOpen(true),
    gefahrgut: () => setHazmatAt({ point: coords, label: 'Mein Standort' }),
    verfolgen: () => setJourneyOpen(true),
    spur: () => setTrackOpen(true),
    teilen: () => setShareOpen(true),
    offline: () => setRegionsOpen(true),
    einstellungen: () => setSettingsOpen(true),
  };

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

        {/* Die Werkzeuge stehen zusammen, damit sie auf schmalen Geräten
            geschlossen in die zweite Zeile rutschen können. Am Rechner löst
            `display: contents` die Gruppe wieder auf — dort ändert sich nichts. */}
        <div className="topbar-tools">
        <button
          type="button"
          className="iconbtn ib-search"
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
          className={`iconbtn ib-refresh${anyLoading ? ' is-busy' : ''}`}
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

        {/* Werkzeuge: dieselbe Liste wie auf dem „Mehr"-Reiter. Der rote Punkt
            meldet eine laufende Spuraufzeichnung, die sonst hier ihr eigenes
            Symbol hatte. */}
        <button
          type="button"
          className={`iconbtn ib-tools${recorder.recording || missionRunning ? ' is-rec' : ''}`}
          onClick={() => setToolsOpen(true)}
          title={missionRunning ? 'Werkzeuge — Einsatz läuft' : 'Werkzeuge'}
          aria-label="Werkzeuge"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4 4 0 0 0 5.3 5.3l-8 8a2.8 2.8 0 0 1-4-4z" />
            <path d="M14.7 6.3 17 4l3 3-2.3 2.3" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbtn ib-emergency"
          onClick={() => setEmergencyOpen(true)}
          title="Notfall: Nummern, Standort, Fluchtweg"
          aria-label="Notfall"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 2.5 20h19z" />
            <path d="M12 9v5M12 17h.01" />
          </svg>
        </button>

        {/* Hell/Dunkel. Ein Druck legt es fest — „dem System folgen" steht in
            den Einstellungen, weil man das einmal entscheidet und nicht
            unterwegs. */}
        <button
          type="button"
          className="iconbtn ib-theme"
          onClick={() => setSettings((prev) => ({ ...prev, theme: dark ? 'light' : 'dark' }))}
          title={dark ? 'Helle Darstellung' : 'Dunkle Darstellung'}
          aria-label={dark ? 'Helle Darstellung' : 'Dunkle Darstellung'}
        >
          {dark ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" />
            </svg>
          )}
        </button>


        </div>
      </header>

      <div className="statusline" data-state={online && !anyCached ? 'live' : 'offline'}>
        <span className="live"><i />{online && !anyCached ? 'LIVE' : 'OFFLINE'}</span>
        <span>
          {lastSync ? `Aktualisiert ${relativeTime(new Date(lastSync).toISOString())}` : 'Lade …'}
          {(!online || anyCached) && ' · letzter Stand'}
        </span>
      </div>

      {alerts.length > 0 && <AlertBanner alerts={alerts} onOpen={(d) => setDetail(d)} />}

      <div className="layout" data-tab={tab}>
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
            baseUrl={serverMapUrl}
            route={route}
            itinerary={profile === 'transit' ? (itineraries[itineraryIndex] ?? null) : null}
            muf={mufGrid}
            news={news.data?.data ?? []}
            blaulicht={blaulicht.data?.data ?? []}
            bosair={bosair.data?.data ?? []}
            flyTo={flyTo}
            hfPath={hfForecast?.line ?? null}
            stops={stopPoints}
            vehicles={vehicles.data?.data ?? []}
            onVehicleClick={selectVehicle}
            onTripOpen={() =>
              trackId
                ? setJourneyOpen(true)
                : vehicle
                  ? setVehicleSheet(true)
                  : setTripFit((n) => n + 1)
            }
            onTripClear={() => {
              setVehicle(null);
              setStopTrip(null);
              stopTracking();
            }}
            vehicleTrip={
              // Die verfolgte Fahrt hat Vorrang: Sie ist die eine, die im Blick
              // bleiben soll — auch bei ausgeschalteter Fahrzeugebene.
              journey?.geometry.length
                ? {
                    geometry: journey.geometry,
                    at: journey.position,
                    color: STOP_COLOR[kindOfProduct(journey.product)] ?? '#1d4e73',
                    label: journey.line,
                    fitKey: tripFit,
                    tracking: true,
                    marker: journey.position
                      ? {
                          kind: kindOfProduct(journey.product),
                          bearing: journey.position.bearing,
                          line: journey.line,
                        }
                      : null,
                  }
                : vehicleNow && vehicleTripState.data?.geometry.length
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
            fireWater={fireWater.data?.data ?? []}
            popCodes={popCodes}
            hazmatZone={hazmatZone}
            reach={reach}
            reachBusy={reachBusy}
            reachProfile={reachProfile}
            onReachProfile={setReachProfile}
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
            terrainImage={terrainImage}
            shadowImage={shadowImage}
            shadowMinutes={shadowMinutes}
            onShadowMinutes={setShadowMinutes}
            shadowAltitude={shadowSun.altitude}
            dark={dark}
            worldOffline={!!offlineFiles[WORLD_CODE]?.map}
            worldServerUrl={worldServerUrl}
            satellites={satPositions}
            satTracks={satTracks}
            onSatelliteSetup={() => setSatOpen(true)}
            trails={trails}
            contours={contours}
            avalanche={avalancheFeatures}
            watchedPoints={watchedPoints}
            onMapApi={setMapApi}
            onShare={() => setShareOpen(true)}
            trailsHint={
              trailsStale
                ? 'Das gespeicherte Routing-Paket dieser Region kennt noch kein Wegenetz — neu laden oder neu bauen.'
                : null
            }
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
              elevationHint={
                elevation || profile === 'transit'
                  ? null
                  : terrainCodes.length
                    ? null
                    : 'Für das Höhenprofil fehlt das Geländepaket dieser Region — im Offline-Bildschirm ladbar.'
              }
              situation={
                <RouteSituationView
                  state={situation}
                  onShow={(lat, lon) => showOnMap(lat, lon, 11)}
                />
              }
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
        {/* Ganz oben, vor allen Kacheln: die eine Antwort. Alles darunter ist
            die Begründung. */}
        <SituationLight
          situation={nowSituation}
          onDetails={() => setDetail(homeCivilWarnings.length ? 'nina' : 'warnings')}
        />
        <Tile tab="mehr" title="Wetter" source={weather.data?.source} cached={weather.fromCache} className="warnborder" onOpen={w ? () => setDetail('weather') : undefined}>
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

              {/* Was in den nächsten zwei Stunden vom Himmel kommt — aus der
                  Radarvorhersage des DWD, nicht aus der Stundenvorhersage.
                  Fünf-Minuten-Schritte statt Stundenmittel: nur so lässt sich
                  ein Schauer überhaupt ankündigen. */}
              {rainAhead && (
                <div className={`wx-nowcast${rainAhead.urgent ? ' is-urgent' : ''}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M7 17.5a4.5 4.5 0 0 1 .4-9 6 6 0 0 1 11.3 1.6 3.9 3.9 0 0 1-.7 7.4" />
                    <path d="M9 20l-1 2M13 20l-1 2M17 20l-1 2" />
                  </svg>
                  <span>{rainAhead.text}</span>
                  {nowcast && nowcast.peakMmH >= 0.3 && (
                    <b className="mono">{nowcast.peakMmH.toFixed(1).replace('.', ',')} mm/h</b>
                  )}
                </div>
              )}

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

        {watched.length > 0 && (
          <Tile
            tab="lage"
            title="Meine Orte"
            badge={watchedAlerts > 0 ? `${watchedAlerts} Warnung${watchedAlerts === 1 ? '' : 'en'}` : undefined}
            badgeKind={watchedWorst === 'extreme' || watchedWorst === 'severe' ? 'alert' : 'warn'}
            source={watchedAlerts === 0 ? 'alles ruhig' : undefined}
            onOpen={() => setWatchedOpen(true)}
          >
            <ul className="wp-mini">
              {watched.slice(0, 4).map((p) => {
                const worst = watchedStates[p.id]?.alerts[0];
                return (
                  <li key={p.id}>
                    <span
                      className="wp-dot"
                      style={{ background: worst ? `var(${SEVERITY_VAR[worst.severity]})` : 'var(--ok)' }}
                      aria-hidden="true"
                    />
                    <span className="wp-mini-name">{p.name}</span>
                    <span className="muted">{worst ? worst.headline : 'ruhig'}</span>
                  </li>
                );
              })}
              {watched.length > 4 && <li className="muted">… und {watched.length - 4} weitere</li>}
            </ul>
          </Tile>
        )}

        <Tile tab="lage" title="Im Ausschnitt" source="im Kartenausschnitt gezählt">
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
            <CountCell
              label="BOS-Luft"
              value={layers.bosair ? (bosair.data?.data.length ?? null) : null}
              loading={layers.bosair && bosair.loading}
              color={bosair.data?.data.length ? 'var(--sev3)' : undefined}
              hint={layers.bosair ? 'Rettungs- und Polizeiflug' : 'Ebene ausgeschaltet'}
              onOpen={bosair.data?.data.length ? () => setDetail('bosair') : undefined}
            />
          </div>
        </Tile>

        <Tile
          tab="oepnv"
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
          tab="mehr"
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
          tab="mehr"
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

        {/* Blaulicht: In der Kachel stehen nur die Meldungen zu tatsächlichen
            Vorfällen — Zeugenaufrufe und Aktionstage würden die kurze Liste
            sonst zumüllen. Vollständig ist erst die Detailansicht. */}
        <Tile
          tab="lage"
          title="Blaulicht"
          badge={blaulichtIncidents.length ? `${blaulichtIncidents.length}` : undefined}
          badgeKind="warn"
          source={blaulicht.data?.source}
          cached={blaulicht.fromCache}
          wide
          onOpen={blaulicht.data ? () => setDetail('blaulicht') : undefined}
        >
          <Loader state={blaulicht} empty="Keine Meldungen.">
            <ul className="news">
              {(blaulichtIncidents.length ? blaulichtIncidents : (blaulicht.data?.data ?? []))
                .slice(0, 5)
                .map((b) => (
                  <li className="news-item has-ico" key={b.id}>
                    <BlaulichtIcon kind={b.kind} size={16} />
                    <a href={b.url} target="_blank" rel="noreferrer">{b.title}</a>
                    <span className="tm">
                      {b.place ? `${b.place.name} · ` : ''}
                      {relativeTime(b.publishedAt)}
                    </span>
                  </li>
                ))}
            </ul>
          </Loader>
        </Tile>

        {/* Dasselbe für den ÖPNV-Reiter: Die Kachel oben nennt nur den nächsten
            Halt. Auf einer eigenen Seite gehören alle Halte in der Nähe hin. */}
        {transitStops.length > 0 && (
          <section className="mobile-only tile" data-tab="oepnv">
            <div className="head">
              <h3>Halte in der Nähe</h3>
            </div>
            <TransitDetail
              onShowRoute={showTripOnMap}
              onTrack={startTracking}
              stops={transitStops}
              onRoute={(name, lat, lon) => startRouteTo({ name, lat, lon })}
            />
          </section>
        )}

        {/* Auf dem Handy ist „Lage" eine eigene Seite — dort wären acht Zahlen
            allein zu wenig. Die Warnungen stehen deshalb gleich im Klartext
            darunter, statt erst hinter einem weiteren Tipp. Am Rechner
            überflüssig: Dort liegen sie eine Kachel weiter. */}
        <section className="mobile-only tile" data-tab="lage">
          <div className="head">
            <h3>Warnungen im Ausschnitt</h3>
          </div>
          {uniqueWarnings.length > 0 ? (
            <WarningsDetail list={uniqueWarnings} />
          ) : (
            <p className="muted">Keine Unwetterwarnung im Kartenausschnitt.</p>
          )}
        </section>
        {(nina.data?.data.length ?? 0) > 0 && (
          <section className="mobile-only tile" data-tab="lage">
            <div className="head">
              <h3>Behördenwarnungen</h3>
            </div>
            <CivilWarningsDetail list={nina.data?.data ?? []} />
          </section>
        )}

        {/* Auf dem Handy der Reiter „Mehr" — dieselbe Liste steht am Rechner
            im Werkzeugblatt. Eine Quelle, zwei Gestalten. */}
        <section className="more-tools mobile-only" data-tab="mehr">
          <div className="sect-label">Werkzeuge</div>
          <ToolGrid onPick={(key) => MORE_ACTIONS[key]?.()} />
        </section>
        </section>
      </div>

      {/* Untere Leiste — nur auf schmalen Geräten sichtbar. „Suche" schaltet
          nicht um, sondern öffnet ein Blatt; deshalb ist sie nie „aktiv". */}
      <nav className="tabbar" aria-label="Ansicht">
        {TABS.map((t) => {
          const active = t.key !== 'suche' && tab === t.key;
          const count = t.key === 'lage' ? uniqueWarnings.length : 0;
          return (
            <button
              key={t.key}
              type="button"
              className={`tab${active ? ' is-on' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => (t.key === 'suche' ? setSearchOpen(true) : setTab(t.key as MobileTab))}
            >
              <span className="tab-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.path} />
                </svg>
                {count > 0 && <i className="tab-dot">{count > 9 ? '9+' : count}</i>}
              </span>
              {t.label}
            </button>
          );
        })}
      </nav>

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
          onGpxFile={loadGpxRoute}
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
          onSight={() => setSightTo({ point: hfTarget, label: 'Gegenstelle' })}
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
          onStart={() => {
            recorder.start();
            logEvent('track', 'Spuraufzeichnung begonnen', coords);
          }}
          onStop={() => {
            const name = window.prompt(
              'Name der Spur',
              `Spur ${new Date().toLocaleDateString('de-DE')}`,
            );
            // Abbrechen im Namensdialog beendet die Aufzeichnung trotzdem —
            // die Punkte gingen sonst verloren.
            const saved = recorder.stop(name ?? '');
            if (saved) logEvent('track', `Spur gesichert: ${saved.name}`, coords);
            if (saved) setShownTrack(saved);
          }}
          onShow={setShownTrack}
          onBackToStart={(point, name) => {
            startRouteTo({ name: `Start von ${name}`, ...point });
            setTrackOpen(false);
          }}
          shownId={shownTrack?.id ?? null}
          profile={trackProfile}
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

      {pointInfo && (
        <PointSheet
          point={pointInfo.point}
          label={pointInfo.label}
          from={coords}
          warnings={warnings.data?.data ?? []}
          civil={nina.data?.data ?? []}
          rescue={rescue.data?.data ?? []}
          terrainCodes={terrainCode ? [terrainCode] : []}
          searchCode={searchCode}
          onRoute={(p) => {
            setPointInfo(null);
            startRouteTo(p);
          }}
          onEscape={(point, label) => {
            setPointInfo(null);
            setEscapeFrom({ danger: point, label });
          }}
          onSight={(point, label) => {
            setPointInfo(null);
            setSightTo({ point, label });
          }}
          onClose={() => setPointInfo(null)}
        />
      )}

      {toolsOpen && (
        <Sheet
          title="Werkzeuge"
          meta={'dieselbe Liste wie auf dem Reiter „Mehr"'}
          onClose={() => setToolsOpen(false)}
        >
          <ToolGrid
            onPick={(key) => {
              setToolsOpen(false);
              MORE_ACTIONS[key]?.();
            }}
          />
        </Sheet>
      )}

      {mapSheetOpen && (
        <MapSheet
          mapApi={mapApi}
          place={place}
          coords={coords}
          rescue={rescue.data?.data ?? []}
          onClose={() => setMapSheetOpen(false)}
        />
      )}

      {satOpen && (
        <SatelliteSheet
          coords={coords}
          stored={satSet}
          onStored={setSatSet}
          selected={satSelected}
          onSelected={setSatSelected}
          onClose={() => setSatOpen(false)}
        />
      )}

      {sightTo && (
        <SightSheet
          from={coords}
          to={sightTo.point}
          label={sightTo.label}
          terrainCodes={terrainCode ? [terrainCode] : []}
          onClose={() => setSightTo(null)}
        />
      )}

      {escapeFrom && (
        <EscapeSheet
          danger={escapeFrom.danger}
          label={escapeFrom.label}
          from={coords}
          codes={routeCodes}
          initialDistanceM={escapeFrom.minDistanceM}
          windFromDeg={w?.windDirDeg ?? null}
          windKmh={w?.windGustKmh ?? w?.windKmh ?? null}
          onTake={(escape, target) => {
            // Der Fluchtweg läuft über denselben Weg wie eine eingelesene Tour:
            // fertige Linie, der die App folgt. So gilt er auf der Karte, in
            // den Anweisungen und in der Zielführung, ohne dass ihn die normale
            // Routensuche wieder überschreibt.
            setEscapeFrom(null);
            setNavigating(false);
            setRouteOrigin(null);
            setVia([]);
            setPin(null);
            setDestination({ name: 'Sicherer Ort', lat: target.lat, lon: target.lon });
            setGpxLine({ coords: escape.coordinates, name: 'Fluchtweg' });
          }}
          onClose={() => setEscapeFrom(null)}
        />
      )}

      {missionOpen && <MissionSheet coords={coords} onClose={() => setMissionOpen(false)} />}

      {hazmatAt && (
        <HazmatSheet
          at={hazmatAt.point}
          atLabel={hazmatAt.label}
          popCodes={popCodes}
          windFromDeg={w?.windDirDeg ?? null}
          windKmh={w?.windKmh ?? null}
          onShowZone={setHazmatZone}
          onEscape={(radiusM) => {
            // Der Absperrradius aus dem Handbuch ist genau die Vorgabe, die das
            // Fluchtrouting als Kern der Gefahr braucht.
            setHazmatAt(null);
            setEscapeFrom({ danger: hazmatAt.point, label: hazmatAt.label, minDistanceM: radiusM });
          }}
          onClose={() => setHazmatAt(null)}
        />
      )}

      {emergencyOpen && (
        <EmergencySheet
          coords={coords}
          offlineCode={searchCode}
          routeCodes={statesForCorridor(coords, coords).filter((code) => offlineFiles[code]?.route)}
          rescue={rescue.data?.data ?? []}
          onRoute={(p) => {
            setEmergencyOpen(false);
            startRouteTo(p);
          }}
          onEscape={() => {
            setEmergencyOpen(false);
            setEscapeFrom({ danger: coords, label: 'Mein Standort' });
          }}
          onClose={() => setEmergencyOpen(false)}
        />
      )}

      {shareOpen && (
        <ShareSheet
          api={mapApi}
          layers={activeLayers}
          onHandover={(view, features) => {
            // Genau der Weg, den auch ein geteilter Link nimmt — nur ohne Netz.
            setCoords({ lat: view.lat, lon: view.lon });
            setViewport(boxAround({ lat: view.lat, lon: view.lon }));
            setPlace('Übernommene Ansicht');
            setLocationSource('manual');
            setFlyTo({ lat: view.lat, lon: view.lon, zoom: view.zoom, key: Date.now() });
            if (view.layers.length) setApplyLayers({ layers: view.layers, key: Date.now() });
            if (features.length) setAddDraw({ features, key: Date.now() });
          }}
          onClose={() => setShareOpen(false)}
        />
      )}

      {watchedOpen && (
        <WatchedPlacesSheet
          places={watched}
          states={watchedStates}
          coords={coords}
          currentName={place}
          onAddCurrent={() => addWatched({ name: place, lat: coords.lat, lon: coords.lon })}
          onRename={(id, name) =>
            setWatched((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)))
          }
          onRemove={(id) => setWatched((prev) => prev.filter((p) => p.id !== id))}
          onShow={(p) => {
            showOnMap(p.lat, p.lon, 11);
            setWatchedOpen(false);
          }}
          onOpenAlert={(d) => {
            setWatchedOpen(false);
            setDetail(d);
          }}
          onClose={() => setWatchedOpen(false)}
        />
      )}

      {compassOpen && (
        <CompassSheet
          from={coords}
          onProject={(point, name) => {
            // Der berechnete Punkt landet als eigene Markierung — von dort aus
            // ist er anfahrbar, teilbar und überlebt die Sitzung.
            setAddDraw({
              features: [{ id: newId(), name, kind: 'point', geometry: { type: 'Point', coordinates: [point.lon, point.lat] } }],
              key: Date.now(),
            });
            setFlyTo({ lat: point.lat, lon: point.lon, zoom: 15, key: Date.now() });
            setCompassOpen(false);
          }}
          target={bearingTarget}
          onSight={(point, label) => {
            setCompassOpen(false);
            setSightTo({ point, label });
          }}
          onClearTarget={() => setBearingTarget(null)}
          onClose={() => setCompassOpen(false)}
        />
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
          onLock={authRequired ? onLock : undefined}
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

      {journeyOpen && (
        <TrackSheet
          coords={coords}
          viewport={viewport}
          online={online}
          journey={journey}
          tracking={trackId}
          loading={journeyState.loading}
          follow={trackFollow}
          onTrack={startTracking}
          onStopTracking={stopTracking}
          onFollowChange={setTrackFollow}
          onShowOnMap={() => {
            setJourneyOpen(false);
            setTripFit((n) => n + 1);
          }}
          onRouteToStop={(stop) => {
            startRouteTo({ name: stop.name, lat: stop.lat, lon: stop.lon });
            setJourneyOpen(false);
          }}
          onClose={() => setJourneyOpen(false)}
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
          onTrack={(tripId) => {
            setVehicleSheet(false);
            startTracking(tripId);
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
          onTrack={(tripId) => {
            setStopDetail(null);
            startTracking(tripId);
          }}
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
              onTrack={(tripId) => {
                setDetail(null);
                startTracking(tripId);
              }}
              stops={transitStops}
              onRoute={(name, lat, lon) => startRouteTo({ name, lat, lon })}
            />
          )}
          {detail === 'news' && news.data && (
            <NewsDetail list={news.data.data} onShowOnMap={showOnMap} />
          )}
          {detail === 'blaulicht' && blaulicht.data && (
            <BlaulichtDetail list={blaulicht.data.data} onShowOnMap={showOnMap} />
          )}
          {detail === 'bosair' && bosair.data && (
            <BosAirDetail list={bosair.data.data} onShowOnMap={showOnMap} />
          )}
          {detail === 'hf' && hfNow && <HfDetail data={hfNow} />}
        </Sheet>
      )}
    </div>
  );
}

/**
 * Die Werkzeugliste. Zweimal verwendet: als Handy-Reiter „Mehr" und im
 * Werkzeugblatt am Rechner — damit es die Liste nur einmal gibt.
 */
function ToolGrid({ onPick }: { onPick: (key: string) => void }) {
  return (
    <div className="mt-grid">
      {MORE_TOOLS.map((t) => (
        <button key={t.key} type="button" className="mt-item" onClick={() => onPick(t.key)}>
          <span className="mt-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d={t.path} />
            </svg>
          </span>
          <span className="mt-text">
            <b>{t.label}</b>
            <span>{t.hint}</span>
          </span>
          <span className="chevron" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
}

function Tile(props: {
  title: string;
  /** Auf welchem Reiter der schmalen Ansicht die Kachel liegt (siehe MobileTab). */
  tab?: MobileTab;
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
    <article className={cls.join(' ')} data-tab={props.tab} {...interactive}>
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
