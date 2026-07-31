import { useState } from 'react';
import type { AprsStation } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { relativeTime } from './format.js';
import { normalizeCall, MAX_TARGETS } from './aprsStore.js';

/**
 * Verwaltung der beobachteten APRS-Rufzeichen. Die aprs.fi-API fragt gezielt
 * einzelne Stationen ab, deshalb pflegt der Nutzer hier seine Liste.
 */
export function AprsTargets(props: {
  targets: string[];
  stations: AprsStation[];
  onChange: (targets: string[]) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byName = new Map(props.stations.map((s) => [s.name.toUpperCase(), s]));

  const add = () => {
    const call = normalizeCall(input);
    if (!call) {
      setError('Bitte ein gültiges Rufzeichen eingeben, z. B. DL1ABC-9.');
      return;
    }
    if (props.targets.includes(call)) {
      setError(`${call} steht schon auf der Liste.`);
      return;
    }
    if (props.targets.length >= MAX_TARGETS) {
      setError(`Mehr als ${MAX_TARGETS} Rufzeichen erlaubt aprs.fi nicht pro Abfrage.`);
      return;
    }
    props.onChange([...props.targets, call]);
    setInput('');
    setError(null);
  };

  return (
    <Sheet
      title="APRS-Rufzeichen"
      meta={`${props.targets.length} von ${MAX_TARGETS} · Daten von aprs.fi`}
      onClose={props.onClose}
    >
      <form
        className="pp-search"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18M5 8a10 10 0 0 1 14 0M8 11a6 6 0 0 1 8 0" />
        </svg>
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          placeholder="Rufzeichen, z. B. DL1ABC-9"
          aria-label="Rufzeichen hinzufügen"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button type="submit" className="rbtn">
          Hinzufügen
        </button>
      </form>
      {error && <p className="err" style={{ marginBottom: 10 }}>{error}</p>}

      {props.targets.length === 0 ? (
        <p className="muted">
          Noch keine Rufzeichen. aprs.fi beantwortet nur gezielte Abfragen — trag ein, wen du im
          Blick behalten willst (eigene Station, Fahrzeuge, Digipeater, Wetterstationen).
        </p>
      ) : (
        <div className="region-list">
          {props.targets.map((call) => {
            const station = byName.get(call);
            return (
              <div className="region" key={call}>
                <div className="rinfo">
                  <b>{call}</b>
                  <span className="rmeta">
                    {station
                      ? `zuletzt gehört ${relativeTime(station.lastHeard)}${station.comment ? ` · ${station.comment}` : ''}`
                      : 'noch keine Position abgerufen'}
                  </span>
                </div>
                <div className="raction">
                  <a
                    className="rdel"
                    href={`https://aprs.fi/#!call=a%2F${encodeURIComponent(call)}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${call} auf aprs.fi öffnen`}
                    title="Auf aprs.fi ansehen"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                    </svg>
                  </a>
                  <button
                    className="rdel"
                    type="button"
                    aria-label={`${call} entfernen`}
                    onClick={() => props.onChange(props.targets.filter((t) => t !== call))}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="muted" style={{ marginTop: 14, fontSize: '.76rem' }}>
        Positionen und Wetterwerte stammen von{' '}
        <a href="https://aprs.fi/" target="_blank" rel="noreferrer">
          aprs.fi
        </a>{' '}
        und werden nur abgerufen, solange die Ebene eingeschaltet ist.
      </p>
    </Sheet>
  );
}
