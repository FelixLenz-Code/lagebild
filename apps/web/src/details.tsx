import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DepartureBoard } from './Departures.js';
import { BlaulichtIcon, NewsIcon } from './NewsIcon.js';
import type {
  Coords,
  WeatherNow,
  WeatherForecast,
  WarningFeature,
  CivilWarning,
  TrafficIncident,
  WaterLevel,
  NewsItem,
  BlaulichtItem,
  Aircraft,
  AirQuality,
  PollenForecast,
  TransitStop,
  TransitDeparture,
  TransitTrip,
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
import { BOS_COLORS, BOS_LABEL } from './mapIcons.js';
import { WeatherIcon } from './WeatherIcon.js';
import { sunAltitude } from './sun.js';
import {
  BLOCKER_DE,
  DEFAULT_CRITERIA,
  findWindows,
  type Blocker,
  type WindowCriteria,
} from './weatherWindow.js';

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
  pollen,
  coords,
}: {
  w: WeatherNow;
  forecast?: WeatherForecast | null;
  air?: AirQuality | null;
  pollen?: PollenForecast | null;
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
      {forecast && forecast.hourly.length > 0 && (
        <WeatherWindows hourly={forecast.hourly} coords={coords} />
      )}
      {forecast && forecast.daily.length > 0 && <DailyList daily={forecast.daily} />}
      {air && <AirSection air={air} />}
      {pollen && <PollenSection pollen={pollen} />}
    </>
  );
}

/**
 * Wetterfenster — „wann kann ich raus?".
 *
 * Die Voreinstellungen sind für draußen arbeiten gedacht (trocken, wenig Wind,
 * hell). Wer etwas anderes vorhat, verschiebt die Regler; gerechnet wird sofort
 * neu, weil alles im Gerät passiert.
 */
function WeatherWindows({ hourly, coords }: { hourly: WeatherForecast['hourly']; coords: Coords }) {
  const [criteria, setCriteria] = useState<WindowCriteria>(DEFAULT_CRITERIA);
  const [minHours, setMinHours] = useState(2);
  const result = findWindows(hourly, coords, criteria, minHours);
  const set = (patch: Partial<WindowCriteria>) => setCriteria((c) => ({ ...c, ...patch }));

  // Wenn nichts passt, ist die nützlichste Auskunft, **woran** es liegt.
  const worst = (Object.entries(result.reasons) as [Blocker, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="sect-label">Wetterfenster</div>
      <div className="ww-controls">
        <label>
          Wind bis <b className="mono">{criteria.maxWindKmh} km/h</b>
          <input
            type="range"
            min={10}
            max={80}
            step={5}
            value={criteria.maxWindKmh}
            onChange={(e) => set({ maxWindKmh: Number(e.target.value) })}
          />
        </label>
        <label>
          Regenrisiko bis <b className="mono">{criteria.maxRainProbPct} %</b>
          <input
            type="range"
            min={0}
            max={90}
            step={10}
            value={criteria.maxRainProbPct}
            onChange={(e) => set({ maxRainProbPct: Number(e.target.value) })}
          />
        </label>
        <label>
          Mindestens <b className="mono">{minHours} h</b> am Stück
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={minHours}
            onChange={(e) => setMinHours(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className={`ww-toggle${criteria.daylightOnly ? ' is-on' : ''}`}
          aria-pressed={criteria.daylightOnly}
          onClick={() => set({ daylightOnly: !criteria.daylightOnly })}
        >
          nur bei Tageslicht
        </button>
      </div>

      {result.windows.length === 0 ? (
        <p className="muted">
          In den nächsten {result.checked} Stunden passt nichts zusammen.
          {worst.length > 0 && (
            <>
              {' '}
              Im Weg steht vor allem {BLOCKER_DE[worst[0]![0]]}
              {worst[1] ? ` und ${BLOCKER_DE[worst[1]![0]]}` : ''}.
            </>
          )}
        </p>
      ) : (
        <ul className="ww-list">
          {result.windows.map((w) => (
            <li key={w.start}>
              <b>
                {dayLabel(w.start.slice(0, 10))} {hourLabel(w.start)}–
                {hourLabel(new Date(new Date(w.end).getTime() + 3600_000).toISOString())}
              </b>
              <span className="mono">
                {w.hours} h
                {w.maxTempC != null ? ` · bis ${Math.round(w.maxTempC)}°` : ''}
                {w.maxWindKmh != null ? ` · Wind bis ${Math.round(w.maxWindKmh)} km/h` : ''}
                {w.maxRainProbPct != null ? ` · Regen ${Math.round(w.maxRainProbPct)} %` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Pollenflug als Abschnitt der Wetteransicht.
 *
 * Der DWD gibt den Index je Region heraus, nicht je Ort — die Region steht
 * deshalb dabei. Gibt es mehrere Teilregionen, zeigt die App den höheren Wert;
 * auch das wird genannt, damit niemand die Zahl für punktgenau hält.
 */
function PollenSection({ pollen }: { pollen: PollenForecast }) {
  // Arten ohne jede Belastung stehen nur im Nachsatz — sonst acht leere Zeilen.
  const active = pollen.kinds.filter(
    (k) => k.today.value > 0 || k.tomorrow.value > 0 || k.dayAfter.value > 0,
  );
  const quiet = pollen.kinds.filter((k) => !active.includes(k));
  const bar = (value: number) => Math.round((value / 3) * 100);

  return (
    <>
      <h4 className="sec-title">Pollenflug</h4>
      {active.length === 0 && <p className="muted">Zurzeit fliegen keine der acht Arten.</p>}
      {active.length > 0 && (
        <table className="pollen">
          <thead>
            <tr>
              <th scope="col">Art</th>
              <th scope="col">heute</th>
              <th scope="col">morgen</th>
              <th scope="col">übermorgen</th>
            </tr>
          </thead>
          <tbody>
            {active.map((k) => (
              <tr key={k.kind}>
                <th scope="row">{k.kind}</th>
                {[k.today, k.tomorrow, k.dayAfter].map((load, i) => (
                  <td key={i} title={load.text}>
                    <span className="pl-bar" aria-hidden="true">
                      <i style={{ width: `${bar(load.value)}%` }} />
                    </span>
                    <span className="pl-text">{load.text}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {quiet.length > 0 && (
        <p className="muted pollen-quiet">Ohne Belastung: {quiet.map((k) => k.kind).join(', ')}.</p>
      )}
      <p className="sr-hint">
        Region {pollen.regionName}
        {pollen.partRegions.length > 1
          ? ` (höchster Wert aus ${pollen.partRegions.length} Teilregionen)`
          : ''}
        {pollen.updatedAt ? ` · Stand ${pollen.updatedAt}` : ''}
      </p>
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

/** Behördenwarnungen (BBK/NINA) als Liste — mit Herkunft und Gebiet. */
export function CivilWarningsDetail({ list }: { list: CivilWarning[] }) {
  if (list.length === 0) return <p className="muted">Keine Behördenwarnungen im Kartenausschnitt.</p>;
  return (
    <div className="detail-list">
      {list.map((w) => (
        <div className="alert-block" key={w.id} style={{ borderColor: SEVERITY_VAR[w.severity] }}>
          <div className="alert-top">
            <span className="sev-pill" style={{ background: SEVERITY_VAR[w.severity] }}>
              {SEVERITY_DE[w.severity]}
            </span>
            <b>{w.headline}</b>
          </div>
          <div className="alert-meta mono">
            {w.channel}
            {w.areaDesc ? ` · ${w.areaDesc}` : ''}
            {w.expires ? ` · bis ${formatDateTime(w.expires)}` : w.onset ? ` · seit ${formatDateTime(w.onset)}` : ''}
          </div>
          {w.description && <p className="alert-desc">{w.description}</p>}
          {w.instruction && <p className="alert-desc alert-instruction">{w.instruction}</p>}
          {w.web && (
            <a className="alert-link" href={w.web} target="_blank" rel="noreferrer">
              Mehr dazu
            </a>
          )}
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
  onShowRoute,
}: {
  stops: TransitStop[];
  /** Halt anfahren (Routenplanung übernimmt ihn als Ziel). */
  onRoute?: (name: string, lat: number, lon: number) => void;
  /** Fahrtweg einer Abfahrt auf die Karte legen. */
  onShowRoute?: (departure: TransitDeparture, trip: TransitTrip) => void;
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
                Navigieren
              </button>
            )}
          </div>
          <DepartureBoard departures={s.departures} stopName={s.name} onShowRoute={onShowRoute} />
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
  const [filter, setFilter] = useState<'all' | 'placed' | 'regional'>('all');
  const placed = list.filter((n) => n.place).length;
  const regional = list.filter((n) => n.regional).length;
  const shown =
    filter === 'placed'
      ? list.filter((n) => n.place)
      : filter === 'regional'
        ? list.filter((n) => n.regional)
        : list;
  if (list.length === 0) return <p className="muted">Keine Meldungen.</p>;
  return (
    <>
      <div className="news-filter">
        {(
          [
            ['all', `Alle (${list.length})`],
            ['regional', `Aus der Region (${regional})`],
            ['placed', `Mit Ort (${placed})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`rp-chip${filter === key ? ' is-on' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="news">
        {shown.map((n) => (
          <li className="news-item has-ico" key={n.id}>
            <NewsIcon category={n.category} size={20} />
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

/**
 * Blaulicht-Meldungen. Der Filter steht auf „Einsätze", weil das der Grund
 * ist, diese Liste zu öffnen: Zeugenaufrufe, Aktionstage und Nachwuchswerbung
 * machen den größeren Teil des Feeds aus, sind aber für ein Lagebild ohne
 * Belang. Volltexte gibt es bewusst nicht — nur den Rücklink.
 */
export function BlaulichtDetail({
  list,
  onShowOnMap,
}: {
  list: BlaulichtItem[];
  onShowOnMap?: (lat: number, lon: number) => void;
}) {
  const [filter, setFilter] = useState<'incident' | 'all' | 'placed'>('incident');
  const incidents = list.filter((b) => b.incident);
  const placed = list.filter((b) => b.place);
  const shown = filter === 'incident' ? incidents : filter === 'placed' ? placed : list;
  if (list.length === 0) return <p className="muted">Keine Meldungen.</p>;
  return (
    <>
      <div className="news-filter">
        {(
          [
            ['incident', `Einsätze (${incidents.length})`],
            ['all', `Alle (${list.length})`],
            ['placed', `Mit Ort (${placed.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`rp-chip${filter === key ? ' is-on' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">Nichts in dieser Auswahl.</p>}
      <ul className="news">
        {shown.map((b) => (
          <li className="news-item has-ico" key={b.id}>
            <BlaulichtIcon kind={b.kind} size={20} />
            <a href={b.url} target="_blank" rel="noreferrer">{b.title}</a>
            {b.summary && <p className="news-summary">{b.summary}</p>}
            <span className="tm">
              {b.agency} · {relativeTime(b.publishedAt)}
              {b.place && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="news-place"
                    onClick={() => onShowOnMap?.(b.place!.lat, b.place!.lon)}
                    title="Auf der Karte zeigen"
                  >
                    {b.place.name}
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="sect-note">
        Pressemeldungen der Dienststellen über{' '}
        <a href="https://www.presseportal.de/blaulicht" target="_blank" rel="noreferrer">
          presseportal.de
        </a>{' '}
        (news aktuell). Keine Einsatzdaten — die Meldungen erscheinen nach dem Ereignis.
      </p>
    </>
  );
}

/**
 * Luftfahrzeuge von Luftrettung, Polizei und Zoll. Sortiert nach Aufgabe und
 * dann nach Höhe: Was in der Luft ist, steht oben — genau das ist der
 * Lagehinweis.
 */
export function BosAirDetail({
  list,
  onShowOnMap,
}: {
  list: Aircraft[];
  onShowOnMap?: (lat: number, lon: number) => void;
}) {
  if (list.length === 0) return <p className="muted">Keine BOS-Luftfahrzeuge im Ausschnitt.</p>;
  const sorted = [...list].sort(
    (a, b) => Number(a.onGround) - Number(b.onGround) || (b.altitudeFt ?? 0) - (a.altitudeFt ?? 0),
  );
  return (
    <>
      <ul className="news">
        {sorted.map((a) => {
          const bos = a.bos!;
          return (
            <li className="news-item has-ico" key={a.icao}>
              <span
                className="news-ico"
                title={BOS_LABEL[bos.role]}
                aria-label={BOS_LABEL[bos.role]}
                style={{ background: BOS_COLORS[bos.role], width: 28, height: 28 }}
              >
                <svg viewBox="0 0 32 32" width={20} height={20} fill="#fff" aria-hidden="true">
                  <path d="M15 8h2v13h-2Z M5.5 14.6h21v1.8h-21Z M9 7.7 24.3 23l-1.3 1.3L7.7 9Z M23 7.7 7.7 23 9 24.3 24.3 9Z M13.6 20.5h4.8v2.2h-4.8Z" />
                </svg>
              </span>
              <button
                type="button"
                className="news-place"
                onClick={() => onShowOnMap?.(a.coordinates.lat, a.coordinates.lon)}
                title="Auf der Karte zeigen"
              >
                {bos.name ?? a.callsign ?? a.registration ?? a.icao.toUpperCase()}
              </button>
              <span className="tm">
                {BOS_LABEL[bos.role]}
                {bos.operator ? ` · ${bos.operator}` : ''}
                {' · '}
                {a.onGround
                  ? 'am Boden'
                  : a.altitudeFt != null
                    ? `${a.altitudeFt.toLocaleString('de-DE')} ft`
                    : 'in der Luft'}
                {a.registration ? ` · ${a.registration}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="sect-note">
        Erkannt am Rufzeichen und am Halter aus der Luftfahrzeugrolle (ADS-B, adsbdb.com). Nicht
        jede Maschine sendet — die Liste ist nie vollständig.
      </p>
    </>
  );
}
