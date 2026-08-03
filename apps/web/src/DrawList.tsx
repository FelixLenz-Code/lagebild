import { Sheet } from './Sheet.js';
import type { DrawFeature } from './drawStore.js';
import { formatArea, formatLength, lineLength, ringArea } from './geo.js';

interface Props {
  features: DrawFeature[];
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  /** Auf die Markierung schwenken. */
  onShow: (feature: DrawFeature) => void;
  onClose: () => void;
}

const KIND_LABEL: Record<DrawFeature['kind'], string> = {
  point: 'Punkt',
  line: 'Linie',
  area: 'Fläche',
};

const ICONS: Record<DrawFeature['kind'], JSX.Element> = {
  point: (
    <>
      <path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11Z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  line: <path d="M4 18c4 0 4-6 8-6s4 6 8 6" />,
  area: <path d="M5 8l4-3 6 3 4-2v11l-4 2-6-3-4 3z" />,
};

/** Maß der Markierung im Klartext — Länge bei Linien, Fläche bei Flächen. */
function measureOf(f: DrawFeature): string | null {
  if (f.geometry.type === 'LineString') {
    return `${formatLength(lineLength(f.geometry.coordinates))} lang`;
  }
  if (f.geometry.type === 'Polygon') {
    const ring = f.geometry.coordinates[0] ?? [];
    const around = lineLength(ring);
    return `${formatArea(ringArea(ring))} · Umfang ${formatLength(around)}`;
  }
  return null;
}

export function DrawList(props: Props) {
  return (
    <Sheet title="Meine Markierungen" meta={`${props.features.length}`} onClose={props.onClose}>
      {props.features.length === 0 && <p className="muted">Noch nichts eingezeichnet.</p>}
      {props.features.length > 0 && (
        <>
          <div className="region-list">
            {props.features.map((f) => (
              <div className="region" key={f.id}>
                <span className="draw-kind" title={KIND_LABEL[f.kind]}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    {ICONS[f.kind]}
                  </svg>
                </span>
                <div className="rinfo">
                  <b>{f.name}</b>
                  <span className="rmeta">
                    {KIND_LABEL[f.kind]}
                    {measureOf(f) ? ` · ${measureOf(f)}` : ''}
                  </span>
                </div>
                <div className="raction">
                  <button
                    className="rdel"
                    type="button"
                    aria-label="Auf der Karte zeigen"
                    title="Auf der Karte zeigen"
                    onClick={() => props.onShow(f)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="2.6" /></svg>
                  </button>
                  <button
                    className="rdel"
                    type="button"
                    aria-label="Umbenennen"
                    onClick={() => {
                      const name = window.prompt('Name', f.name);
                      if (name != null && name.trim()) props.onRename(f.id, name.trim());
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L18 10l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
                  </button>
                  <button className="rdel" type="button" aria-label="Löschen" onClick={() => props.onDelete(f.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button className="rbtn" type="button" style={{ marginTop: 12, background: 'var(--sev3)', borderColor: 'var(--sev3)' }} onClick={props.onClear}>
            Alle löschen
          </button>
        </>
      )}
    </Sheet>
  );
}
