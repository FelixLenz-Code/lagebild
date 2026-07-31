import type {
  Coords,
  WeatherNow,
  WeatherForecast,
  WarningFeature,
  TrafficIncident,
  WaterLevel,
  NewsItem,
  AirQuality,
  TransitStop,
} from '@lagebild/shared';
import {
  relativeTime,
  timeUntil,
  timeHM,
  hourLabel,
  dayLabel,
  formatDateTime,
  compass,
  CONDITION_DE,
  SEVERITY_DE,
  SEVERITY_VAR,
  TRAFFIC_DE,
  AIR_DE,
  AIR_COLOR,
} from './format.js';
import { WeatherIcon } from './WeatherIcon.js';
import { sunTimes, sunAltitude } from './sun.js';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <div className="dl">{label}</div>
      <div className="dv mono">{value}</div>
    </div>
  );
}

export function WeatherDetail({
  w,
  forecast,
  coords,
}: {
  w: WeatherNow;
  forecast?: WeatherForecast | null;
  coords: Coords;
}) {
  const n = (v: number | null, unit = '') => (v != null ? `${Math.round(v)}${unit}` : '–');
  const today = forecast?.daily[0];
  const { sunrise, sunset } = sunTimes(new Date(), coords.lat, coords.lon);
  const night = sunAltitude(new Date(), coords.lat, coords.lon) < -0.833;
  return (
    <>
      <div className="wx-hero big">
        <WeatherIcon icon={w.icon ?? (night ? 'clear-night' : undefined)} condition={w.condition} size={72} />
        <div className="wx-hero-main">
          <span className="wx-temp-lg mono">{w.tempC != null ? `${Math.round(w.tempC)}°` : '–'}</span>
          <div className="wx-cond">{w.condition ? (CONDITION_DE[w.condition] ?? w.condition) : 'Unbekannt'}</div>
          <div className="wx-sub">
            {w.feelsLikeC != null && `gefühlt ${Math.round(w.feelsLikeC)}° · `}
            {today?.tempMaxC != null && today.tempMinC != null && (
              <>
                heute {Math.round(today.tempMaxC)}° / {Math.round(today.tempMinC)}° ·{' '}
              </>
            )}
            Messung {relativeTime(w.observedAt)}
          </div>
        </div>
      </div>

      {forecast && forecast.hourly.length > 0 && <HourlyChart hourly={forecast.hourly} />}
      {forecast && forecast.daily.length > 0 && <DailyList daily={forecast.daily} />}

      <h4 className="sec-title">Jetzt vor Ort</h4>
      <div className="details">
        <Detail label="Wind" value={`${n(w.windKmh)} km/h · ${compass(w.windDirDeg)}`} />
        <Detail label="Böen" value={w.windGustKmh != null ? `${n(w.windGustKmh)} km/h` : '–'} />
        <Detail label="Luftfeuchte" value={n(w.humidityPct, ' %')} />
        <Detail label="Luftdruck" value={w.pressureHpa != null ? `${Math.round(w.pressureHpa)} hPa` : '–'} />
        <Detail label="Sonnenaufgang" value={sunrise ? timeHM(sunrise.toISOString()) : '–'} />
        <Detail label="Sonnenuntergang" value={sunset ? timeHM(sunset.toISOString()) : '–'} />
        <Detail label="Niederschlag" value={w.precipitationMm != null ? `${w.precipitationMm} mm` : '–'} />
        <Detail label="Messzeit" value={formatDateTime(w.observedAt)} />
      </div>
    </>
  );
}

const CHART_H = 66;
const COL_W = 54;

/**
 * Stundenverlauf als Temperaturkurve mit Symbolen und Regenbalken —
 * waagerecht scrollbar, die Kurve wird als SVG über die Spalten gelegt.
 */
function HourlyChart({ hourly }: { hourly: WeatherForecast['hourly'] }) {
  const hours = hourly.slice(0, 24);
  const temps = hours.map((h) => h.tempC).filter((v): v is number => v != null);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = hi - lo || 1;
  const maxRain = Math.max(...hours.map((h) => h.precipitationMm ?? 0));
  const width = hours.length * COL_W;
  // Oben bleibt Platz für die Wertebeschriftung, unten für den Kurvenfuß.
  const y = (t: number) => CHART_H - 8 - ((t - lo) / span) * (CHART_H - 30);
  const points = hours
    .map((h, i) => (h.tempC != null ? `${i * COL_W + COL_W / 2},${y(h.tempC)}` : null))
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <h4 className="sec-title">Nächste 24 Stunden</h4>
      <div className="wx-hours">
        <div className="wx-hours-inner" style={{ width }}>
          <div className="wx-hourrow">
            {hours.map((h) => (
              <div className="wx-hour" key={h.time} style={{ width: COL_W }}>
                <span className="hh">{hourLabel(h.time)}</span>
                <WeatherIcon icon={h.icon} condition={h.condition} size={26} />
              </div>
            ))}
          </div>

          <svg className="wx-curve" width={width} height={CHART_H} aria-hidden="true">
            <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
            {hours.map((h, i) =>
              h.tempC != null ? (
                <g key={h.time}>
                  <circle cx={i * COL_W + COL_W / 2} cy={y(h.tempC)} r={2.4} fill="var(--accent)" />
                  <text
                    x={i * COL_W + COL_W / 2}
                    y={y(h.tempC) - 8}
                    textAnchor="middle"
                    className="wx-curve-label"
                  >
                    {Math.round(h.tempC)}°
                  </text>
                </g>
              ) : null,
            )}
          </svg>

          <div className="wx-hourrow">
            {hours.map((h) => (
              <div className="wx-hour" key={h.time} style={{ width: COL_W }}>
                {/* Balken nur für Stunden mit Niederschlag — sonst bleibt es ruhig. */}
                {maxRain > 0 && (
                  <span className="rainbar" title={`${h.precipitationMm ?? 0} mm`}>
                    {(h.precipitationMm ?? 0) > 0 && (
                      <i style={{ height: `${Math.max(8, ((h.precipitationMm ?? 0) / maxRain) * 100)}%` }} />
                    )}
                  </span>
                )}
                <span className={`pp${(h.precipitationProbabilityPct ?? 0) >= 30 ? ' wet' : ''}`}>
                  {h.precipitationProbabilityPct != null ? `${h.precipitationProbabilityPct} %` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** 7-Tage-Übersicht mit Symbol und Temperaturspanne als Balken. */
function DailyList({ daily }: { daily: WeatherForecast['daily'] }) {
  const mins = daily.map((d) => d.tempMinC).filter((v): v is number => v != null);
  const maxs = daily.map((d) => d.tempMaxC).filter((v): v is number => v != null);
  const lo = Math.min(...mins);
  const hi = Math.max(...maxs);
  const span = hi - lo || 1;
  return (
    <>
      <h4 className="sec-title">7 Tage</h4>
      <div className="wx-days">
        {daily.map((d) => (
          <div className="wx-day" key={d.date}>
            <span className="dow">{dayLabel(d.date)}</span>
            <WeatherIcon icon={d.icon} condition={d.condition} size={24} />
            <span className="cond">{d.condition ? (CONDITION_DE[d.condition] ?? d.condition) : ''}</span>
            <span className="prob mono">
              {d.precipitationProbabilityPct != null && d.precipitationProbabilityPct >= 5
                ? `${d.precipitationProbabilityPct} %`
                : ''}
            </span>
            <span className="lo mono">{d.tempMinC != null ? `${Math.round(d.tempMinC)}°` : '–'}</span>
            <span className="tspan">
              {d.tempMinC != null && d.tempMaxC != null && (
                <i
                  style={{
                    left: `${((d.tempMinC - lo) / span) * 100}%`,
                    right: `${((hi - d.tempMaxC) / span) * 100}%`,
                  }}
                />
              )}
            </span>
            <span className="hi mono">{d.tempMaxC != null ? `${Math.round(d.tempMaxC)}°` : '–'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function WarningsDetail({ list }: { list: WarningFeature[] }) {
  if (list.length === 0) return <p className="muted">Keine amtlichen Warnungen im Kartenausschnitt.</p>;
  return (
    <div className="detail-list">
      {list.map((a) => (
        <div className="alert-block" key={a.id} style={{ borderColor: SEVERITY_VAR[a.severity] }}>
          <div className="alert-top">
            <span className="sev-pill" style={{ background: SEVERITY_VAR[a.severity] }}>
              {SEVERITY_DE[a.severity]}
            </span>
            <b>{a.headline}</b>
          </div>
          <div className="alert-meta mono">
            {a.onset ? formatDateTime(a.onset) : ''}
            {a.expires ? ` – ${formatDateTime(a.expires)} (in ${timeUntil(a.expires)})` : ''}
          </div>
          {a.description && <p className="alert-desc">{a.description}</p>}
          {a.instruction && <p className="alert-desc alert-instruction">{a.instruction}</p>}
        </div>
      ))}
    </div>
  );
}

export function TrafficDetail({ list }: { list: TrafficIncident[] }) {
  if (list.length === 0) return <p className="muted">Keine Verkehrsmeldungen im Kartenausschnitt.</p>;
  return (
    <div className="detail-list">
      {list.map((t) => (
        <div className="alert-block" key={t.id} style={{ borderColor: t.kind === 'closure' ? 'var(--sev3)' : 'var(--sev2)' }}>
          <div className="alert-top">
            <span className="road-pill mono">{t.road}</span>
            <span className="sev-pill" style={{ background: t.kind === 'closure' ? 'var(--sev3)' : 'var(--sev2)' }}>
              {TRAFFIC_DE[t.kind] ?? t.kind}
            </span>
            <b>{t.title}</b>
          </div>
          {t.startsAt && <div className="alert-meta mono">seit {formatDateTime(t.startsAt)}</div>}
          {t.description && <p className="alert-desc">{t.description}</p>}
        </div>
      ))}
    </div>
  );
}

export function PegelDetail({ list }: { list: WaterLevel[] }) {
  if (list.length === 0) return <p className="muted">Keine Messstelle im Kartenausschnitt.</p>;
  return (
    <div className="details">
      {list.map((p, i) => (
        <div className="detail" key={p.station + i}>
          <div className="dl">{p.water}</div>
          <div className="dv mono">{p.levelCm != null ? `${p.levelCm} cm` : '–'}</div>
          <div className="detail-sub">{p.station} · {relativeTime(p.measuredAt)}</div>
        </div>
      ))}
    </div>
  );
}

export function TransitDetail({ stops }: { stops: TransitStop[] }) {
  const withData = stops.filter((s) => s.departures.length > 0);
  if (withData.length === 0)
    return <p className="muted">Keine Abfahrten in der Nähe (Dienst evtl. nicht erreichbar).</p>;
  return (
    <div className="detail-list">
      {withData.map((s) => (
        <div className="alert-block" key={s.id}>
          <div className="alert-top">
            <b>{s.name}</b>
            {s.distanceM != null && <span className="alert-meta mono">{Math.round(s.distanceM)} m</span>}
          </div>
          <div className="dep-list">
            {s.departures.map((d, i) => (
              <div className="dep" key={i}>
                <span className="line-pill">{d.line}</span>
                <span className="dep-dir">{d.direction}</span>
                <span
                  className={`dep-time mono${d.cancelled ? ' cancelled' : d.delayMin && d.delayMin >= 1 ? ' late' : ''}`}
                >
                  {d.cancelled
                    ? 'fällt aus'
                    : `${timeHM(d.when ?? d.plannedWhen)}${d.delayMin ? ` +${d.delayMin}` : ''}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AirDetail({ air }: { air: AirQuality }) {
  const cat = air.category;
  return (
    <>
      <div className="wx-hero">
        <span className="wx-temp-lg" style={cat ? { color: AIR_COLOR[cat] } : undefined}>
          {air.aqi ?? '–'}
        </span>
        <div>
          <div className="wx-cond">{cat ? AIR_DE[cat] : 'Unbekannt'}</div>
          <div className="wx-sub">European AQI · {relativeTime(air.measuredAt)}</div>
        </div>
      </div>
      <div className="details">
        <Detail label="Feinstaub PM2,5" value={air.pm25 != null ? `${air.pm25} µg/m³` : '–'} />
        <Detail label="Feinstaub PM10" value={air.pm10 != null ? `${air.pm10} µg/m³` : '–'} />
        <Detail label="Stickstoffdioxid" value={air.no2 != null ? `${air.no2} µg/m³` : '–'} />
        <Detail label="Ozon" value={air.o3 != null ? `${air.o3} µg/m³` : '–'} />
      </div>
    </>
  );
}

export function NewsDetail({ list }: { list: NewsItem[] }) {
  if (list.length === 0) return <p className="muted">Keine Meldungen.</p>;
  return (
    <ul className="news">
      {list.map((n) => (
        <li className="news-item" key={n.id}>
          <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
          {n.summary && <p className="news-summary">{n.summary}</p>}
          <span className="tm">{n.topic ? `${n.topic} · ` : ''}{relativeTime(n.publishedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
