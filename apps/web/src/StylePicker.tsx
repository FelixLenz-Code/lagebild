import { DRAW_COLORS, DRAW_ICONS, colorOf } from './drawStyle.js';

/**
 * Auswahl von Farbe und Symbol für eine eigene Markierung.
 *
 * Zwei Reihen zum Antippen statt eines Farbwählers: Auf der Karte müssen sich
 * die Markierungen **untereinander** unterscheiden, nicht fein abgestuft sein —
 * und im Freien mit klammen Fingern trifft man Kacheln, keine Farbverläufe.
 */
export function StylePicker(props: {
  color: string;
  onColor: (key: string) => void;
  /** Symbole nur bei Punkten — eine Linie trägt keines. */
  icon?: string;
  onIcon?: (key: string) => void;
}) {
  return (
    <div className="sp">
      <div className="sp-row" role="radiogroup" aria-label="Farbe">
        {DRAW_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={props.color === c.key}
            aria-label={c.label}
            title={c.label}
            className={`sp-color${props.color === c.key ? ' is-on' : ''}`}
            style={{ background: c.hex }}
            onClick={() => props.onColor(c.key)}
          />
        ))}
      </div>

      {props.onIcon && (
        <div className="sp-row sp-icons" role="radiogroup" aria-label="Symbol">
          {DRAW_ICONS.map((i) => (
            <button
              key={i.key}
              type="button"
              role="radio"
              aria-checked={props.icon === i.key}
              aria-label={i.label}
              title={i.label}
              className={`sp-icon${props.icon === i.key ? ' is-on' : ''}`}
              onClick={() => props.onIcon!(i.key)}
            >
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="16" r="13" fill={colorOf(props.color)} />
                <path d={i.path} fill="#ffffff" fillRule="evenodd" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
