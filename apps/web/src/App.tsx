import { useEffect, useState, type ReactNode } from 'react';
import type { Coords } from '@lagebild/shared';
import { DEFAULT_COORDS, fetchWeather, fetchAlerts, fetchTraffic, fetchPegel, fetchNews } from './api.js';
import { useApi } from './useApi.js';
import { LageMap } from './LageMap.js';
import { relativeTime, timeUntil, CONDITION_DE, SEVERITY_DE, SEVERITY_VAR, TRAFFIC_DE } from './format.js';

export function App() {
  const [coords, setCoords] = useState<Coords>(DEFAULT_COORDS);
  const [place, setPlace] = useState('Berlin-Mitte');

  // Standort per Geolocation, Fallback bleibt Berlin-Mitte.
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setPlace('Dein Standort');
      },
      () => {
        /* Berechtigung verweigert → Standardort behalten */
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  const weather = useApi(() => fetchWeather(coords), [coords]);
  const alerts = useApi(() => fetchAlerts(coords), [coords]);
  const traffic = useApi(() => fetchTraffic(coords), [coords]);
  const pegel = useApi(() => fetchPegel(coords), [coords]);
  const news = useApi(() => fetchNews());

  const w = weather.data?.data;

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
      </header>

      <div className="statusline">
        <span className="live"><i />LIVE</span>
        <span>{weather.data ? `Aktualisiert ${relativeTime(weather.data.fetchedAt)}` : 'Lade …'}</span>
        <span className="src">{place}</span>
      </div>

      <LageMap coords={coords} traffic={traffic.data?.data ?? []} pegel={pegel.data?.data ?? []} />

      <section className="tiles">
        <Tile title="Wetter" source={weather.data?.source} warn className="warnborder">
          {weather.loading && <p className="muted">Lade …</p>}
          {weather.error && <p className="err">{weather.error}</p>}
          {w && (
            <>
              <div className="wx-main">
                <span className="wx-temp">{w.tempC != null ? `${Math.round(w.tempC)}°` : '–'}</span>
                <div>
                  <div className="wx-cond">{w.condition ? (CONDITION_DE[w.condition] ?? w.condition) : 'Unbekannt'}</div>
                  <div className="wx-sub">{w.observedAt ? `Messung ${relativeTime(w.observedAt)}` : ''}</div>
                </div>
              </div>
              <div className="wx-row">
                <span>Wind <b>{w.windKmh != null ? `${Math.round(w.windKmh)} km/h` : '–'}</b></span>
                <span>Luftf. <b>{w.humidityPct != null ? `${Math.round(w.humidityPct)} %` : '–'}</b></span>
              </div>
            </>
          )}
        </Tile>

        <Tile
          title="Warnungen"
          source={alerts.data?.source}
          badge={alerts.data ? (alerts.data.data.length ? `${alerts.data.data.length} aktiv` : 'keine') : undefined}
          badgeKind={alerts.data?.data.length ? 'warn' : 'ok'}
        >
          <Loader state={alerts} empty="Keine amtlichen Warnungen.">
            <ul className="list">
              {alerts.data?.data.slice(0, 4).map((a) => (
                <li className="line-item" key={a.id}>
                  <span className="sv" style={{ background: SEVERITY_VAR[a.severity] }} />
                  <span className="t">{a.event}</span>
                  <span className="meta">{SEVERITY_DE[a.severity]}{a.expires ? ` · bis ${timeUntil(a.expires)}` : ''}</span>
                </li>
              ))}
            </ul>
          </Loader>
        </Tile>

        <Tile
          title="Verkehr"
          source={traffic.data?.source}
          badge={traffic.data?.data.length ? `${traffic.data.data.length}` : undefined}
          badgeKind="alert"
        >
          <Loader state={traffic} empty="Keine Meldungen in der Nähe.">
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

        <Tile title="Pegel" source={pegel.data?.source}>
          <Loader state={pegel} empty="Keine Messstelle in der Nähe.">
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

        <Tile title="News" source={news.data?.source} wide>
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

        <Tile title="Regenradar" pending>
          <p className="muted">Karte folgt — als Nächstes.</p>
        </Tile>
      </section>
    </div>
  );
}

function Tile(props: {
  title: string;
  source?: string;
  badge?: string;
  badgeKind?: 'warn' | 'ok' | 'alert';
  warn?: boolean;
  wide?: boolean;
  pending?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const cls = ['tile'];
  if (props.className) cls.push(props.className);
  if (props.wide) cls.push('wide');
  if (props.pending) cls.push('pending');
  return (
    <article className={cls.join(' ')}>
      <div className="head">
        <h3>{props.title}</h3>
        {props.badge && <span className={`badge ${props.badgeKind ?? 'warn'}`}>{props.badge}</span>}
        {props.source && !props.badge && <span className="src-tag">{props.source}</span>}
      </div>
      {props.children}
    </article>
  );
}

function Loader<T>(props: { state: { loading: boolean; error: string | null; data: { data: T[] } | null }; empty: string; children: ReactNode }) {
  if (props.state.loading) return <p className="muted">Lade …</p>;
  if (props.state.error) return <p className="err">{props.state.error}</p>;
  if (props.state.data && props.state.data.data.length === 0) return <p className="muted">{props.empty}</p>;
  return <>{props.children}</>;
}
