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
