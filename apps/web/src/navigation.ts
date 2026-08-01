/**
 * Zielführung: folgt der eigenen Position auf der berechneten Route, sagt die
 * nächste Anweisung an und meldet, wenn man die Route verlassen hat.
 *
 * Die Sprachausgabe nutzt die Stimmen des Geräts (SpeechSynthesis) — die
 * arbeiten offline, passend zum Rest der Navigation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Coords, RouteProfile, RouteResult } from '@lagebild/shared';
import { follow, type RouteProgress } from './offline/follow.js';

/** Ab welcher Entfernung angesagt wird (weit, nah) — je Fortbewegungsart. */
const BANDS: Record<RouteProfile, [number, number]> = {
  car: [400, 90],
  bike: [150, 40],
  foot: [60, 18],
};

/** Ab diesem Abstand zur Linie gilt die Route als verlassen. */
const OFF_ROUTE_M = 55;
/** So viele Ortungen hintereinander müssen daneben liegen. */
const OFF_ROUTE_FIXES = 3;

export interface NavigationState {
  position: Coords | null;
  /** Richtung aus der Ortung (Grad) — auf dem Gerät oft nur bei Bewegung. */
  heading: number | null;
  speedKmh: number | null;
  progress: RouteProgress | null;
  /** Fehlertext der Ortung, falls sie nicht läuft. */
  error: string | null;
}

function speak(text: string, muted: boolean): void {
  if (muted || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'de-DE';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* Sprachausgabe ist Beiwerk — Fehler dürfen die Navigation nicht stören. */
  }
}

/** Entfernungen für die Ansage runden („in dreihundert Metern"). */
function spokenDistance(m: number): string {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toString().replace('.', ',')} Kilometern`;
  const rounded = m > 300 ? Math.round(m / 100) * 100 : m > 50 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
  return `${rounded} Metern`;
}

/**
 * Verfolgt die Position entlang der Route.
 *
 * @param route Die aktive Route (null = keine Zielführung)
 * @param active Zielführung läuft
 * @param profile Fortbewegungsart (steuert die Ansagezeitpunkte)
 * @param muted Sprachausgabe aus
 * @param onOffRoute Wird gerufen, wenn neu berechnet werden sollte
 */
export function useNavigation(
  route: RouteResult | null,
  active: boolean,
  profile: RouteProfile,
  muted: boolean,
  onOffRoute: (position: Coords) => void,
): NavigationState {
  const [state, setState] = useState<NavigationState>({
    position: null,
    heading: null,
    speedKmh: null,
    progress: null,
    error: null,
  });
  const hint = useRef(0);
  const announced = useRef(new Set<string>());
  const offRouteCount = useRef(0);
  const offRouteRef = useRef(onOffRoute);
  offRouteRef.current = onOffRoute;

  // Neue Route → Ansagen und Suchfenster zurücksetzen.
  useEffect(() => {
    hint.current = 0;
    announced.current.clear();
    offRouteCount.current = 0;
  }, [route]);

  const handleFix = useCallback(
    (pos: GeolocationPosition) => {
      const position = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      const heading = Number.isFinite(pos.coords.heading) ? (pos.coords.heading as number) : null;
      const speedKmh = Number.isFinite(pos.coords.speed) ? (pos.coords.speed as number) * 3.6 : null;
      if (!route) {
        setState({ position, heading, speedKmh, progress: null, error: null });
        return;
      }
      const progress = follow(route, position, hint.current);
      hint.current = progress.coordIndex;
      setState({ position, heading, speedKmh, progress, error: null });

      // Von der Route abgekommen?
      if (progress.offRouteM > OFF_ROUTE_M) {
        offRouteCount.current++;
        if (offRouteCount.current >= OFF_ROUTE_FIXES) {
          offRouteCount.current = 0;
          announced.current.clear();
          speak('Route wird neu berechnet', muted);
          offRouteRef.current(position);
        }
        return;
      }
      offRouteCount.current = 0;

      // Ansagen: einmal weit vorher, einmal kurz davor.
      const next = route.steps[progress.stepIndex + 1];
      if (!next) {
        if (progress.remainingM < 25 && !announced.current.has('arrive')) {
          announced.current.add('arrive');
          speak('Sie haben Ihr Ziel erreicht', muted);
        }
        return;
      }
      const [far, near] = BANDS[profile];
      const d = progress.distanceToManeuverM;
      const key = (band: string) => `${progress.stepIndex}:${band}`;
      if (d < far && d > near && !announced.current.has(key('far'))) {
        announced.current.add(key('far'));
        speak(`In ${spokenDistance(d)} ${next.text}`, muted);
      } else if (d <= near && !announced.current.has(key('near'))) {
        announced.current.add(key('near'));
        announced.current.add(key('far'));
        speak(next.text, muted);
      }
    },
    [route, profile, muted],
  );

  useEffect(() => {
    if (!active || !('geolocation' in navigator)) {
      if (active) setState((s) => ({ ...s, error: 'Diese Umgebung kennt keine Ortung.' }));
      return;
    }
    const id = navigator.geolocation.watchPosition(
      handleFix,
      (err) =>
        setState((s) => ({
          ...s,
          error: err.code === err.PERMISSION_DENIED ? 'Ortung nicht erlaubt.' : 'Kein Ortungssignal.',
        })),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    return () => {
      navigator.geolocation.clearWatch(id);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [active, handleFix]);

  return state;
}
