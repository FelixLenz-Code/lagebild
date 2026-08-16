import { useEffect, useMemo, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { populationOffline } from './offline/client.js';
import type { PopulationResult } from './offline/population.js';
import {
  loadHazmat,
  lookupUn,
  readKemler,
  readPlate,
  searchHazmat,
  type HazmatDistances,
  type HazmatHit,
  type KemlerReading,
} from './hazmat.js';
import { compassPoint } from './compass.js';
import { sunAltitude } from './sun.js';

/**
 * Gefahrgut nachschlagen — und die Zahl auf die Karte bringen.
 *
 * Der Ablauf folgt dem, was am Einsatzort wirklich passiert: Man liest die
 * orangefarbene Tafel ab, tippt sie ein und will zwei Dinge wissen — **wie weit
 * absperren** und **wer ist betroffen**. Beides steht hier untereinander, und
 * beides lässt sich mit einem Tippen auf die Karte legen bzw. an das
 * Fluchtrouting weitergeben.
 */

interface Props {
  /** Wo der Austritt angenommen wird (Standort oder angetippter Punkt). */
  at: Coords;
  atLabel: string;
  /** Regionen mit Bevölkerungspaket am Ort. */
  popCodes: string[];
  /** Windrichtung (Grad, **aus** denen der Wind weht) und Stärke. */
  windFromDeg: number | null;
  windKmh: number | null;
  /** Gefahrenbereich auf der Karte zeigen. */
  onShowZone: (zone: HazmatZone | null) => void;
  /** Fluchtrouting mit diesem Radius und dieser Windlage starten. */
  onEscape: (radiusM: number) => void;
  onClose: () => void;
}

/** Was die Karte von einem Gefahrenbereich wissen muss. */
export interface HazmatZone {
  center: Coords;
  /** Absperrradius rundum, in Metern. */
  isolationM: number;
  /** Länge der Fahne stromab, in Metern (0 = keine). */
  downwindM: number;
  /** Richtung, **in** die es zieht (Grad ab Nord). */
  towardDeg: number | null;
  label: string;
}

/** Halber Öffnungswinkel der Fahne — wie im Fluchtrouting. */
export const PLUME_HALF_ANGLE = 35;

const fmtKm = (km: number) => (km >= 1 ? `${km.toLocaleString('de-DE')} km` : `${Math.round(km * 1000)} m`);
const fmtPeople = (n: number) => n.toLocaleString('de-DE');

export function HazmatSheet(props: Props) {
  const [query, setQuery] = useState('');
  const [ready, setReady] = useState<boolean | null>(null);
  const [hit, setHit] = useState<HazmatHit | null>(null);
  const [matches, setMatches] = useState<HazmatHit[]>([]);
  const [kemler, setKemler] = useState<KemlerReading | null>(null);
  const [large, setLarge] = useState(false);
  const [people, setPeople] = useState<{ circle: PopulationResult; plume: PopulationResult | null } | null>(null);
  const [popMissing, setPopMissing] = useState(false);

  // Nachts reicht die Wolke weiter — die Luft ist ruhiger und schichtet sich.
  // Das ERG führt beide Werte, die Vorauswahl richtet sich nach der Sonne.
  const night = sunAltitude(new Date(), props.at.lat, props.at.lon) < -0.833;

  useEffect(() => {
    loadHazmat()
      .then(() => setReady(true))
      .catch(() => setReady(false));
  }, []);

  /** Eingabe auswerten: UN-Nummer, Gefahrnummer, sonst Freitext. */
  useEffect(() => {
    let cancelled = false;
    const plate = readPlate(query);
    setKemler(plate.kemler ? readKemler(plate.kemler) : null);
    if (!plate.un && !plate.text) {
      setHit(null);
      setMatches([]);
      return;
    }
    void loadHazmat()
      .then((data) => {
        if (cancelled) return;
        if (plate.un != null) {
          setHit(lookupUn(data, plate.un));
          setMatches([]);
        } else if (plate.text) {
          const found = searchHazmat(data, plate.text);
          setMatches(found);
          setHit(found.length === 1 ? found[0]! : null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [query]);

  const distances: HazmatDistances | null = hit?.distances ?? null;
  const isolationM = large ? distances?.largeIsolationM : distances?.smallIsolationM;
  const downwindKm = large
    ? night
      ? distances?.largeNightKm
      : distances?.largeDayKm
    : night
      ? distances?.smallNightKm
      : distances?.smallDayKm;

  /** Die Fahne zieht dorthin, wohin der Wind weht — also Richtung + 180°. */
  const towardDeg = props.windFromDeg == null ? null : (props.windFromDeg + 180) % 360;

  const zone = useMemo<HazmatZone | null>(() => {
    if (!hit || isolationM == null) return null;
    return {
      center: props.at,
      isolationM,
      downwindM: (downwindKm ?? 0) * 1000,
      towardDeg,
      label: `UN ${hit.material.id} · ${hit.material.name}`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit, isolationM, downwindKm, towardDeg, props.at.lat, props.at.lon]);

  /** Betroffene im Absperrkreis und in der Fahne. */
  useEffect(() => {
    setPeople(null);
    setPopMissing(false);
    if (!zone || !props.popCodes.length) {
      if (zone && !props.popCodes.length) setPopMissing(true);
      return;
    }
    let cancelled = false;
    const circle = populationOffline(props.popCodes, { center: zone.center, radiusM: zone.isolationM });
    const plume =
      zone.downwindM > 0 && zone.towardDeg != null
        ? populationOffline(props.popCodes, {
            center: zone.center,
            radiusM: zone.downwindM,
            towardDeg: zone.towardDeg,
            halfAngleDeg: PLUME_HALF_ANGLE,
          })
        : Promise.resolve(null);
    void Promise.all([circle, plume])
      .then(([c, p]) => {
        if (cancelled) return;
        if (!c) {
          setPopMissing(true);
          return;
        }
        setPeople({ circle: c, plume: p });
      })
      .catch(() => !cancelled && setPopMissing(true));
    return () => {
      cancelled = true;
    };
  }, [zone, props.popCodes]);

  return (
    <Sheet
      title="Gefahrgut"
      meta={hit ? `UN ${hit.material.id}` : 'Tafel eintippen'}
      onClose={() => {
        props.onShowZone(null);
        props.onClose();
      }}
    >
      <div className="hz-sheet">
        <label className="hz-input">
          <span>Orangefarbene Tafel, UN-Nummer oder Name</span>
          <input
            type="text"
            inputMode="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="33/1203, 1017 oder Chlorine"
            aria-label="Gefahrnummer, UN-Nummer oder Stoffname"
          />
        </label>

        {ready === false && (
          <p className="muted">
            Das Nachschlagewerk konnte nicht geladen werden. Es liegt im Vorrat der App — nach einem
            vollständigen Laden mit Netz steht es auch offline bereit.
          </p>
        )}

        {kemler && (
          <div className="hz-kemler">
            <div className="sect-label">Gefahrnummer {kemler.number}</div>
            {kemler.noWater && <p className="hz-warn">X — darf nicht mit Wasser in Berührung kommen.</p>}
            <ul>
              {kemler.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="muted">
              Bedeutung der Ziffern nach ADR 5.3.2.3. Einzelne Kombinationen sind dort enger gefasst —
              maßgeblich ist das Beförderungspapier.
            </p>
          </div>
        )}

        {matches.length > 1 && (
          <ul className="hz-matches">
            {matches.map((m) => (
              <li key={m.material.id}>
                <button type="button" onClick={() => setQuery(String(m.material.id))}>
                  <b>UN {m.material.id}</b>
                  <span>{m.material.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {hit && (
          <>
            <div className="sect-label">UN {hit.material.id}</div>
            <div className="hz-name">
              <b>{hit.material.name}</b>
              {hit.material.also.length > 0 && <span className="muted"> · {hit.material.also.join(' · ')}</span>}
            </div>
            <div className="hz-guide">
              Leitfaden {hit.material.guide}
              {hit.guideTitle ? ` — ${hit.guideTitle}` : ''}
              {hit.material.guide.endsWith('P') && ' · P: kann polymerisieren'}
            </div>

            {distances ? (
              <>
                <div className="sect-label">Ersteinsatz-Abstände</div>
                <div className="hz-choice" role="group" aria-label="Menge">
                  <button type="button" aria-pressed={!large} onClick={() => setLarge(false)}>
                    kleine Menge
                  </button>
                  <button
                    type="button"
                    aria-pressed={large}
                    onClick={() => setLarge(true)}
                    disabled={distances.largeIsolationM == null}
                  >
                    große Menge
                  </button>
                  <span className="hz-when">{night ? 'Nachtwerte' : 'Tageswerte'}</span>
                </div>

                {isolationM == null ? (
                  <p className="muted">
                    Für die große Menge verweist die Tabelle auf die Tankgrößen-Tabelle des Handbuchs —
                    der Abstand hängt dort von Behältergröße und Wetter ab.
                  </p>
                ) : (
                  <div className="hz-numbers">
                    <div>
                      <b>{isolationM} m</b>
                      <span>sofort absperren, in alle Richtungen</span>
                    </div>
                    {downwindKm != null && (
                      <div>
                        <b>{fmtKm(downwindKm)}</b>
                        <span>
                          stromab schützen
                          {towardDeg != null
                            ? ` — Richtung ${Math.round(towardDeg)}° (${compassPoint(towardDeg)})`
                            : ' — Windrichtung unbekannt'}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="muted">
                Für diesen Stoff führt das Handbuch keine Abstandstabelle — sie gibt es nur für Stoffe,
                die beim Einatmen giftig sind. Absperrung nach Lage und Leitfaden.
              </p>
            )}

            {zone && (
              <>
                <div className="sect-label">Betroffene</div>
                {popMissing ? (
                  <p className="muted">
                    Für die Abschätzung fehlt das Einwohner-Paket dieser Region — unter „Offline" zu laden
                    (wenige hundert Kilobyte).
                  </p>
                ) : !people ? (
                  <p className="muted">wird gerechnet …</p>
                ) : (
                  <div className="hz-people">
                    <div>
                      <b>{fmtPeople(people.circle.people)}</b>
                      <span>im Absperrkreis ({isolationM} m)</span>
                    </div>
                    {people.plume && (
                      <div>
                        <b>{fmtPeople(people.plume.people)}</b>
                        <span>in der Fahne stromab</span>
                      </div>
                    )}
                    <p className="muted">
                      Einwohner am Wohnort (Zensus 2022), gerundet auf das 100-Meter-Gitter. Menschen bei
                      der Arbeit, in Schulen oder unterwegs stecken darin nicht.
                      {people.circle.covered === false && ' Teile liegen außerhalb des geladenen Rasters.'}
                    </p>
                  </div>
                )}
              </>
            )}

            <div className="tr-actions">
              <button type="button" className="btn-primary" onClick={() => props.onShowZone(zone)} disabled={!zone}>
                Auf die Karte
              </button>
              <button
                type="button"
                onClick={() => props.onEscape(isolationM ?? 1000)}
                disabled={isolationM == null}
              >
                Fluchtroute rechnen
              </button>
            </div>

            <p className="muted hz-note">
              Angaben aus dem Emergency Response Guidebook 2024 (US-Verkehrsministerium, gemeinfrei) für
              die **ersten Minuten**. Verbindlich sind Beförderungspapier, ERI-Karte und die
              Einsatzleitung. Angenommene Austrittsstelle: {props.atLabel}
              {props.windKmh != null && props.windFromDeg != null
                ? ` · Wind ${Math.round(props.windKmh)} km/h aus ${compassPoint(props.windFromDeg)}`
                : ' · keine Windangabe'}
              .
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
