import { Sheet } from './Sheet.js';
import {
  downloadText,
  drawToGeoJsonText,
  drawToGpx,
  fileNameOf,
  type DrawFeature,
} from './drawStore.js';
import { formatArea, formatLength, lineLength, ringArea } from './geo.js';
import { StylePicker } from './StylePicker.js';
import { useEffect, useState } from 'react';
import { populationOffline } from './offline/client.js';
import { colorOf } from './drawStyle.js';

interface Props {
  features: DrawFeature[];
  /** Regionen mit Einwohner-Paket — ohne sie bleibt die Schätzung aus. */
  popCodes: string[];
  onRename: (id: string, name: string) => void;
  /** Beschreibung setzen bzw. mit leerem Text wieder entfernen. */
  onNote: (id: string, note: string) => void;
  /** Farbe bzw. Symbol nachträglich ändern. */
  onStyle: (id: string, style: { color?: string; icon?: string }) => void;
  /** Eine einzelne Markierung aus- bzw. wieder einblenden. */
  onToggle: (id: string) => void;
  /** Alle auf einmal aus- bzw. einblenden. */
  onToggleAll: (hidden: boolean) => void;
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

/** Zeile, in der sich Farbe und Symbol nachträglich ändern lassen. */
function StyleRow({ feature, onStyle }: { feature: DrawFeature; onStyle: Props['onStyle'] }) {
  return (
    <StylePicker
      color={feature.color ?? 'teal'}
      onColor={(color) => onStyle(feature.id, { color })}
      {...(feature.kind === 'point'
        ? { icon: feature.icon ?? 'dot', onIcon: (icon: string) => onStyle(feature.id, { icon }) }
        : {})}
    />
  );
}

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

/**
 * Wie viele Menschen wohnen in dieser Fläche?
 *
 * Steht bewusst direkt an der Markierung: Wer einen Evakuierungsradius oder ein
 * überflutetes Gebiet einzeichnet, will die Zahl an genau dieser Stelle — nicht
 * in einem eigenen Werkzeug, in das er die Fläche noch einmal einträgt.
 */
function AreaPeople({ ring, codes }: { ring: [number, number][]; codes: string[] }) {
  const [people, setPeople] = useState<number | null>(null);
  const [state, setState] = useState<'laden' | 'fehlt' | 'da'>('laden');

  useEffect(() => {
    if (!codes.length) {
      setState('fehlt');
      return;
    }
    let cancelled = false;
    populationOffline(codes, { ring })
      .then((r) => {
        if (cancelled) return;
        if (!r) {
          setState('fehlt');
          return;
        }
        setPeople(r.people);
        setState('da');
      })
      .catch(() => !cancelled && setState('fehlt'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes.join(','), ring.length, ring[0]?.[0], ring[0]?.[1]]);

  if (state === 'fehlt') return null;
  return (
    <span className="dl-people">
      {state === 'laden' ? '… Einwohner' : `≈ ${(people ?? 0).toLocaleString('de-DE')} Einwohner`}
    </span>
  );
}

/**
 * Beschreibung bearbeiten — bewusst als Feld in der Liste und nicht als
 * `window.prompt` wie beim Namen: Eine Beschreibung ist oft mehrzeilig, und ein
 * Systemdialog kann das nicht.
 */
function NoteEditor(props: { value: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(props.value);
  return (
    <div className="dl-noteedit">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Was gilt hier?"
        aria-label="Beschreibung"
        rows={3}
        maxLength={600}
        autoFocus
      />
      <div className="dl-notebtns">
        <button type="button" className="btn-quiet" onClick={props.onCancel}>
          Abbrechen
        </button>
        <button type="button" className="rbtn" onClick={() => props.onSave(text.trim())}>
          Speichern
        </button>
      </div>
    </div>
  );
}

export function DrawList(props: Props) {
  const hiddenCount = props.features.filter((f) => f.hidden).length;
  /** Welche Markierung gerade ihre Beschreibung bearbeitet. */
  const [noting, setNoting] = useState<string | null>(null);
  return (
    <Sheet
      title="Meine Markierungen"
      meta={hiddenCount ? `${props.features.length} · ${hiddenCount} ausgeblendet` : `${props.features.length}`}
      onClose={props.onClose}
    >
      {props.features.length === 0 && <p className="muted">Noch nichts eingezeichnet.</p>}
      {props.features.length > 0 && (
        <>
          <p className="muted st-intro">
            Das Auge blendet eine Markierung aus, ohne sie zu löschen — sie bleibt gespeichert und
            in der Suche auffindbar. Die ganze Ebene schaltet das Menü „Ebenen".
          </p>
          <div className="dl-bulk">
            <button type="button" className="btn-quiet" onClick={() => props.onToggleAll(true)} disabled={hiddenCount === props.features.length}>
              Alle ausblenden
            </button>
            <button type="button" className="btn-quiet" onClick={() => props.onToggleAll(false)} disabled={hiddenCount === 0}>
              Alle einblenden
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() =>
                downloadText('markierungen.gpx', drawToGpx(props.features), 'application/gpx+xml')
              }
            >
              Alle als GPX
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() =>
                downloadText(
                  'markierungen.geojson',
                  drawToGeoJsonText(props.features),
                  'application/geo+json',
                )
              }
            >
              Alle als GeoJSON
            </button>
          </div>
          <p className="muted dl-note">
            GPX kennt keine Flächen — ein Gebiet wird darin zur geschlossenen Linie. Wer die Fläche
            als Fläche braucht, nimmt GeoJSON.
          </p>
          <div className="region-list">
            {props.features.map((f) => (
              <div className={`region dl-item${f.hidden ? ' is-hidden' : ''}`} key={f.id}>
                <span className="draw-kind" title={KIND_LABEL[f.kind]} style={{ color: colorOf(f.color) }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    {ICONS[f.kind]}
                  </svg>
                </span>
                <div className="rinfo">
                  <b>{f.name}</b>
                  <span className="rmeta">
                    {KIND_LABEL[f.kind]}
                    {measureOf(f) ? ` · ${measureOf(f)}` : ''}
                    {f.geometry.type === 'Polygon' && (f.geometry.coordinates[0]?.length ?? 0) > 2 && (
                      <>
                        {' · '}
                        <AreaPeople ring={f.geometry.coordinates[0]!} codes={props.popCodes} />
                      </>
                    )}
                  </span>
                </div>
                <div className="raction">
                  <button
                    className="rdel"
                    type="button"
                    aria-label={f.hidden ? `${f.name} einblenden` : `${f.name} ausblenden`}
                    title={f.hidden ? 'Wieder einblenden' : 'Auf der Karte ausblenden'}
                    aria-pressed={!f.hidden}
                    onClick={() => props.onToggle(f.id)}
                  >
                    {f.hidden ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18" /><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.5 8.1C3.9 9.7 2 12 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.8" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.6" /></svg>
                    )}
                  </button>
                  <button
                    className="rdel"
                    type="button"
                    aria-label="Auf der Karte zeigen"
                    title="Auf der Karte zeigen"
                    disabled={f.hidden}
                    onClick={() => props.onShow(f)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="7" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" /></svg>
                  </button>
                  <button
                    className="rdel"
                    type="button"
                    aria-label={`${f.name} als GPX ausgeben`}
                    title="Als GPX ausgeben"
                    onClick={() => downloadText(fileNameOf(f.name, 'gpx'), drawToGpx([f]), 'application/gpx+xml')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M8 11l4 4 4-4M4 19h16" /></svg>
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
                  <button
                    className={`rdel${f.note ? ' is-set' : ''}`}
                    type="button"
                    aria-label={f.note ? 'Beschreibung ändern' : 'Beschreibung hinzufügen'}
                    title={f.note ? 'Beschreibung ändern' : 'Beschreibung hinzufügen'}
                    onClick={() => setNoting(f.id)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M5 5h14M5 10h14M5 15h9" /></svg>
                  </button>
                  <button className="rdel" type="button" aria-label="Löschen" onClick={() => props.onDelete(f.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>
                  </button>
                </div>
                {noting === f.id ? (
                  <NoteEditor
                    value={f.note ?? ''}
                    onSave={(text) => {
                      props.onNote(f.id, text);
                      setNoting(null);
                    }}
                    onCancel={() => setNoting(null)}
                  />
                ) : (
                  f.note && <p className="dl-note">{f.note}</p>
                )}
                <StyleRow feature={f} onStyle={props.onStyle} />
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
