import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DepartureBoard } from './Departures.js';
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

      {forecast && forecast.hourly.length > 0 && <HourlyForecast hourly={forecast.hourly} coords={coords} />}
      {forecast && forecast.daily.length > 0 && <DailyList daily={forecast.daily} />}
      {air && <AirSection air={air} />}
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

const COL_W = 54;
/** Bänder des Diagramms (gemeinsame Zeitachse, deshalb feste Höhen). */
const TEMP_H = 60;
const RAIN_H = 72;
const RAIN_BASE = RAIN_H - 4;
/** Platz für die Mengenbalken samt Beschriftung. */
const BAR_MAX = RAIN_BASE - 14;

/**
 * Regenstärke in Stufen — Farben und Schwellen wie in der Radar-Legende,
 * damit Vorhersage und Radarbild dieselbe Sprache sprechen (mm pro Stunde).
 */
const RAIN_STEPS: { max: number; color: string; label: string }[] = [
  { max: 0.5, color: '#96c8ff', label: 'leicht' },
  { max: 2.5, color: '#5aa0f0', label: 'mäßig' },
  { max: 10, color: '#2873d2', label: 'stark' },
  { max: Infinity, color: '#cd2d23', label: 'sehr stark' },
];
const rainStep = (mm: number) => RAIN_STEPS.find((s) => mm < s.max) ?? RAIN_STEPS[RAIN_STEPS.length - 1]!;
/** Ab diesem Wert gilt eine Stunde als „nass". */
const WET_MM = 0.1;

const num = (v: number) => v.toString().replace('.', ',');
const hourOf = (iso: string) => new Date(iso).getHours();

/** Zusammenhängende Regenphasen für die Klartext-Zusammenfassung. */
function rainWindows(hours: WeatherForecast['hourly']): { from: string; to: string; mm: number }[] {
  const windows: { from: string; to: string; mm: number }[] = [];
  let current: { from: string; to: string; mm: number } | null = null;
  for (const h of hours) {
    const mm = h.precipitationMm ?? 0;
    if (mm >= WET_MM) {
      if (current) {
        current.to = h.time;
        current.mm += mm;
      } else current = { from: h.time, to: h.time, mm };
    } else if (current) {
      windows.push(current);
      current = null;
    }
  }
  if (current) windows.push(current);
  return windows;
}

/**
 * Die nächsten 24 Stunden in einem Bild: Wettersymbol, Temperaturkurve und
 * Regen teilen sich eine Zeitachse. Nachtstunden sind hinterlegt, eine Marke
 * zeigt „jetzt", und beim Antippen einer Stunde stehen alle Werte im Klartext
 * darüber — so wie man es von Wetter-Apps kennt.
 */
function HourlyForecast({ hourly, coords }: { hourly: WeatherForecast['hourly']; coords: Coords }) {
  const hours = hourly.slice(0, 24);
  const [picked, setPicked] = useState<number | null>(null);
  const width = hours.length * COL_W;
  const mid = (i: number) => i * COL_W + COL_W / 2;

  // --- Temperatur ---
  const temps = hours.map((h) => h.tempC).filter((v): v is number => v != null);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = hi - lo || 1;
  const tempY = (t: number) => TEMP_H - 8 - ((t - lo) / span) * (TEMP_H - 28);
  const tempLine = hours
    .map((h, i) => (h.tempC != null ? `${mid(i)},${tempY(h.tempC)}` : null))
    .filter(Boolean)
    .join(' ');

  // --- Regen ---
  const amounts = hours.map((h) => h.precipitationMm ?? 0);
  const total = Math.round(amounts.reduce((a, b) => a + b, 0) * 10) / 10;
  const peak = Math.max(...amounts);
  // Maßstab mindestens 1 mm, damit Nieselregen nicht wie Starkregen aussieht.
  const scale = Math.max(1, peak);
  const maxProb = Math.max(0, ...hours.map((h) => h.precipitationProbabilityPct ?? 0));
  const windows = rainWindows(hours);

  // --- Nachtstunden und Jetzt-Marke ---
  const night = hours.map((h) => sunAltitude(new Date(h.time), coords.lat, coords.lon) < -0.833);
  const firstTime = hours[0] ? new Date(hours[0].time).getTime() : Date.now();
  const nowX = ((Date.now() - firstTime) / 3600000) * COL_W + COL_W / 2;
  const nowVisible = nowX >= 0 && nowX <= width;

  const shown = picked != null ? hours[picked] : null;

  /** Spalte unter dem Zeiger bestimmen (Maus wie Touch). */
  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left) / COL_W);
    setPicked(i >= 0 && i < hours.length ? i : null);
  };

  const nightBands = (height: number) =>
    hours.map((h, i) =>
      night[i] ? <rect key={h.time} x={i * COL_W} y={0} width={COL_W} height={height} className="wx-night" /> : null,
    );

  return (
    <>
      <h4 className="sec-title">Nächste 24 Stunden</h4>

      <div className="rain-sum">
        {total > 0 ? (
          <>
            <b>
              {windows
                .slice(0, 2)
                .map((wnd) =>
                  hourOf(wnd.from) === hourOf(wnd.to)
                    ? `Regen um ${hourOf(wnd.from)} Uhr`
                    : `Regen ${hourOf(wnd.from)}–${hourOf(wnd.to) + 1} Uhr`,
                )
                .join(', ')}
              {windows.length > 2 && ' u. a.'}
            </b>{' '}
            · {num(total)} mm gesamt · Spitze {num(peak)} mm/h ({rainStep(peak).label})
          </>
        ) : (
          <>
            <b>Kein Regen erwartet</b>
            {maxProb > 0 && <> · höchste Wahrscheinlichkeit {maxProb} %</>}
          </>
        )}
      </div>

      {/* Werte der angetippten Stunde — sonst die Spanne des Zeitraums. */}
      <div className="wx-readout" aria-live="polite">
        {shown ? (
          <>
            <b>{hourLabel(shown.time)}</b>
            <span>{shown.tempC != null ? `${Math.round(shown.tempC)}°` : '–'}</span>
            <span>
              {(shown.precipitationMm ?? 0) > 0 ? `${num(shown.precipitationMm ?? 0)} mm` : 'trocken'}
              {shown.precipitationProbabilityPct != null && ` · ${shown.precipitationProbabilityPct} %`}
            </span>
            <span>
              Wind {shown.windKmh != null ? `${Math.round(shown.windKmh)} km/h` : '–'}
              {shown.windGustKmh != null && ` (Böen ${Math.round(shown.windGustKmh)})`}
            </span>
            <span className="muted-note">{shown.condition ? (CONDITION_DE[shown.condition] ?? '') : ''}</span>
          </>
        ) : (
          <span className="muted-note">
            Stunde antippen für Details · Temperatur {Math.round(lo)}° bis {Math.round(hi)}°
          </span>
        )}
      </div>

      <div className="wx-hours">
        <div
          className="wx-hours-inner"
          style={{ width }}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setPicked(null)}
        >
          {/* Stunde + Wettersymbol */}
          <div className="wx-hourrow">
            {hours.map((h, i) => (
              <div
                className={`wx-hour${night[i] ? ' is-night' : ''}${picked === i ? ' is-picked' : ''}`}
                key={h.time}
                style={{ width: COL_W }}
              >
                <span className="hh">{hourLabel(h.time)}</span>
                <WeatherIcon icon={h.icon} condition={h.condition} size={26} />
              </div>
            ))}
          </div>

          {/* Temperaturkurve */}
          <svg width={width} height={TEMP_H} className="wx-curve" role="img" aria-label="Temperaturverlauf">
            {nightBands(TEMP_H)}
            {picked != null && <rect x={picked * COL_W} y={0} width={COL_W} height={TEMP_H} className="wx-pick" />}
            <polyline points={tempLine} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
            {hours.map((h, i) =>
              h.tempC != null ? (
                <g key={h.time}>
                  <circle cx={mid(i)} cy={tempY(h.tempC)} r={2.4} fill="var(--accent)" />
                  <text x={mid(i)} y={tempY(h.tempC) - 8} textAnchor="middle" className="wx-curve-label">
                    {Math.round(h.tempC)}°
                  </text>
                </g>
              ) : null,
            )}
            {nowVisible && <line x1={nowX} y1={0} x2={nowX} y2={TEMP_H} className="wx-now" />}
          </svg>

          {/* Regenmenge als Balken, nach Stärke gefärbt */}
          <svg width={width} height={RAIN_H} className="rain-chart" role="img" aria-label="Regenmenge je Stunde">
            {nightBands(RAIN_BASE)}
            {picked != null && <rect x={picked * COL_W} y={0} width={COL_W} height={RAIN_BASE} className="wx-pick" />}
            <line x1={0} y1={RAIN_BASE} x2={width} y2={RAIN_BASE} stroke="var(--line-strong)" strokeWidth={1} />
            {hours.map((h, i) => {
              const mm = h.precipitationMm ?? 0;
              const height = mm > 0 ? Math.max(3, (mm / scale) * BAR_MAX) : 0;
              return (
                <g key={h.time}>
                  {height > 0 && (
                    <>
                      <rect
                        x={mid(i) - 8}
                        y={RAIN_BASE - height}
                        width={16}
                        height={height}
                        rx={2}
                        fill={rainStep(mm).color}
                      />
                      {mm >= scale / 3 && (
                        <text x={mid(i)} y={RAIN_BASE - height - 3} textAnchor="middle" className="rain-mm">
                          {num(Math.round(mm * 10) / 10)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
            {nowVisible && (
              <>
                <line x1={nowX} y1={0} x2={nowX} y2={RAIN_BASE} className="wx-now" />
                <text x={nowX + 4} y={11} className="wx-now-label">
                  jetzt
                </text>
              </>
            )}
          </svg>

          {/* Regenwahrscheinlichkeit als schlichter Wert je Stunde */}
          <div className="wx-hourrow wx-probrow">
            {hours.map((h, i) => {
              const prob = h.precipitationProbabilityPct;
              const level = prob == null ? '' : prob >= 60 ? ' high' : prob >= 30 ? ' mid' : '';
              return (
                <div
                  className={`wx-prob${level}${night[i] ? ' is-night' : ''}${picked === i ? ' is-picked' : ''}`}
                  key={h.time}
                  style={{ width: COL_W }}
                >
                  {prob != null ? `${prob} %` : '–'}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rain-legend">
        <span>
          <i className="line acc" /> Temperatur
        </span>
        {RAIN_STEPS.map((s, i) => (
          <span key={s.label}>
            <i className="bar" style={{ background: s.color }} />
            {s.label}
            {s.max === Infinity ? ` (> ${num(RAIN_STEPS[i - 1]!.max)} mm/h)` : ` (< ${num(s.max)} mm/h)`}
          </span>
        ))}
        <span>
          <i className="pct">%</i> Regenwahrscheinlichkeit
        </span>
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

export function TransitDetail({
  stops,
  onRoute,
}: {
  stops: TransitStop[];
  /** Halt anfahren (Routenplanung übernimmt ihn als Ziel). */
  onRoute?: (name: string, lat: number, lon: number) => void;
}) {
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
            {onRoute && s.coordinates && (
              <button
                type="button"
                className="rp-chip"
                onClick={() => onRoute(s.name, s.coordinates!.lat, s.coordinates!.lon)}
                title={`Route nach ${s.name}`}
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
          <DepartureBoard departures={s.departures} stopName={s.name} />
        </div>
      ))}
    </div>
  );
}

export function NewsDetail({
  list,
  onShowOnMap,
}: {
  list: NewsItem[];
  /** Meldung auf der Karte zeigen (nur bei verorteten Meldungen). */
  onShowOnMap?: (lat: number, lon: number) => void;
}) {
  const [onlyPlaced, setOnlyPlaced] = useState(false);
  const placed = list.filter((n) => n.place).length;
  const shown = onlyPlaced ? list.filter((n) => n.place) : list;
  if (list.length === 0) return <p className="muted">Keine Meldungen.</p>;
  return (
    <>
      <div className="news-filter">
        <button
          type="button"
          className={`rp-chip${onlyPlaced ? '' : ' is-on'}`}
          aria-pressed={!onlyPlaced}
          onClick={() => setOnlyPlaced(false)}
        >
          Alle ({list.length})
        </button>
        <button
          type="button"
          className={`rp-chip${onlyPlaced ? ' is-on' : ''}`}
          aria-pressed={onlyPlaced}
          onClick={() => setOnlyPlaced(true)}
        >
          Mit Ort ({placed})
        </button>
      </div>
      <ul className="news">
        {shown.map((n) => (
          <li className="news-item" key={n.id}>
            <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
            {n.summary && <p className="news-summary">{n.summary}</p>}
            <span className="tm">
              {n.topic ? `${n.topic} · ` : ''}
              {relativeTime(n.publishedAt)}
              {n.place && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="news-place"
                    onClick={() => onShowOnMap?.(n.place!.lat, n.place!.lon)}
                    title="Auf der Karte zeigen"
                  >
                    {n.place.name}
                    {n.place.approximate ? ' (ungenau)' : ''}
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
