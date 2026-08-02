import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  Coords,
  RouteProfile,
  RouteResult,
  Severity,
  TransitItinerary,
  TransitLeg,
  TransitStopPoint,
  WarningFeature,
} from '@lagebild/shared';
import { FEDERAL_STATES } from '@lagebild/shared';
import { DEFAULT_COORDS, fetchWeather, fetchForecast, fetchWarnings, fetchTraffic, fetchPegel, fetchNews, fetchAir, fetchRadar, fetchRadarForecast, fetchAircraft, fetchVessels, fetchAprs, fetchWind, fetchTransit, fetchStops, fetchStopDepartures, fetchPlan, fetchHfSpace, fetchHfMuf, fetchHealth, fetchMaps, type Bbox } from './api.js';
import { useApi } from './useApi.js';
import { LageMap, type ActiveLayers } from './LageMap.js';
import { SearchSheet } from './SearchSheet.js';
import { LocationSheet } from './LocationSheet.js';
import { StopSheet } from './StopSheet.js';
import { HfBands, HfDetail } from './HfPanel.js';
import { HfPathSheet } from './HfPathSheet.js';
import { forecastPath } from './hfPath.js';
import { RoutePanel, type PlanMode } from './RoutePanel.js';
import { OfflineRegions } from './OfflineRegions.js';
import { opfsSupported, listOffline, type PackageKind, type RegionFiles } from './offlineMaps.js';
import { routeOffline, stopsOffline } from './offline/client.js';
import { useNavigation } from './navigation.js';
import { STATE_BOUNDS, inStateBounds, statesContaining, statesForCorridor } from './stateBounds.js';
import { loadFavorites, saveFavorites, type Place } from './places.js';
import { Sheet } from './Sheet.js';
import { WeatherDetail, WarningsDetail, TrafficDetail, PegelDetail, NewsDetail, TransitDetail } from './details.js';
import { relativeTime, departureTime, hourLabel, CONDITION_DE, SEVERITY_VAR, AIR_DE, AIR_COLOR } from './format.js';
import { WeatherIcon } from './WeatherIcon.js';
import { sunAltitude } from './sun.js';

type DetailKey = 'weather' | 'warnings' | 'traffic' | 'pegel' | 'news' | 'transit' | 'hf';

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
  useEffect(() => {
    locate();
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
  // Funkwetter wird stündlich erneuert — häufiger abzurufen bringt nichts und
  // widerspricht der Bitte der Quelle.
  const hf = useApi('hf-space', () => fetchHfSpace(), [refreshTick], { refreshMs: 3600_000 });
  // Das Gitter wird auch für die Streckenbewertung gebraucht, nicht nur für die Ebene.
  const muf = useApi('hf-muf', () => fetchHfMuf(), [refreshTick], {
    enabled: layers.muf || hfTarget !== null,
    refreshMs: 900_000,
  });

  const news = useApi('news', () => fetchNews(), [refreshTick]);
  const health = useApi('health', () => fetchHealth(), [refreshTick]);
  const flowAvailable = health.data?.features?.flow ?? false;
  const aisAvailable = health.data?.features?.ais ?? false;
  const aprsAvailable = health.data?.features?.aprs ?? false;

  const maps = useApi('maps', () => fetchMaps(), [refreshTick]);
  const availableMap: Record<string, RegionFiles> = Object.fromEntries(
    (maps.data?.data ?? []).map((m) => [m.code, { map: m.map, route: m.route, search: m.search }]),
  );
  const [regionsOpen, setRegionsOpen] = useState(false);
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


  /* ---------- Routenplanung (rein lokal) ---------- */
  const [destination, setDestination] = useState<(Place & { category?: string }) | null>(null);
  const [routeOrigin, setRouteOrigin] = useState<Place | null>(null);
  const [pin, setPin] = useState<(Place & { category?: string }) | null>(null);
  const [profile, setProfile] = useState<PlanMode>('car');
  /** ÖPNV-Verbindungen (nur online) samt Auswahl und Wunschzeit. */
  const [itineraries, setItineraries] = useState<TransitItinerary[]>([]);
  const [itineraryIndex, setItineraryIndex] = useState(0);
  const [planTime, setPlanTime] = useState<string | null>(null);
  const [planArriveBy, setPlanArriveBy] = useState(false);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [routeIndex, setRouteIndex] = useState(0);
  const [avoidMotorways, setAvoidMotorways] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [muted, setMuted] = useState(false);
  /** Die gerade gewählte Variante — sie wird gefahren und angesagt. */
  const route = routes[routeIndex] ?? null;
  // Beim Start der Zielführung darf nicht neu gerechnet werden, sonst wäre die
  // ausgewählte Variante wieder weg — deshalb nur als Ref, nicht als Abhängigkeit.
  const navigatingRef = useRef(navigating);
  navigatingRef.current = navigating;

  const startPoint: Coords = routeOrigin ? { lat: routeOrigin.lat, lon: routeOrigin.lon } : coords;
  const startKey = `${startPoint.lat.toFixed(5)},${startPoint.lon.toFixed(5)}`;
  const destKey = destination ? `${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}` : '';

  // Alle heruntergeladenen Regionen entlang der Luftlinie werden zu einem Netz
  // verbunden — sonst würde eine Route an der Landesgrenze enden.
  const routeCodes = useMemo(() => {
    if (!destination) return [] as string[];
    return statesForCorridor(startPoint, { lat: destination.lat, lon: destination.lon }).filter(
      (code) => offlineFiles[code]?.route,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey, destKey, offlineFiles]);

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
    })
      .then((outcome) => {
        if (cancelled) return;
        setRoutes(outcome.routes);
        setRouteIndex(0);
        if (outcome.status === 'start-off-grid') {
          setRouteError(`Der Startpunkt liegt außerhalb der gespeicherten Regionen.${regionHint(startPoint)}`);
        } else if (outcome.status === 'end-off-grid') {
          setRouteError(`Das Ziel liegt außerhalb der gespeicherten Regionen.${regionHint(target)}`);
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
  }, [destKey, startKey, profile, routeCodesKey, avoidMotorways]);

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

  /** Fußweg einer Verbindung an die Offline-Navigation übergeben. */
  const walkLeg = (leg: TransitLeg) => {
    setRouteOrigin({ name: leg.from.name || 'Mein Standort', lat: leg.from.lat, lon: leg.from.lon });
    setDestination({ name: leg.to.name || destination?.name || 'Ziel', lat: leg.to.lat, lon: leg.to.lon });
    setProfile('foot');
  };

  /** Bei Abweichung von der Route: ab der aktuellen Position neu rechnen. */
  const handleOffRoute = useCallback((position: Coords) => {
    setRouteOrigin({ name: 'Aktuelle Position', lat: position.lat, lon: position.lon });
  }, []);
  // Zielführung gibt es nur für die selbst gerechneten Profile.
  const navProfile: RouteProfile = profile === 'transit' ? 'foot' : profile;
  const nav = useNavigation(route, navigating, navProfile, muted, handleOffRoute);

  /** Ziel setzen und die Karte auf Planung umstellen. */
  const startRouteTo = (place: Place, category?: string) => {
    setDestination({ ...place, category });
    setPin({ ...place, category });
    setSearchOpen(false);
    setNavigating(false);
  };

  const stopRoute = () => {
    setNavigating(false);
    setDestination(null);
    setRoutes([]);
    setRouteOrigin(null);
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
  const pickPoint = (point: Coords, kind: 'destination' | 'origin' | 'place' | 'radio', label?: string) => {
    if (kind === 'radio') {
      setHfTarget(point);
      return;
    }
    const coordName = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
    const name = label ?? coordName;
    if (kind === 'destination') startRouteTo({ name, ...point });
    else if (kind === 'origin') setRouteOrigin({ name, ...point });
    else selectPlace({ name: label ?? `Karte ${coordName}`, ...point });
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
    <div className="app">
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
            stopsAvailable={online || !!stopsCode}
            onStopClick={setStopDetail}
            alternatives={routes.map((r, i) => ({ index: i, route: r })).filter((r) => r.index !== routeIndex)}
            onSelectRoute={setRouteIndex}
            routeOrigin={routeOrigin ? { lat: routeOrigin.lat, lon: routeOrigin.lon } : null}
            pin={destination ? null : pin}
            navigating={navigating}
            navPosition={nav.position}
            navBearing={nav.heading ?? nav.progress?.bearing ?? null}
            onPickPoint={pickPoint}
            pickingLocation={pickingLocation}
            onViewport={setViewport}
            onLayersChange={setLayers}
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
              routes={routes}
              routeIndex={routeIndex}
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
              }}
              onResetOrigin={() => setRouteOrigin(null)}
              onStartNav={startNavigation}
              onStopNav={() => setNavigating(false)}
              onToggleMute={() => setMuted((m) => !m)}
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
                    Hinfahren
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

        <Tile title="News" source={news.data?.source} cached={news.fromCache} wide onOpen={news.data ? () => setDetail('news') : undefined}>
          <Loader state={news} empty="Keine Meldungen.">
            <ul className="news">
              {news.data?.data.slice(0, 5).map((n) => (
                <li className="news-item" key={n.id}>
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
          {detail === 'weather' && w && <WeatherDetail w={w} forecast={fc} air={airNow} coords={coords} />}
          {detail === 'warnings' && <WarningsDetail list={uniqueWarnings} />}
          {detail === 'traffic' && traffic.data && <TrafficDetail list={traffic.data.data} />}
          {detail === 'pegel' && pegel.data && <PegelDetail list={pegel.data.data} />}
          {detail === 'transit' && (
            <TransitDetail
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
