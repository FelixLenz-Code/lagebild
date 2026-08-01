import { useState } from 'react';
import type { ManeuverModifier, ManeuverType, RouteProfile, RouteResult, RouteStep } from '@lagebild/shared';
import type { RouteProgress } from './offline/follow.js';
import type { Place } from './places.js';

interface Props {
  origin: Place | null;
  destination: Place;
  profile: RouteProfile;
  /** Gewählte Route. */
  route: RouteResult | null;
  /** Alle gefundenen Varianten, die schnellste zuerst. */
  routes: RouteResult[];
  routeIndex: number;
  onSelectRoute: (index: number) => void;
  avoidMotorways: boolean;
  onToggleMotorways: () => void;
  loading: boolean;
  error: string | null;
  /** Für diese Gegend liegt überhaupt ein Routing-Paket im Gerät. */
  regionReady: boolean;
  navigating: boolean;
  progress: RouteProgress | null;
  muted: boolean;
  onProfile: (p: RouteProfile) => void;
  onSwap: () => void;
  /** Start wieder auf den eigenen Standort legen. */
  onResetOrigin: () => void;
  onStartNav: () => void;
  onStopNav: () => void;
  onToggleMute: () => void;
  onClose: () => void;
}

const PROFILE_LABEL: Record<RouteProfile, string> = { car: 'Auto', bike: 'Rad', foot: 'Zu Fuß' };

export const formatDistance = (m: number): string =>
  m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;

export const formatDuration = (s: number): string => {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
};

const arrival = (s: number): string =>
  new Date(Date.now() + s * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Pfeilsymbol zur Fahranweisung. */
export function ManeuverIcon({ type, modifier, size = 22 }: { type: ManeuverType; modifier: ManeuverModifier | null; size?: number }) {
  const paths: Record<string, JSX.Element> = {
    left: <path d="M18 20V11a4 4 0 0 0-4-4H7M11 3 7 7l4 4" />,
    right: <path d="M6 20v-9a4 4 0 0 1 4-4h7M13 3l4 4-4 4" />,
    'slight-left': <path d="M16 20v-7c0-2 -1-3.5 -2.5-4.5L9 6M9 6h4M9 6v4" />,
    'slight-right': <path d="M8 20v-7c0-2 1-3.5 2.5-4.5L15 6M15 6h-4M15 6v4" />,
    'sharp-left': <path d="M18 20v-6a5 5 0 0 0-5-5H8M12 5 7 9l5 4" />,
    'sharp-right': <path d="M6 20v-6a5 5 0 0 1 5-5h5M12 5l5 4-5 4" />,
    straight: <path d="M12 21V4M7 9l5-5 5 5" />,
    uturn: <path d="M8 21V10a4 4 0 0 1 8 0v6M12 12l4 4 4-4" />,
    arrive: <path d="M12 21s-6-5.7-6-10a6 6 0 1 1 12 0c0 4.3-6 10-6 10Z M12 11h.01" />,
    depart: <circle cx="12" cy="12" r="6" />,
    roundabout: (
      <>
        <circle cx="12" cy="11" r="4.5" />
        <path d="M12 21v-5.5M16.5 11H21M19 8l3 3-3 3" />
      </>
    ),
    merge: <path d="M12 21V9M12 9 7 4M12 9l5-5" />,
  };
  const key =
    type === 'arrive' || type === 'depart' || type === 'roundabout' || type === 'merge'
      ? type
      : (modifier ?? 'straight');
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[key] ?? paths.straight}
    </svg>
  );
}

export function RoutePanel(props: Props) {
  const [showSteps, setShowSteps] = useState(false);
  const { route, progress, navigating } = props;

  /* --- Zielführung --- */
  if (navigating && route) {
    const stepIndex = progress ? Math.min(progress.stepIndex + 1, route.steps.length - 1) : 0;
    const next: RouteStep = route.steps[stepIndex]!;
    const remainingM = progress?.remainingM ?? route.distanceM;
    const remainingS = progress?.remainingS ?? route.durationS;
    return (
      <section className="navbar" aria-label="Zielführung">
        <div className="nav-main">
          <span className="nav-ico">
            <ManeuverIcon type={next.type} modifier={next.modifier} size={30} />
          </span>
          <div className="nav-text">
            <b>{progress ? formatDistance(progress.distanceToManeuverM) : '—'}</b>
            <span>{next.text}</span>
          </div>
          <button
            type="button"
            className={`iconbtn${props.muted ? ' is-off' : ''}`}
            onClick={props.onToggleMute}
            title={props.muted ? 'Ansagen einschalten' : 'Ansagen ausschalten'}
            aria-label={props.muted ? 'Ansagen einschalten' : 'Ansagen ausschalten'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9v6h4l5 4V5L8 9H4Z" />
              {props.muted ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7" />}
            </svg>
          </button>
        </div>
        <div className="nav-foot">
          <span>
            noch <b>{formatDistance(remainingM)}</b>
          </span>
          <span>
            <b>{formatDuration(remainingS)}</b>
          </span>
          <span>an {arrival(remainingS)}</span>
          {progress && progress.offRouteM > 55 && <span className="nav-warn">abseits der Route</span>}
          <button type="button" className="btn-quiet" onClick={props.onStopNav}>
            Beenden
          </button>
        </div>
      </section>
    );
  }

  /* --- Planung --- */
  return (
    <section className="routepanel" aria-label="Route">
      <div className="rp-head">
        <h3>Route</h3>
        <div className="rp-profiles" role="group" aria-label="Fortbewegungsart">
          {(['car', 'bike', 'foot'] as RouteProfile[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`rp-profile${props.profile === p ? ' is-on' : ''}`}
              onClick={() => props.onProfile(p)}
              aria-pressed={props.profile === p}
            >
              {PROFILE_LABEL[p]}
            </button>
          ))}
        </div>
        <button type="button" className="iconbtn close" onClick={props.onClose} aria-label="Route schließen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="rp-points">
        <div className="rp-point">
          <i className="dot start" />
          <span>{props.origin ? props.origin.name : 'Mein Standort'}</span>
          {props.origin && (
            <button
              type="button"
              className="rp-chip"
              onClick={props.onResetOrigin}
              title="Wieder vom eigenen Standort starten"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="7" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
              </svg>
              Mein Standort
            </button>
          )}
          <button
            type="button"
            className="rp-chip icon"
            onClick={props.onSwap}
            title="Start und Ziel tauschen"
            aria-label="Start und Ziel tauschen"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 4v16M8 4 5 7M8 4l3 3" />
              <path d="M16 20V4M16 20l-3-3M16 20l3-3" />
            </svg>
          </button>
        </div>
        <div className="rp-point">
          <i className="dot end" />
          <span>{props.destination.name}</span>
        </div>
      </div>

      {!props.regionReady && (
        <p className="rp-hint err">
          Für diese Gegend ist kein Routing-Paket gespeichert. Lade die Region unter „Offline" —
          gerechnet wird ausschließlich auf dem Gerät.
        </p>
      )}
      {props.regionReady && props.loading && <p className="muted">Route wird berechnet …</p>}
      {props.regionReady && !props.loading && props.error && <p className="rp-hint err">{props.error}</p>}

      {route && !props.loading && (
        <>
          {props.routes.length > 1 && (
            <div className="rp-alts" role="group" aria-label="Streckenvarianten">
              {props.routes.map((r, i) => {
                const diff = Math.round((r.durationS - props.routes[0]!.durationS) / 60);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`rp-alt${i === props.routeIndex ? ' is-on' : ''}`}
                    aria-pressed={i === props.routeIndex}
                    onClick={() => props.onSelectRoute(i)}
                  >
                    <b>{formatDuration(r.durationS)}</b>
                    <span>{formatDistance(r.distanceM)}</span>
                    <span className="rp-alt-diff">
                      {i === 0 ? 'schnellste' : diff <= 0 ? 'gleich schnell' : `+${diff} min`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="rp-summary">
            <b>{formatDistance(route.distanceM)}</b>
            <b>{formatDuration(route.durationS)}</b>
            <span>Ankunft {arrival(route.durationS)}</span>
            <label className="rp-avoid">
              <input type="checkbox" checked={props.avoidMotorways} onChange={props.onToggleMotorways} />
              Autobahn meiden
            </label>
          </div>
          <div className="rp-actions">
            <button type="button" className="btn-primary" onClick={props.onStartNav}>
              Navigation starten
            </button>
            <button type="button" className="btn-quiet" onClick={() => setShowSteps((v) => !v)}>
              {showSteps ? 'Anweisungen ausblenden' : `${route.steps.length} Anweisungen`}
            </button>
          </div>
          {showSteps && (
            <ol className="rp-steps">
              {route.steps.map((s, i) => (
                <li key={i}>
                  <span className="st-ico">
                    <ManeuverIcon type={s.type} modifier={s.modifier} size={18} />
                  </span>
                  <span className="st-text">{s.text}</span>
                  <span className="st-dist">{s.distanceM >= 1 ? formatDistance(s.distanceM) : ''}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
