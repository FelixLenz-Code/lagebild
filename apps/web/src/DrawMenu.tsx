import { useEffect, useRef } from 'react';

/**
 * Einzeichnen-Menü.
 *
 * Löst die frühere „Markieren"-Leiste ab: Werkzeuge, Datei einlesen und die
 * Verwaltung der eigenen Markierungen liegen jetzt an einer Stelle — mit Platz
 * für die Werkzeuge, die noch dazukommen.
 */

export type DrawTool = 'off' | 'point' | 'line' | 'area' | 'measure';

const TOOLS: { id: DrawTool; label: string; hint: string; icon: JSX.Element }[] = [
  {
    id: 'point',
    label: 'Punkt setzen',
    hint: 'Karte antippen',
    icon: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  },
  {
    id: 'line',
    label: 'Linie zeichnen',
    hint: 'Punkte antippen, dann „Fertig"',
    icon: <path d="M4 18c4 0 4-6 8-6s4 6 8 6" />,
  },
  {
    id: 'area',
    label: 'Fläche zeichnen',
    hint: 'Ecken antippen, dann „Fertig"',
    icon: <path d="M5 8l7-4 7 4v8l-7 4-7-4z" />,
  },
  {
    id: 'measure',
    label: 'Messen',
    hint: 'Strecke, ab drei Punkten auch Fläche',
    icon: <path d="M3 15 15 3l6 6L9 21z M7 13l2 2M10 10l2 2M13 7l2 2" />,
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: DrawTool;
  onTool: (tool: DrawTool) => void;
  /** Anzahl der gespeicherten Markierungen je Art. */
  counts: { point: number; area: number; line: number };
  onOpenList: () => void;
  onOpenImport: () => void;
  color: string;
}

export function DrawMenu(props: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const total = props.counts.point + props.counts.area + props.counts.line;

  // Klick daneben schließt das Menü — Escape nicht: es beendet zuerst das
  // laufende Werkzeug, sonst verlöre man eine halb gezeichnete Fläche.
  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) props.onOpenChange(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [props]);

  return (
    <div className="layermenu" ref={boxRef}>
      <button
        type="button"
        className="chip"
        aria-expanded={props.open}
        aria-haspopup="true"
        onClick={() => props.onOpenChange(!props.open)}
      >
        <span className="k" style={{ background: props.color }} />
        Einzeichnen
        {props.tool !== 'off' && <span className="lm-count">1</span>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="lm-caret">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {props.open && (
        <div className="lm-panel dm-panel" role="group" aria-label="Einzeichnen">
          <div className="lm-group">
            <div className="lm-group-title">Werkzeuge</div>
            {TOOLS.map((t) => (
              <div className="lm-row" key={t.id}>
                <button
                  type="button"
                  className="lm-item"
                  role="switch"
                  aria-checked={props.tool === t.id}
                  onClick={() => props.onTool(props.tool === t.id ? 'off' : t.id)}
                >
                  <span className="dm-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                      {t.icon}
                    </svg>
                  </span>
                  <span className="lm-label">
                    {t.label}
                    {props.tool === t.id && <span className="lm-hint">{t.hint}</span>}
                  </span>
                  <span className="lm-switch" aria-hidden="true">
                    <i />
                  </span>
                </button>
              </div>
            ))}

          </div>

          <div className="lm-group">
            <div className="lm-group-title">Datei</div>
            <div className="lm-row">
              <button type="button" className="lm-item" onClick={props.onOpenImport}>
                <span className="dm-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M8 8l4-4 4 4M4 20h16" />
                  </svg>
                </span>
                <span className="lm-label">
                  Tour oder Punkte einlesen
                  <span className="lm-hint">GPX, KML, KMZ, GeoJSON</span>
                </span>
              </button>
            </div>
          </div>

          <div className="lm-group">
            <div className="lm-group-title">Meine Markierungen</div>
            <div className="lm-row">
              <button type="button" className="lm-item" onClick={props.onOpenList} disabled={total === 0}>
                <span className="dm-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
                  </svg>
                </span>
                <span className="lm-label">
                  Liste öffnen
                  <span className="lm-hint">
                    {total === 0
                      ? 'noch nichts eingezeichnet'
                      : [
                          props.counts.point && `${props.counts.point} Punkte`,
                          props.counts.line && `${props.counts.line} Linien`,
                          props.counts.area && `${props.counts.area} Flächen`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
