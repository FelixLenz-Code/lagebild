import { useEffect, useState } from 'react';
import type { ApiEnvelope, WeatherNow } from '@lagebild/shared';
import { DEFAULT_COORDS, fetchWeather } from './api.js';

const CONDITION_DE: Record<string, string> = {
  dry: 'Trocken',
  fog: 'Nebel',
  rain: 'Regen',
  sleet: 'Schneeregen',
  snow: 'Schnee',
  hail: 'Hagel',
  thunderstorm: 'Gewitter',
  'clear-day': 'Klar',
  'clear-night': 'Klar',
  'partly-cloudy-day': 'Teils bewölkt',
  'partly-cloudy-night': 'Teils bewölkt',
  cloudy: 'Bewölkt',
};

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  return `vor ${Math.round(mins / 60)} Std.`;
}

export function App() {
  const [weather, setWeather] = useState<ApiEnvelope<WeatherNow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWeather(DEFAULT_COORDS)
      .then(setWeather)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Fehler'));
  }, []);

  const w = weather?.data;

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
        <span>
          {weather ? `Aktualisiert ${relativeTime(weather.fetchedAt)}` : 'Lade …'}
        </span>
        <span className="src">Berlin-Mitte</span>
      </div>

      <section className="tiles">
        <article className="tile warnborder">
          <div className="head">
            <h3>Wetter</h3>
            <span className="src-tag">{weather?.source ?? '—'}</span>
          </div>
          {error && <p className="err">Konnte Wetter nicht laden: {error}</p>}
          {!error && !w && <p className="muted">Lade Wetterdaten …</p>}
          {w && (
            <>
              <div className="wx-main">
                <span className="wx-temp">{w.tempC != null ? `${Math.round(w.tempC)}°` : '–'}</span>
                <div>
                  <div className="wx-cond">{w.condition ? (CONDITION_DE[w.condition] ?? w.condition) : 'Unbekannt'}</div>
                  <div className="wx-sub">
                    {w.observedAt ? `Messung ${relativeTime(w.observedAt)}` : ''}
                  </div>
                </div>
              </div>
              <div className="wx-row">
                <span>Wind <b>{w.windKmh != null ? `${Math.round(w.windKmh)} km/h` : '–'}</b></span>
                <span>Luftf. <b>{w.humidityPct != null ? `${Math.round(w.humidityPct)} %` : '–'}</b></span>
              </div>
            </>
          )}
        </article>

        <article className="tile pending">
          <div className="head"><h3>Regenradar</h3></div>
          <p className="muted">In Arbeit — folgt.</p>
        </article>
        <article className="tile pending">
          <div className="head"><h3>Warnungen</h3></div>
          <p className="muted">In Arbeit — folgt.</p>
        </article>
        <article className="tile pending">
          <div className="head"><h3>Verkehr</h3></div>
          <p className="muted">In Arbeit — folgt.</p>
        </article>
      </section>
    </div>
  );
}
