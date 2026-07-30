import { useEffect, type ReactNode } from 'react';

/** Wiederverwendbare Detail-Ansicht: Bottom-Sheet (mobil) bzw. zentrierter
 *  Dialog (Desktop). Schließt per Klick auf den Hintergrund oder Escape. */
export function Sheet(props: { title: string; meta?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [props]);

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="grip" />
        <div className="sheet-head">
          <div>
            <h2>{props.title}</h2>
            {props.meta && <div className="sub">{props.meta}</div>}
          </div>
          <button className="iconbtn close" type="button" onClick={props.onClose} aria-label="Schließen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
