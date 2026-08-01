import { useEffect, useRef, type ReactNode } from 'react';

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
          {groups.map((group) => (
            <div className="lm-group" key={group}>
              <div className="lm-group-title">{group}</div>
              {props.options
                .filter((o) => o.group === group)
                .map((o) => (
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
          ))}

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
