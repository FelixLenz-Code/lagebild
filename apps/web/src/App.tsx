import { useCallback, useEffect, useMemo, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Coords, WarningFeature } from '@lagebild/shared';
import { DEFAULT_COORDS, fetchWeather, fetchForecast, fetchWarnings, fetchTraffic, fetchPegel, fetchNews, fetchAir, fetchRadar, fetchRadarForecast, fetchAircraft, fetchVessels, fetchAprs, fetchWind, fetchTransit, fetchHealth, fetchMaps, type Bbox } from './api.js';
import { useApi } from './useApi.js';
import { LageMap, type ActiveLayers } from './LageMap.js';
import { PlacePicker } from './PlacePicker.js';
import { OfflineRegions } from './OfflineRegions.js';
import { opfsSupported, listOffline } from './offlineMaps.js';
import { inStateBounds } from './stateBounds.js';
import { loadFavorites, saveFavorites, type Place } from './places.js';
import { Sheet } from './Sheet.js';
import { WeatherDetail, WarningsDetail, TrafficDetail, PegelDetail, NewsDetail, TransitDetail } from './details.js';
import { relativeTime, timeUntil, timeHM, hourLabel, CONDITION_DE, SEVERITY_DE, SEVERITY_VAR, TRAFFIC_DE, AIR_DE, AIR_COLOR } from './format.js';
import { WeatherIcon } from './WeatherIcon.js';
import { sunAltitude } from './sun.js';

type DetailKey = 'weather' | 'warnings' | 'traffic' | 'pegel' | 'news' | 'transit';

/** Anfangs-Ausschnitt um einen Punkt, bis die Karte ihren echten Ausschnitt meldet. */
function boxAround(c: { lat: number; lon: number }): Bbox {
  return { west: c.lon - 0.2, south: c.lat - 0.12, east: c.lon + 0.2, north: c.lat + 0.12 };
}
const bboxKey = (b: Bbox) =>
  `${b.west.toFixed(2)},${b.south.toFixed(2)},${b.east.toFixed(2)},${b.north.toFixed(2)}`;

export function App() {
  const [coords, setCoords] = useState<Coords>(DEFAULT_COORDS);
  const [place, setPlace] = useState('Berlin-Mitte');
  // Sichtbarer Kartenausschnitt — steuert alle ortsbezogenen Kartendaten.
  const [viewport, setViewport] = useState<Bbox>(() => boxAround(DEFAULT_COORDS));
  const [favorites, setFavorites] = useState<Place[]>(() => loadFavorites());
  const [pickerOpen, setPickerOpen] = useState(false);

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

  const selectPlace = (p: Place) => {
    setCoords({ lat: p.lat, lon: p.lon });
    setViewport(boxAround({ lat: p.lat, lon: p.lon }));
    setPlace(p.name);
    setPickerOpen(false);
  };
  const saveCurrent = () =>
    setFavorites((prev) =>
      prev.some((f) => f.name === place) ? prev : [...prev, { name: place, lat: coords.lat, lon: coords.lon }],
    );
  const removeFavorite = (p: Place) =>
    setFavorites((prev) => prev.filter((f) => !(f.lat === p.lat && f.lon === p.lon)));
  const isFavorite = favorites.some((f) => f.name === place);

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

  const geoKey = `${coords.lat.toFixed(3)},${coords.lon.toFixed(3)}`;
  const viewKey = bboxKey(viewport);
  const weather = useApi(`weather:${geoKey}`, () => fetchWeather(coords), [coords]);
  const forecast = useApi(`forecast:${geoKey}`, () => fetchForecast(coords), [coords]);
  const warnings = useApi(`warnings:${viewKey}`, () => fetchWarnings(viewport), [viewKey]);
  const traffic = useApi(`traffic:${viewKey}`, () => fetchTraffic(viewport), [viewKey]);
  const pegel = useApi(`pegel:${viewKey}`, () => fetchPegel(viewport), [viewKey]);
  const air = useApi(`air:${geoKey}`, () => fetchAir(coords), [coords]);
  const transit = useApi(`transit:${geoKey}`, () => fetchTransit(coords), [coords]);
  const radar = useApi('radar', () => fetchRadar());
  // Live-Ebenen laden nur, solange sie auf der Karte eingeschaltet sind.
  const [layers, setLayers] = useState<ActiveLayers>({
    radar: false,
    aircraft: false,
    vessels: false,
    aprs: false,
    wind: false,
    aprsTargets: [],
  });
  const radarForecast = useApi(
    `radar-forecast:${geoKey}`,
    () => fetchRadarForecast(coords),
    [coords],
    { enabled: layers.radar },
  );
  // Das ADS-B-Netz liefert nur einen Umkreis um die Kartenmitte — bei sehr
  // weitem Ausschnitt wäre das Bild irreführend, also gar nicht erst abfragen.
  const wideViewport = viewport.east - viewport.west > 8;
  // Flug- und Schiffspositionen veralten in Sekunden — pollen, nicht cachen.
  const aircraft = useApi(`aircraft:${viewKey}`, () => fetchAircraft(viewport), [viewKey], {
    enabled: layers.aircraft && !wideViewport,
    refreshMs: 15000,
    cache: false,
  });
  const vessels = useApi(`vessels:${viewKey}`, () => fetchVessels(viewport), [viewKey], {
    enabled: layers.vessels,
    refreshMs: 20000,
    cache: false,
  });
  // APRS fragt gezielt Rufzeichen ab (kein Ausschnitt) — aprs.fi bittet um
  // sparsame Abrufe, deshalb nur bei aktiver Ebene und im Minutentakt.
  const aprsKey = layers.aprsTargets.join(',');
  const aprs = useApi(`aprs:${aprsKey}`, () => fetchAprs(layers.aprsTargets), [aprsKey], {
    enabled: layers.aprs && layers.aprsTargets.length > 0,
    refreshMs: 60000,
    cache: false,
  });
  // Windfeld folgt dem Ausschnitt; das Modell rechnet stündlich, 10 min reichen.
  const wind = useApi(`wind:${viewKey}`, () => fetchWind(viewport), [viewKey], {
    enabled: layers.wind,
    refreshMs: 600000,
    cache: false,
  });
  const news = useApi('news', () => fetchNews());
  const health = useApi('health', () => fetchHealth());
  const flowAvailable = health.data?.features?.flow ?? false;
  const aisAvailable = health.data?.features?.ais ?? false;
  const aprsAvailable = health.data?.features?.aprs ?? false;

  const maps = useApi('maps', () => fetchMaps());
  const availableMap: Record<string, number> = Object.fromEntries(
    (maps.data?.data ?? []).map((m) => [m.code, m.bytes]),
  );
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [offlineMapsState, setOfflineMapsState] = useState<Record<string, number>>({});
  const refreshOffline = useCallback(() => {
    if (opfsSupported()) listOffline().then(setOfflineMapsState).catch(() => {});
  }, []);
  useEffect(() => {
    refreshOffline();
  }, [refreshOffline]);

  // Offline (kein Netz) + heruntergeladene Region am Standort → Offline-Basiskarte.
  const offlineCode = useMemo(() => {
    if (online) return null;
    return Object.keys(offlineMapsState).find((code) => inStateBounds(coords, code)) ?? null;
  }, [online, offlineMapsState, coords]);

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

  const lastSync = weather.savedAt;
  const anyCached = [weather, warnings, traffic, pegel, air, transit, news].some((s) => s.fromCache);

  const [detail, setDetail] = useState<DetailKey | null>(null);

  const detailInfo: Record<DetailKey, { title: string; source?: string; savedAt: number | null }> = {
    weather: { title: `Wetter — ${place}`, source: weather.data?.source, savedAt: weather.savedAt },
    warnings: { title: 'Amtliche Warnungen', source: warnings.data?.source, savedAt: warnings.savedAt },
    traffic: { title: 'Verkehr im Ausschnitt', source: traffic.data?.source, savedAt: traffic.savedAt },
    pegel: { title: 'Pegelstände', source: pegel.data?.source, savedAt: pegel.savedAt },
    transit: { title: 'Bahn / ÖPNV in der Nähe', source: transit.data?.source, savedAt: transit.savedAt },
    news: { title: 'Nachrichten', source: news.data?.source, savedAt: news.savedAt },
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

        <button type="button" className="place-btn" onClick={() => setPickerOpen(true)} title="Ort wechseln">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" />
            <circle cx="12" cy="10" r="2.2" />
          </svg>
          <span className="pl-name">{place}</span>
          <svg className="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
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
            wind={wind.data?.data.points ?? []}
            flowAvailable={flowAvailable}
            aisAvailable={aisAvailable}
            aprsAvailable={aprsAvailable}
            offlineCode={offlineCode}
            onViewport={setViewport}
            onLayersChange={setLayers}
          />
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

        <Tile
          title="Warnungen"
          source={warnings.data?.source}
          cached={warnings.fromCache}
          badge={warnings.data ? (uniqueWarnings.length ? `${uniqueWarnings.length} aktiv` : 'keine') : undefined}
          badgeKind={uniqueWarnings.length ? 'warn' : 'ok'}
          onOpen={warnings.data && uniqueWarnings.length ? () => setDetail('warnings') : undefined}
        >
          <Loader state={warnings} empty="Keine amtlichen Warnungen im Ausschnitt.">
            <ul className="list">
              {uniqueWarnings.slice(0, 4).map((wn) => (
                <li className="line-item" key={wn.id}>
                  <span className="sv" style={{ background: SEVERITY_VAR[wn.severity] }} />
                  <span className="t">{wn.event}</span>
                  <span className="meta">{SEVERITY_DE[wn.severity]}{wn.expires ? ` · bis ${timeUntil(wn.expires)}` : ''}</span>
                </li>
              ))}
            </ul>
          </Loader>
        </Tile>

        <Tile
          title="Verkehr"
          source={traffic.data?.source}
          cached={traffic.fromCache}
          badge={traffic.data?.data.length ? `${traffic.data.data.length}` : undefined}
          badgeKind="alert"
          onOpen={traffic.data ? () => setDetail('traffic') : undefined}
        >
          <Loader state={traffic} empty="Keine Meldungen im Ausschnitt.">
            <ul className="list">
              {traffic.data?.data.slice(0, 4).map((t) => (
                <li className="line-item" key={t.id}>
                  <span className="sv" style={{ background: t.kind === 'closure' ? 'var(--sev3)' : 'var(--sev2)' }} />
                  <span className="t">{t.title}</span>
                  <span className="meta">{TRAFFIC_DE[t.kind] ?? t.kind}</span>
                </li>
              ))}
            </ul>
          </Loader>
        </Tile>

        <Tile title="Pegel" source={pegel.data?.source} cached={pegel.fromCache} onOpen={pegel.data ? () => setDetail('pegel') : undefined}>
          <Loader state={pegel} empty="Keine Messstelle im Ausschnitt.">
            <ul className="list">
              {pegel.data?.data.slice(0, 4).map((p, i) => (
                <li className="line-item" key={p.station + i}>
                  <span className="t">{p.station}</span>
                  <span className="meta"><b>{p.levelCm != null ? `${p.levelCm} cm` : '–'}</b></span>
                </li>
              ))}
            </ul>
          </Loader>
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
              <div className="stop-name">{nearestStop.name}</div>
              <ul className="list">
                {nearestStop.departures.slice(0, 3).map((d, i) => (
                  <li className="line-item" key={i}>
                    <span className="line-pill">{d.line}</span>
                    <span className="t">{d.direction}</span>
                    <span className={`meta${d.cancelled || (d.delayMin ?? 0) >= 1 ? ' late' : ''}`}>
                      {d.cancelled
                        ? 'fällt aus'
                        : `${timeHM(d.when ?? d.plannedWhen)}${d.delayMin ? ` +${d.delayMin}` : ''}`}
                    </span>
                  </li>
                ))}
              </ul>
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
          availableMap={availableMap}
          offline={offlineMapsState}
          onClose={() => setRegionsOpen(false)}
          onChanged={refreshOffline}
        />
      )}

      {pickerOpen && (
        <PlacePicker
          current={place}
          favorites={favorites}
          isFavorite={isFavorite}
          onClose={() => setPickerOpen(false)}
          onSelect={selectPlace}
          onUseGeolocation={() => {
            locate();
            setPickerOpen(false);
          }}
          onSaveCurrent={saveCurrent}
          onRemoveFavorite={removeFavorite}
        />
      )}

      {detail && (
        <Sheet title={detailInfo[detail].title} meta={detailMeta(detail)} onClose={() => setDetail(null)}>
          {detail === 'weather' && w && <WeatherDetail w={w} forecast={fc} air={airNow} coords={coords} />}
          {detail === 'warnings' && <WarningsDetail list={uniqueWarnings} />}
          {detail === 'traffic' && traffic.data && <TrafficDetail list={traffic.data.data} />}
          {detail === 'pegel' && pegel.data && <PegelDetail list={pegel.data.data} />}
          {detail === 'transit' && <TransitDetail stops={transitStops} />}
          {detail === 'news' && news.data && <NewsDetail list={news.data.data} />}
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
