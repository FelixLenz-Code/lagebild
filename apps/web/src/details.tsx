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
import { sunAltitude } from './sun.js';

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
  air,
  coords,
}: {
  w: WeatherNow;
  forecast?: WeatherForecast | null;
  air?: AirQuality | null;
  coords: Coords;
}) {
  const today = forecast?.daily[0];
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
            Wind {w.windKmh != null ? `${Math.round(w.windKmh)} km/h ${compass(w.windDirDeg)}` : '–'} · Messung{' '}
            {relativeTime(w.observedAt)}
          </div>
        </div>
      </div>

      {forecast && forecast.hourly.length > 0 && <HourlyChart hourly={forecast.hourly} />}
      {forecast && forecast.hourly.length > 0 && <RainOutlook hourly={forecast.hourly} />}
      {forecast && forecast.daily.length > 0 && <DailyList daily={forecast.daily} />}
      {air && <AirSection air={air} />}
    </>
  );
}

const RAIN_H = 92;
const RAIN_COL = 27;

/**
 * Regen der nächsten 24 Stunden: Balken zeigen die Menge je Stunde, die Linie
 * die Regenwahrscheinlichkeit. Beides zusammen beantwortet die eigentliche
 * Frage — wann und wie stark wird es nass.
 */
function RainOutlook({ hourly }: { hourly: WeatherForecast['hourly'] }) {
  const hours = hourly.slice(0, 24);
  const amounts = hours.map((h) => h.precipitationMm ?? 0);
  const total = Math.round(amounts.reduce((a, b) => a + b, 0) * 10) / 10;
  const peak = Math.max(...amounts);
  // Maßstab: mindestens 1 mm, damit Nieselregen nicht wie Starkregen aussieht.
  const scale = Math.max(1, peak);
  const first = hours.find((h) => (h.precipitationMm ?? 0) >= 0.1);
  const maxProb = Math.max(0, ...hours.map((h) => h.precipitationProbabilityPct ?? 0));

  const width = hours.length * RAIN_COL;
  const barBase = RAIN_H - 16;
  const barTop = 34;
  const probY = (p: number) => 30 - (p / 100) * 22;
  const probLine = hours
    .map((h, i) => `${i * RAIN_COL + RAIN_COL / 2},${probY(h.precipitationProbabilityPct ?? 0)}`)
    .join(' ');

  return (
    <>
      <h4 className="sec-title">Regen in den nächsten 24 Stunden</h4>
      <div className="rain-sum">
        {total > 0 ? (
          <>
            <b>{total.toString().replace('.', ',')} mm</b> erwartet
            {first && <> · ab {hourLabel(first.time)}</>}
            {peak > 0 && <> · Spitze {peak.toString().replace('.', ',')} mm/h</>}
          </>
        ) : (
          <>
            <b>Kein Regen erwartet</b>
            {maxProb > 0 && <> · höchste Wahrscheinlichkeit {maxProb} %</>}
          </>
        )}
      </div>
      <div className="wx-hours">
        <svg className="rain-chart" width={width} height={RAIN_H} role="img" aria-label="Regenmenge und Regenwahrscheinlichkeit je Stunde">
          {/* Grundlinie und 50-%-Hilfslinie für die Wahrscheinlichkeit */}
          <line x1={0} y1={barBase} x2={width} y2={barBase} stroke="var(--line)" strokeWidth={1} />
          <line x1={0} y1={probY(50)} x2={width} y2={probY(50)} stroke="var(--line)" strokeWidth={1} strokeDasharray="3 3" />
          <text x={2} y={probY(50) - 3} className="rain-tick">50 %</text>
          <polygon
            points={`0,${probY(0)} ${probLine} ${width},${probY(0)}`}
            fill="var(--sev1)"
            opacity={0.12}
          />
          {hours.map((h, i) => {
            const mm = h.precipitationMm ?? 0;
            const height = mm > 0 ? Math.max(3, (mm / scale) * (barBase - barTop)) : 0;
            const x = i * RAIN_COL + 5;
            return (
              <g key={h.time}>
                {height > 0 && (
                  <rect x={x} y={barBase - height} width={RAIN_COL - 10} height={height} rx={2} fill="var(--accent)">
                    <title>{`${hourLabel(h.time)}: ${mm} mm`}</title>
                  </rect>
                )}
                {i % 3 === 0 && (
                  <text x={i * RAIN_COL + RAIN_COL / 2} y={RAIN_H - 3} textAnchor="middle" className="rain-tick">
                    {new Date(h.time).getHours()}
                  </text>
                )}
              </g>
            );
          })}
          {/* Regenwahrscheinlichkeit */}
          <polyline points={probLine} fill="none" stroke="var(--sev1)" strokeWidth={1.8} strokeLinejoin="round" />
        </svg>
      </div>
      <div className="rain-legend">
        <span><i className="bar" /> Menge in mm{peak > 0 && ` (max. ${scale.toString().replace('.', ',')})`}</span>
        <span><i className="line" /> Regenwahrscheinlichkeit 0–100 %</span>
      </div>
    </>
  );
}

/** Luftqualität als Abschnitt der Wetteransicht (frühere eigene Kachel). */
function AirSection({ air }: { air: AirQuality }) {
  const cat = air.category;
  return (
    <>
      <h4 className="sec-title">Luftqualität</h4>
      <div className="air-row">
        <span className="air-value" style={cat ? { color: AIR_COLOR[cat] } : undefined}>
          {air.aqi ?? '–'}
        </span>
        <div>
          <div className="wx-cond">{cat ? AIR_DE[cat] : 'Unbekannt'}</div>
          <div className="wx-sub">European AQI · {relativeTime(air.measuredAt)}</div>
        </div>
      </div>
      <div className="airbar" style={{ marginBottom: 10 }}>
        <i style={{ left: `${Math.min(air.aqi ?? 0, 100)}%` }} />
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
