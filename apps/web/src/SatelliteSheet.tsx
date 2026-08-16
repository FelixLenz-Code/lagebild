/**
 * Satellitenüberflüge: wann kommt was über den Horizont, von wo nach wo.
 *
 * Das Paket mit den Bahnelementen wird **eigens geladen** — es ist die einzige
 * Zutat, und danach rechnet die App ohne Netz weiter. Für Funkamateure (Relais
 * im Orbit, NOAA-APT auf 137 MHz), für alle anderen die Frage, was da abends
 * gleichmäßig über den Himmel zieht.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import {
  SAT_GROUPS,
  deleteSatSet,
  downloadSatSet,
  nextPasses,
  satrecOf,
  type Pass,
  type StoredSatSet,
} from './satStore.js';
import { compassPoint } from './compass.js';
import { relativeTime } from './format.js';

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86400000).toDateString() === d.toDateString();
  return same ? 'heute' : tomorrow ? 'morgen' : d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
};

const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;

/** Wie gut ist der Überflug? Unter 20° hilft jeder Baum dem Gegner. */
function quality(deg: number): { label: string; color: string } {
  if (deg >= 60) return { label: 'sehr hoch', color: 'var(--ok)' };
  if (deg >= 30) return { label: 'gut', color: 'var(--ok)' };
  if (deg >= 15) return { label: 'flach', color: 'var(--sev1)' };
  return { label: 'sehr flach', color: 'var(--muted)' };
}

interface Props {
  coords: Coords;
  /** Das geladene Paket — der Rahmen hält es, weil auch die Karte es braucht. */
  stored: StoredSatSet | null;
  onStored: (set: StoredSatSet | null) => void;
  /** Welche Satelliten auf der Karte liegen. */
  selected: string[];
  onSelected: (ids: string[]) => void;
  onClose: () => void;
}

export function SatelliteSheet({ coords, stored, onStored, selected, onSelected, onClose }: Props) {
  const [groups, setGroups] = useState<string[]>(stored?.groups ?? ['stations', 'weather', 'amateur']);
  /** Filter der Auswahlliste. */
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [hours, setHours] = useState(24);
  const [minEl, setMinEl] = useState(10);

  const compute = useCallback(
    async (set: StoredSatSet) => {
      setBusy('Überflüge werden gerechnet …');
      setPasses(null);
      try {
        const list = await nextPasses(
          set.set,
          { lat: coords.lat, lon: coords.lon },
          { hours, minElevationDeg: minEl, limit: 60 },
          (done, total) => setBusy(`Überflüge werden gerechnet … ${done}/${total}`),
        );
        setPasses(list);
      } catch {
        setError('Die Rechnung ist fehlgeschlagen.');
      } finally {
        setBusy(null);
      }
    },
    [coords.lat, coords.lon, hours, minEl],
  );

  // Sobald ein Paket da ist, wird gerechnet — auch nach jeder Änderung an
  // Fenster oder Mindesthöhe.
  useEffect(() => {
    if (stored) void compute(stored);
  }, [stored, compute]);

  const download = async () => {
    setBusy('Bahndaten werden geladen …');
    setError(null);
    try {
      const s = await downloadSatSet(groups.length ? groups : ['stations']);
      onStored(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Das Laden ist fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  const ageDays = stored ? (Date.now() - new Date(stored.set.updatedAt).getTime()) / 86400000 : 0;

  return (
    <Sheet
      title="Satellitenüberflüge"
      meta={`für ${coords.lat.toFixed(3)}°, ${coords.lon.toFixed(3)}° · gerechnet auf dem Gerät`}
      onClose={onClose}
    >
      <div className="sect-label">Bahndaten (eigenes Paket)</div>
      <div className="sat-groups">
        {SAT_GROUPS.map((g) => (
          <label key={g.id} className={`sat-group${groups.includes(g.id) ? ' is-on' : ''}`}>
            <input
              type="checkbox"
              checked={groups.includes(g.id)}
              onChange={() =>
                setGroups((prev) => (prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]))
              }
            />
            <span>
              <b>{g.label}</b>
              <span className="sat-hint">{g.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="sat-store">
        {!stored && (
          <p className="rp-hint">
            Noch kein Paket im Gerät. Der Download ist klein und gilt Tage — danach rechnet die Vorhersage
            ohne Netz.
          </p>
        )}
        {stored && (
          <p className="sat-state">
            <b>{stored.set.satellites.length} Satelliten</b> · {kb(stored.bytes)} · Stand{' '}
            {relativeTime(stored.set.updatedAt)}
            {ageDays > 5 && <span className="sat-old"> — älter als fünf Tage, die Zeiten wandern</span>}
          </p>
        )}
        <div className="tr-actions">
          {/* Solange nichts da ist, ist das Laden **die** Handlung des Blatts.
              Danach ist das Erneuern eine Nebensache und darf nicht mehr der
              größte Knopf sein. */}
          <button
            type="button"
            className={stored ? 'btn-quiet' : 'btn-primary'}
            onClick={download}
            disabled={busy != null}
          >
            {stored ? 'Bahndaten erneuern' : 'Bahndaten laden'}
          </button>
          {stored && (
            <button
              type="button"
              className="btn-quiet sat-delete"
              onClick={async () => {
                await deleteSatSet();
                onStored(null);
                onSelected([]);
                setPasses(null);
              }}
            >
              Paket löschen
            </button>
          )}
        </div>
      </div>

      {error && <p className="rp-hint err">{error}</p>}
      {busy && <p className="muted">{busy}</p>}

      {stored && (
        <>
          {/* Was auf der Karte liegt. Bewusst eine Auswahl und nicht alles:
              dreihundert Punkte und dreihundert Bahnen wären kein Lagebild,
              sondern ein Knäuel. */}
          <div className="sect-label" style={{ marginTop: 18 }}>
            Auf der Karte ({selected.length} von {stored.set.satellites.length})
          </div>
          <div className="sat-pick-head">
            <input
              type="text"
              className="sat-search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Namen suchen (ISS, NOAA …)"
              aria-label="Satelliten filtern"
            />
            {selected.length > 0 && (
              <button type="button" className="btn-quiet" onClick={() => onSelected([])}>
                Keinen
              </button>
            )}
          </div>
          <ul className="sat-pick">
            {stored.set.satellites
              .filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
              .slice(0, 60)
              .map((t) => {
                const sat = satrecOf(t);
                if (!sat) return null;
                const on = selected.includes(sat.id);
                return (
                  <li key={sat.id}>
                    <button
                      type="button"
                      className="lm-item"
                      role="switch"
                      aria-checked={on}
                      onClick={() =>
                        onSelected(on ? selected.filter((x) => x !== sat.id) : [...selected, sat.id])
                      }
                    >
                      <span className="lm-label">
                        {t.name}
                        <span className="lm-hint">
                          Umlauf {Math.round(sat.periodMin)} min
                          {t.group ? ` · ${SAT_GROUPS.find((g) => g.id === t.group)?.label ?? t.group}` : ''}
                        </span>
                      </span>
                      <span className="lm-switch" aria-hidden="true">
                        <i />
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
          {stored.set.satellites.filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
            .length > 60 && <p className="sat-note">Nur die ersten 60 — zum Eingrenzen den Namen tippen.</p>}

          <div className="sect-label" style={{ marginTop: 18 }}>
            Nächste Überflüge
          </div>
          <div className="sat-filters">
            <div className="sight-row">
              <span>Fenster</span>
              {[12, 24, 48].map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`rp-chip${hours === h ? ' is-on' : ''}`}
                  aria-pressed={hours === h}
                  onClick={() => setHours(h)}
                >
                  {h} h
                </button>
              ))}
            </div>
            <div className="sight-row">
              <span>ab</span>
              {[5, 10, 30].map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`rp-chip${minEl === e ? ' is-on' : ''}`}
                  aria-pressed={minEl === e}
                  onClick={() => setMinEl(e)}
                >
                  {e}° Höhe
                </button>
              ))}
            </div>
          </div>

          {passes && passes.length === 0 && !busy && (
            <p className="muted">Im gewählten Fenster steigt keiner hoch genug.</p>
          )}

          {passes && passes.length > 0 && (
            <ol className="sat-list">
              {passes.map((p, i) => {
                const q = quality(p.maxElevationDeg);
                const minutes = Math.round((p.endMs - p.startMs) / 60000);
                return (
                  <li key={`${p.id}-${p.startMs}-${i}`}>
                    <span className="sat-when">
                      <b>{clock(p.startMs)}</b>
                      <span>{dayLabel(p.startMs)}</span>
                    </span>
                    <span className="sat-body">
                      <b className="sat-name">{p.name}</b>
                      <span className="sat-meta">
                        {compassPoint(p.startAzimuthDeg)} → {compassPoint(p.peakAzimuthDeg)} →{' '}
                        {compassPoint(p.endAzimuthDeg)} · {minutes} min · {p.minRangeKm} km
                      </span>
                    </span>
                    <span className="sat-el" style={{ color: q.color }}>
                      <b>{Math.round(p.maxElevationDeg)}°</b>
                      <span>{q.label}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <p className="sat-note">
            Zeiten aus SGP4 auf dem Gerät. Ohne Sichtbarkeitsprüfung: Ob ein Überflug am Nachthimmel auch
            zu <em>sehen</em> ist, hängt daran, ob der Satellit im Erdschatten steht.
          </p>
        </>
      )}
    </Sheet>
  );
}
