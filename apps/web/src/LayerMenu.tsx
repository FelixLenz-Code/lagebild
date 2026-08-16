import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface LayerOption {
  id: string;
  label: string;
  /** Farbtupfer, damit die Ebene auf der Karte wiedererkennbar ist. */
  color: string;
  group: string;
  hint?: string;
  active: boolean;
  /** Eingerückte Unteroption, die zu der Ebene darüber gehört. */
  sub?: boolean;
  /** Zusätzlicher Knopf in der Zeile (z. B. „Rufzeichen verwalten"). */
  onEdit?: () => void;
  editLabel?: string;
}

/**
 * Ausklappbares Ebenen-Menü. Ersetzt die früher nebeneinander liegenden Chips —
 * mit inzwischen neun Ebenen wurde die Leiste auf kleinen Karten zu breit.
 *
 * Inzwischen sind es über dreißig, und eine durchgehende Liste war nicht mehr
 * zu überblicken. Deshalb ist jede Kategorie zugeklappt; man öffnet die, in der
 * man etwas sucht. Damit man dabei nicht vergisst, was anderswo noch läuft,
 * trägt jede zugeklappte Überschrift die Zahl ihrer aktiven Ebenen.
 */
export function LayerMenu(props: {
  options: LayerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (id: string) => void;
  onAllOff: () => void;
  /** Fußnote, z. B. Quellenangaben. */
  footer?: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const activeCount = props.options.filter((o) => o.active).length;
  // Welche Kategorien offen sind. Leer = alle zu, so startet das Menü. Der
  // Zustand hängt an der Komponente, nicht am Panel: wer die Karte anfasst und
  // gleich noch eine Ebene braucht, findet seine Kategorie wieder offen vor.
  const [openGroups, setOpenGroups] = useState<string[]>([]);

  // Klick daneben oder Escape schließt das Menü.
  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) props.onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [props]);

  const groups = [...new Set(props.options.map((o) => o.group))];

  return (
    <div className="layermenu" ref={boxRef}>
      <button
        type="button"
        className="chip"
        aria-expanded={props.open}
        aria-haspopup="true"
        onClick={() => props.onOpenChange(!props.open)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="lm-icon">
          <path d="M12 3 3 8l9 5 9-5-9-5Z" />
          <path d="m3 13 9 5 9-5" />
        </svg>
        Ebenen
        {activeCount > 0 && <span className="lm-count">{activeCount}</span>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="lm-caret">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {props.open && (
        <div className="lm-panel" role="group" aria-label="Kartenebenen">
          {groups.map((group) => {
            const rows = props.options.filter((o) => o.group === group);
            const open = openGroups.includes(group);
            const onInGroup = rows.filter((o) => o.active).length;
            return (
            <div className={`lm-group${open ? ' is-open' : ''}`} key={group}>
              <button
                type="button"
                className="lm-group-title"
                aria-expanded={open}
                onClick={() =>
                  setOpenGroups((prev) =>
                    prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group],
                  )
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="lm-gcaret">
                  <path d="m9 6 6 6-6 6" />
                </svg>
                <span className="lm-gname">{group}</span>
                {onInGroup > 0 && (
                  <span className="lm-gcount" title={`${onInGroup} eingeschaltet`}>
                    {onInGroup}
                  </span>
                )}
                {/* Wie viel hier drin steckt, interessiert nur, solange man
                    es nicht sieht — und nur, wenn es mehr als eines ist. */}
                {!open && rows.length > 1 && (
                  <span className="lm-gtotal" title={`${rows.length} Ebenen`}>
                    {rows.length}
                  </span>
                )}
              </button>
              {open &&
                rows.map((o) => (
                  <div className={`lm-row${o.sub ? ' is-sub' : ''}`} key={o.id}>
                    <button
                      type="button"
                      className="lm-item"
                      role="switch"
                      aria-checked={o.active}
                      onClick={() => props.onToggle(o.id)}
                    >
                      <span className="k" style={{ background: o.color }} />
                      <span className="lm-label">
                        {o.label}
                        {o.hint && <span className="lm-hint">{o.hint}</span>}
                      </span>
                      <span className="lm-switch" aria-hidden="true">
                        <i />
                      </span>
                    </button>
                    {o.onEdit && (
                      <button
                        type="button"
                        className="lm-edit"
                        title={o.editLabel ?? 'Bearbeiten'}
                        aria-label={o.editLabel ?? 'Bearbeiten'}
                        onClick={o.onEdit}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 20h4L18 10l-4-4L4 16z" />
                          <path d="m13.5 6.5 4 4" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
            </div>
            );
          })}

          <div className="lm-foot">
            <button type="button" className="lm-alloff" onClick={props.onAllOff} disabled={activeCount === 0}>
              Alle aus
            </button>
            {props.footer}
          </div>
        </div>
      )}
    </div>
  );
}
