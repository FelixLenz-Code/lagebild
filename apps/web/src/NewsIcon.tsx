import { BLAULICHT_STYLE, NEWS_STYLE } from './mapIcons.js';

/**
 * Kategorie-Symbol einer Meldung — dieselben Piktogramme wie auf der Karte,
 * damit Liste und Karte zusammenpassen.
 */
export function NewsIcon({ category, size = 18 }: { category?: string | null; size?: number }) {
  const style = NEWS_STYLE[category ?? 'other'] ?? NEWS_STYLE.other!;
  return (
    <span
      className="news-ico"
      title={style.label}
      aria-label={style.label}
      style={{ background: style.color, width: size + 8, height: size + 8 }}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} fill="#fff" fillRule="evenodd" aria-hidden="true">
        <path d={style.path} />
      </svg>
    </span>
  );
}

/**
 * Dasselbe für die Blaulicht-Meldungen: Symbol des Herausgebers (Polizei,
 * Feuerwehr, THW, Zoll) — wieder identisch mit dem Kartensymbol.
 */
export function BlaulichtIcon({ kind, size = 18 }: { kind?: string | null; size?: number }) {
  const style = BLAULICHT_STYLE[kind ?? 'other'] ?? BLAULICHT_STYLE.other!;
  return (
    <span
      className="news-ico"
      title={style.label}
      aria-label={style.label}
      style={{ background: style.color, width: size + 8, height: size + 8 }}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} fill="#fff" fillRule="evenodd" aria-hidden="true">
        <path d={style.path} />
      </svg>
    </span>
  );
}
