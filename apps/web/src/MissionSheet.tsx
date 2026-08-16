import { useEffect, useMemo, useState } from 'react';
import type { Coords } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { downloadText } from './drawStore.js';
import { copyText } from './share.js';
import { formatDegMin } from './coords.js';
import {
  KIND_DE,
  deleteMission,
  endMission,
  loadMissions,
  logEvent,
  missionToGeoJson,
  missionToText,
  startMission,
  subscribeMissions,
  type LogKind,
  type Mission,
} from './missionLog.js';

/**
 * Das Logbuch als Blatt.
 *
 * Es hat zwei Gesichter: Läuft kein Einsatz, steht hier nur die Frage, ob einer
 * begonnen werden soll — und die Liste der abgeschlossenen zum Nachlesen.
 * Läuft einer, ist es ein Schreibblock mit Uhrzeit.
 */

interface Props {
  /** Aktueller Standort — wird bei „Standort festhalten" mitgeschrieben. */
  coords: Coords;
  onClose: () => void;
}

/** Kleines Zeichen je Art, damit die Liste ohne Lesen überflogen werden kann. */
const KIND_MARK: Record<LogKind, string> = {
  start: '▶',
  end: '■',
  note: '·',
  position: '⌖',
  route: '→',
  warning: '!',
  mark: '✎',
  track: '~',
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Dauer in Stunden und Minuten, wie man sie in einen Bericht schreibt. */
export function duration(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function MissionSheet(props: Props) {
  const [missions, setMissions] = useState<Mission[]>(() => loadMissions());
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Das Logbuch wird auch von außen beschrieben (Route gestartet, Warnung
  // eingegangen) — deshalb nicht nur beim Öffnen lesen.
  useEffect(() => subscribeMissions(() => setMissions(loadMissions())), []);

  const active = missions.find((m) => m.endedAt == null) ?? null;
  const past = useMemo(
    () => missions.filter((m) => m.endedAt != null).slice().reverse(),
    [missions],
  );
  const shown = open ? (missions.find((m) => m.id === open) ?? null) : active;

  const addNote = () => {
    if (!note.trim()) return;
    logEvent('note', note.trim());
    setNote('');
  };

  return (
    <Sheet
      title="Einsatz-Logbuch"
      meta={active ? `läuft seit ${duration(active.startedAt, null)}` : 'nichts wird aufgezeichnet'}
      onClose={props.onClose}
    >
      <div className="ml-sheet">
        {!active && (
          <>
            {/* Der wichtigste Satz des Blattes: Ohne laufenden Einsatz hält die
                App nichts fest. Das steht hier und nicht in den Einstellungen,
                weil man es genau in dem Moment lesen soll, in dem man es
                einschaltet. */}
            <p className="muted">
              Solange kein Einsatz läuft, schreibt die App nichts mit. Ein neuer Einsatz beginnt ein
              eigenes, leeres Logbuch; alles bleibt auf diesem Gerät.
            </p>
            <div className="ml-start">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startMission(name)}
                placeholder="Stichwort, z. B. „Hochwasser Ortsteil Süd“"
                aria-label="Bezeichnung des Einsatzes"
              />
              <button type="button" className="btn-primary" onClick={() => { startMission(name); setName(''); }}>
                Einsatz beginnen
              </button>
            </div>
          </>
        )}

        {active && (
          <>
            <div className="ml-active">
              <div>
                <b>{active.name}</b>
                <span className="muted">
                  seit {clock(active.startedAt)} Uhr · {active.entries.length} Einträge
                </span>
              </div>
              <button type="button" className="ml-end" onClick={() => endMission()}>
                Einsatz beenden
              </button>
            </div>

            <div className="ml-add">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
                placeholder="Was ist passiert?"
                aria-label="Neuer Eintrag"
              />
              <button type="button" onClick={addNote}>
                Eintrag
              </button>
              <button
                type="button"
                onClick={() => logEvent('position', 'Standort festgehalten', props.coords)}
                title={formatDegMin(props.coords)}
              >
                Standort
              </button>
            </div>
          </>
        )}

        {shown && (
          <>
            <div className="sect-label">
              {shown === active ? 'Verlauf' : shown.name}
              {shown !== active && (
                <button type="button" className="ml-back" onClick={() => setOpen(null)}>
                  zurück
                </button>
              )}
            </div>
            {shown.entries.length === 0 ? (
              <p className="muted">Noch nichts eingetragen.</p>
            ) : (
              <ul className="ml-list">
                {/* Neueste oben: Im Einsatz zählt, was gerade war. */}
                {shown.entries
                  .slice()
                  .reverse()
                  .map((e) => (
                    <li key={e.id} className={`ml-${e.kind}`}>
                      <span className="ml-time mono">{clock(e.at)}</span>
                      <span className="ml-mark" aria-hidden="true">
                        {KIND_MARK[e.kind]}
                      </span>
                      <span className="ml-text">
                        {e.text}
                        {e.lat != null && e.lon != null && (
                          <em className="mono"> {formatDegMin({ lat: e.lat, lon: e.lon })}</em>
                        )}
                      </span>
                      <span className="ml-kind">{KIND_DE[e.kind]}</span>
                    </li>
                  ))}
              </ul>
            )}

            <div className="tr-actions">
              <button
                type="button"
                onClick={async () => {
                  const text = missionToText(shown);
                  if (typeof navigator.share === 'function') {
                    try {
                      await navigator.share({ text });
                      return;
                    } catch {
                      // abgebrochen — dann bleibt die Zwischenablage
                    }
                  }
                  if (await copyText(text)) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                  }
                }}
              >
                {copied ? 'kopiert' : 'Als Text weitergeben'}
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    `${shown.name.replace(/[^\w\-]+/g, '_')}.geojson`,
                    missionToGeoJson(shown),
                    'application/geo+json',
                  )
                }
              >
                Orte als GeoJSON
              </button>
            </div>
          </>
        )}

        {past.length > 0 && (
          <>
            <div className="sect-label">Frühere Einsätze</div>
            <ul className="ml-past">
              {past.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => setOpen(m.id)}>
                    <b>{m.name}</b>
                    <span className="mono">
                      {new Date(m.startedAt).toLocaleDateString('de-DE')} ·{' '}
                      {duration(m.startedAt, m.endedAt)} · {m.entries.length} Einträge
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ml-del"
                    onClick={() => {
                      if (open === m.id) setOpen(null);
                      deleteMission(m.id);
                    }}
                    aria-label={`${m.name} löschen`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}
