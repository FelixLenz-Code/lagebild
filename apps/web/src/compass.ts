/**
 * Gerätekompass und Peilung.
 *
 * Zweck ist das Anlaufen eines Punktes ohne Karte im Blick: Rettungspunkt im
 * Wald, Sammelplatz im Nebel, Ausrichten einer Richtantenne. Deshalb steht
 * nicht die Rose im Mittelpunkt, sondern **wie weit man sich drehen muss**.
 *
 * Zur Nordrichtung: `deviceorientationabsolute` und Safaris
 * `webkitCompassHeading` liefern **rechtweisend Nord** (geographisch). Das
 * gewöhnliche `deviceorientation` liefert je nach Gerät nur eine relative
 * Ausrichtung — dann wird das offen gesagt, statt eine Genauigkeit
 * vorzutäuschen, die es nicht gibt.
 */

import { useEffect, useRef, useState } from 'react';
import type { Coords } from '@lagebild/shared';

export interface CompassState {
  /** Blickrichtung des Geräts in Grad (0 = Norden), null solange nichts kommt. */
  headingDeg: number | null;
  /** true, wenn die Richtung geographisch (rechtweisend) ist. */
  absolute: boolean;
  /** Muss der Nutzer die Erlaubnis noch erteilen? (iOS) */
  needsPermission: boolean;
  error: string | null;
}

/** Kleinster Winkelunterschied in Grad, Vorzeichen: + = nach rechts drehen. */
export function turnTo(headingDeg: number, bearingDeg: number): number {
  return ((bearingDeg - headingDeg + 540) % 360) - 180;
}

/** Peilung von a nach b in Grad (rechtweisend). */
export function bearingTo(a: Coords, b: Coords): number {
  const RAD = Math.PI / 180;
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const POINTS = [
  'N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/** Himmelsrichtung als Kürzel (16 Striche — feiner kann niemand halten). */
export const compassPoint = (deg: number): string =>
  POINTS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]!;

/** Anweisung im Klartext: „35° nach rechts drehen". */
export function turnText(turn: number): string {
  const rounded = Math.round(turn);
  if (Math.abs(rounded) <= 5) return 'Richtung stimmt';
  if (Math.abs(rounded) >= 175) return 'genau umdrehen';
  return `${Math.abs(rounded)}° nach ${rounded > 0 ? 'rechts' : 'links'} drehen`;
}

interface OrientationEventWithCompass extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/** Braucht dieses Gerät erst eine Erlaubnis? (iOS ab 13) */
const wantsPermission = (): boolean =>
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission ===
    'function';

/**
 * Kompass des Geräts. `active` schaltet die Lauscher an — sie kosten Strom und
 * gehören nicht in jede Sitzung.
 */
export function useCompass(active: boolean): CompassState & { request: () => void } {
  const [state, setState] = useState<CompassState>({
    headingDeg: null,
    absolute: false,
    needsPermission: false,
    error: null,
  });
  const [granted, setGranted] = useState(false);
  /** Geglättete Richtung — rohe Werte zappeln um mehrere Grad. */
  const smooth = useRef<number | null>(null);

  const request = () => {
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
      .requestPermission;
    if (typeof ask !== 'function') {
      setGranted(true);
      return;
    }
    ask()
      .then((result) => {
        if (result === 'granted') {
          setGranted(true);
          setState((s) => ({ ...s, needsPermission: false, error: null }));
        } else {
          setState((s) => ({ ...s, error: 'Ohne Erlaubnis für die Bewegungssensoren geht es nicht.' }));
        }
      })
      .catch(() => setState((s) => ({ ...s, error: 'Der Kompass ließ sich nicht einschalten.' })));
  };

  useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      setState((s) => ({ ...s, error: 'Dieses Gerät hat keinen Lagesensor.' }));
      return;
    }
    if (wantsPermission() && !granted) {
      setState((s) => ({ ...s, needsPermission: true }));
      return;
    }

    let gotSomething = false;
    const handle = (event: Event) => {
      const e = event as OrientationEventWithCompass;
      // Safari liefert die Kompassrichtung direkt und rechtweisend.
      let heading: number | null = null;
      let absolute = false;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        heading = e.webkitCompassHeading;
        absolute = true;
      } else if (typeof e.alpha === 'number') {
        // alpha zählt gegen den Uhrzeigersinn ab Norden.
        heading = (360 - e.alpha) % 360;
        absolute = e.absolute === true || event.type === 'deviceorientationabsolute';
      }
      if (heading == null || Number.isNaN(heading)) return;
      gotSomething = true;

      // Über den Nullpunkt hinweg mitteln: 359° und 1° liegen zwei Grad
      // auseinander, im Mittel aber nicht bei 180°.
      const previous = smooth.current;
      const next =
        previous == null ? heading : previous + turnTo(previous, heading) * 0.25;
      smooth.current = (next + 360) % 360;
      setState((s) => ({ ...s, headingDeg: smooth.current, absolute, error: null }));
    };

    window.addEventListener('deviceorientationabsolute', handle, true);
    window.addEventListener('deviceorientation', handle, true);
    // Kommt nach zwei Sekunden nichts, gibt es hier keinen brauchbaren Sensor.
    const timer = window.setTimeout(() => {
      if (!gotSomething) {
        setState((s) => ({
          ...s,
          error: 'Vom Lagesensor kommt nichts — am Rechner ist das normal.',
        }));
      }
    }, 2000);

    return () => {
      window.removeEventListener('deviceorientationabsolute', handle, true);
      window.removeEventListener('deviceorientation', handle, true);
      window.clearTimeout(timer);
    };
  }, [active, granted]);

  return { ...state, request };
}

/**
 * Wegpunkt-Projektion: von einem Punkt aus `distanceM` Meter auf die Peilung
 * `bearingDeg` gehen und den Zielpunkt zurückgeben.
 *
 * Klassisches Handwerkszeug: „von der Wegkreuzung 300 m auf 240°" ist eine
 * Ortsangabe, die man am Funk bekommt oder auf einer Papierkarte abliest.
 * Gerechnet auf der Kugel (Großkreis), damit es auch über Kilometer stimmt.
 */
export function projectPoint(from: Coords, bearingDeg: number, distanceM: number): Coords {
  const R = 6371008.8;
  const RAD = Math.PI / 180;
  const δ = distanceM / R;
  const θ = bearingDeg * RAD;
  const φ1 = from.lat * RAD;
  const λ1 = from.lon * RAD;

  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));

  return { lat: φ2 / RAD, lon: (((λ2 / RAD + 540) % 360) - 180) };
}

/** Eine Peilung von einem Standort aus. */
export interface Sighting {
  lat: number;
  lon: number;
  bearingDeg: number;
}

export type CrossResult =
  | {
      ok: true;
      point: Coords;
      /** Schnittwinkel der beiden Peilungen in Grad (0–90). */
      cutAngleDeg: number;
      /**
       * true, wenn der Schnitt zu spitz ist, um brauchbar zu sein. Seefahrt und
       * Vermessung verlangen seit jeher 30°–90°; unter 15° wandert der
       * Schnittpunkt bei einem Grad Peilfehler um Kilometer.
       */
      weak: boolean;
    }
  | { ok: false; reason: string };

/**
 * Kreuzpeilung: Wo schneiden sich zwei Peilungen?
 *
 * So ortet man eine Rauchsäule, einen Sender oder ein Signal, das man nur
 * sehen oder hören, aber nicht erreichen kann: einmal von hier peilen, ein
 * Stück zur Seite gehen, noch einmal peilen — der Schnittpunkt ist die Quelle.
 *
 * Gerechnet auf der Kugel (Schnitt zweier Großkreise, Formel nach Ed Williams).
 * Die Fallunterscheidungen sind kein Zierrat: Zwei Peilungen können parallel
 * laufen, sich hinter dem Rücken schneiden oder von demselben Punkt ausgehen —
 * und in all diesen Fällen wäre jede Zahl gelogen.
 */
export function crossBearing(a: Sighting, b: Sighting): CrossResult {
  const RAD = Math.PI / 180;
  const φ1 = a.lat * RAD;
  const λ1 = a.lon * RAD;
  const φ2 = b.lat * RAD;
  const λ2 = b.lon * RAD;
  const θ13 = a.bearingDeg * RAD;
  const θ23 = b.bearingDeg * RAD;
  const Δφ = φ2 - φ1;
  const Δλ = λ2 - λ1;

  const δ12 =
    2 *
    Math.asin(
      Math.sqrt(Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2),
    );
  if (δ12 < 1e-9) {
    return { ok: false, reason: 'Beide Peilungen stammen vom selben Punkt — geh ein Stück zur Seite.' };
  }

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const θa = Math.acos(clamp((Math.sin(φ2) - Math.sin(φ1) * Math.cos(δ12)) / (Math.sin(δ12) * Math.cos(φ1))));
  const θb = Math.acos(clamp((Math.sin(φ1) - Math.sin(φ2) * Math.cos(δ12)) / (Math.sin(δ12) * Math.cos(φ2))));
  const θ12 = Math.sin(Δλ) > 0 ? θa : 2 * Math.PI - θa;
  const θ21 = Math.sin(Δλ) > 0 ? 2 * Math.PI - θb : θb;

  const α1 = θ13 - θ12;
  const α2 = θ21 - θ23;
  if (Math.abs(Math.sin(α1)) < 1e-12 && Math.abs(Math.sin(α2)) < 1e-12) {
    // Auf der Kugel schneiden sich zwei Großkreise **immer** — außer sie sind
    // derselbe. Genau dieser Fall ist hier gemeint.
    return { ok: false, reason: 'Beide Peilungen liegen auf derselben Linie — so lässt sich nichts kreuzen.' };
  }
  if (Math.sin(α1) * Math.sin(α2) < 0) {
    return { ok: false, reason: 'Die Peilungen schneiden sich nur hinter dem Rücken. Richtungen prüfen.' };
  }

  const α3 = Math.acos(clamp(-Math.cos(α1) * Math.cos(α2) + Math.sin(α1) * Math.sin(α2) * Math.cos(δ12)));
  const δ13 = Math.atan2(
    Math.sin(δ12) * Math.sin(α1) * Math.sin(α2),
    Math.cos(α2) + Math.cos(α1) * Math.cos(α3),
  );
  const φ3 = Math.asin(clamp(Math.sin(φ1) * Math.cos(δ13) + Math.cos(φ1) * Math.sin(δ13) * Math.cos(θ13)));
  const Δλ13 = Math.atan2(
    Math.sin(θ13) * Math.sin(δ13) * Math.cos(φ1),
    Math.cos(δ13) - Math.sin(φ1) * Math.sin(φ3),
  );

  // Schnittwinkel: Er entscheidet, wie viel die Ortung taugt.
  const cut = Math.abs(((a.bearingDeg - b.bearingDeg + 540) % 360) - 180);
  const cutAngleDeg = cut > 90 ? 180 - cut : cut;

  return {
    ok: true,
    point: { lat: φ3 / RAD, lon: ((((λ1 + Δλ13) / RAD + 540) % 360) - 180) },
    cutAngleDeg,
    weak: cutAngleDeg < 15,
  };
}
