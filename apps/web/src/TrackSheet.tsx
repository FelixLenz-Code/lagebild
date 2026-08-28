import { useEffect, useRef, useState } from 'react';
import type { Coords, TransitFind, TransitJourney } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { fetchFindVehicle, type Bbox } from './api.js';
import { departureTime, kindOfProduct, timeHM, timeUntil, trackLabel } from './format.js';

interface Props {
  coords: Coords;
  /** Sichtbarer Kartenausschnitt — bestimmt, wie weit lokal gesucht wird. */
  viewport: Bbox;
  online: boolean;
  /** Fahrt, die gerade verfolgt wird (null = Suchansicht). */
  journey: TransitJourney | null;
  tracking: string | null;
  loading: boolean;
  follow: boolean;
  onTrack: (tripId: string) => void;
  onStopTracking: () => void;
  onFollowChange: (follow: boolean) => void;
  /** Blatt schließen, Fahrt aber weiter auf der Karte verfolgen. */
  onShowOnMap: () => void;
  onRouteToStop: (stop: { name: string; lat: number; lon: number }) => void;
  onClose: () => void;
}

const distanceLabel = (m: number | null): string => {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
};

/**
 * Was die Suche versteht — mit je einem Beispiel zum Antippen.
 *
 * Bewusst in dieser Reihenfolge: von der knappsten Eingabe zur genauesten.
 * Die letzten beiden sind die wichtigen, weil sie das können, was die Karte
 * nicht kann — eine Fahrt finden, die noch gar nicht losgefahren ist.
 */
const SEARCH_FORMS: { example: string; hint: string }[] = [
  { example: '25', hint: 'Linie allein — alle Fahrzeuge dieser Linie im Umkreis der Karte.' },
  { example: 'RE 1', hint: 'Zuglinien werden in der Region gesucht, Fernzüge („ICE 611") bundesweit.' },
  { example: 'RS 1 nach Verden', hint: '„nach …" oder „Richtung …" grenzt auf eine Fahrtrichtung ein.' },
  { example: '6 ab Bremen Hbf', hint: '„ab …" fragt an einem Halt — dort stehen auch Fahrten, die noch nicht losgefahren sind.' },
  { example: 'Bremen Hbf', hint: 'Nur ein Halt: alles, was dort demnächst abfährt.' },
];

const STATE_DE: Record<TransitJourney['state'], string> = {
  planned: 'noch nicht abgefahren',
  running: 'unterwegs',
  done: 'angekommen',
};

/** Verspätung in Worten — „pünktlich" ist eine Aussage, „+0" ist keine. */
function delayText(delayMin: number | null, realTime: boolean): string {
  if (!realTime) return 'nur Sollfahrplan';
  if (delayMin == null) return 'keine Echtzeitmeldung';
  if (delayMin === 0) return 'pünktlich';
  return delayMin > 0 ? `${delayMin} min später` : `${Math.abs(delayMin)} min früher`;
}

/**
 * Eine bestimmte Fahrt suchen und verfolgen.
 *
 * Der Kern ist die Suche: Ein Fahrzeug lässt sich auf der Karte nur antippen,
 * wenn man weiß, wo es fährt — genau das weiß man aber nicht, wenn man auf den
 * Bus wartet. Deshalb wird hier nach der **Linie** gesucht, wahlweise mit
 * Richtung oder Halt:
 *
 *   „25"                  alle Linien 25 im Umkreis
 *   „RE 1 nach Bremen"    Regionalzüge dieser Linie in diese Richtung
 *   „6 ab Bremen Hbf"     auch Fahrten, die dort erst später abfahren
 *   „Bremen Hbf"          alles, was dort demnächst abfährt
 */
export function TrackSheet(props: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<TransitFind[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const runId = useRef(0);

  const term = q.trim();
  useEffect(() => {
    if (props.tracking) return;
    if (term.length < 1) {
      setHits(null);
      setError(null);
      return;
    }
    if (!props.online) {
      setHits(null);
      setError('Ohne Verbindung lässt sich keine Fahrt suchen — Fahrpläne und Echtzeit liegen nicht im Gerät.');
      return;
    }
    const id = ++runId.current;
    setSearching(true);
    setError(null);
    // Getippt wird buchstabenweise, gesucht erst, wenn die Eingabe steht.
    const timer = setTimeout(() => {
      fetchFindVehicle(term, props.coords, props.viewport)
        .then((r) => {
          if (id !== runId.current) return;
          setHits(r.data);
          if (!r.data.length) setError('Nichts gefunden. Fährt die Linie gerade? Ein Halt hilft: „25 ab Domsheide".');
        })
        .catch(() => id === runId.current && setError('Die Suche hat nicht geklappt.'))
        .finally(() => id === runId.current && setSearching(false));
    }, 420);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, props.online, props.tracking, props.coords.lat, props.coords.lon]);

  const live = hits?.filter((h) => h.via === 'live') ?? [];
  // Nach Halt gruppieren: „Bremen Hbf" trifft auch „Bremerhaven Hbf", und
  // beide unter einer Überschrift zu führen wäre schlicht falsch.
  const byStop = new Map<string, TransitFind[]>();
  for (const h of hits ?? []) {
    if (h.via !== 'stop') continue;
    const name = h.stopName ?? 'Halt';
    byStop.set(name, [...(byStop.get(name) ?? []), h]);
  }

  if (props.tracking) {
    return (
      <JourneyView
        {...props}
        onBack={() => {
          props.onStopTracking();
          setHits(null);
        }}
      />
    );
  }

  return (
    <Sheet
      title="Fahrt verfolgen"
      meta="Bus, Tram oder Zug suchen und live mitfahren"
      onClose={props.onClose}
    >
      <div className="pp-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={q}
          autoFocus
          placeholder={'Linie, z. B. „RE 1" oder „25 ab Domsheide"'}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Linie suchen"
        />
      </div>
      {/* Die Suchformen erklären sich nicht von selbst — und ein Beispiel
          erklärt sie schneller als ein Satz. Deshalb steht die Hilfe als
          Abzeichen neben dem Feld und die Beispiele sind antippbar: Ein Tipp
          setzt sie ins Feld, und man sieht sofort, was dabei herauskommt. */}
      <div className="tj-helprow">
        <button
          type="button"
          className={`tj-badge${helpOpen ? ' is-on' : ''}`}
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.6v.2" />
          </svg>
          Wonach kann ich suchen?
        </button>
      </div>

      {helpOpen && (
        <dl className="tj-help">
          {SEARCH_FORMS.map((f) => (
            <div key={f.example}>
              <dt>
                <button type="button" className="tj-example" onClick={() => setQ(f.example)}>
                  {f.example}
                </button>
              </dt>
              <dd>{f.hint}</dd>
            </div>
          ))}
        </dl>
      )}

      {searching && <p className="muted">Suche läuft …</p>}
      {!searching && error && <p className="muted">{error}</p>}

      {live.length > 0 && (
        <>
          <div className="sect-label">Jetzt unterwegs</div>
          <div className="pp-results">
            {live.map((h) => (
              <FindRow key={h.tripId} hit={h} onPick={() => props.onTrack(h.tripId)} />
            ))}
          </div>
        </>
      )}

      {[...byStop.entries()].map(([name, list]) => (
        <div key={name}>
          <div className="sect-label">Abfahrten ab {name}</div>
          <div className="pp-results">
            {list.map((h) => (
              <FindRow key={h.tripId} hit={h} onPick={() => props.onTrack(h.tripId)} />
            ))}
          </div>
        </div>
      ))}

      <p className="sr-hint" style={{ marginTop: 12 }}>
        Fahrplan und Echtzeit von{' '}
        <a href="https://transitous.org/" target="_blank" rel="noreferrer">transitous.org</a>.
      </p>
    </Sheet>
  );
}

/** Ein Treffer der Suche. */
function FindRow(props: { hit: TransitFind; onPick: () => void }) {
  const h = props.hit;
  const kind = kindOfProduct(h.product);
  const detail =
    h.via === 'live'
      ? [h.nextStop ? `nächster Halt ${h.nextStop}` : null, distanceLabel(h.distanceM)]
          .filter(Boolean)
          .join(' · ')
      : [
          `ab ${departureTime(h.when)}`,
          h.track ? `${trackLabel(h.product)} ${h.track}` : null,
          h.delayMin ? `+${h.delayMin}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="sr-row">
      <button type="button" className="sr-main" onClick={props.onPick}>
        <span className={`line-pill ${kind}`}>{h.line}</span>
        <span className="sr-text">
          <span className="sr-name">
            {h.towards ? `→ ${h.towards}` : h.product || 'Fahrt'}
          </span>
          <span className="sr-detail">
            {h.product}
            {h.cancelled && <span className="sr-tag alarm">fällt aus</span>}
            {detail ? ` · ${detail}` : ''}
            {!h.realTime && ' · ohne Echtzeit'}
          </span>
        </span>
      </button>
      <button type="button" className="sr-go" title="Diese Fahrt verfolgen" aria-label="Diese Fahrt verfolgen" onClick={props.onPick}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </button>
    </div>
  );
}

/** Die verfolgte Fahrt: Position, nächster Halt, Laufweg und alle Stammdaten. */
function JourneyView(props: Props & { onBack: () => void }) {
  const j = props.journey;

  if (!j) {
    return (
      <Sheet title="Fahrt verfolgen" onClose={props.onClose}>
        <p className="muted">
          {props.loading ? 'Fahrt wird geladen …' : 'Zu dieser Fahrt liegen keine Daten (mehr) vor.'}
        </p>
        <div className="rp-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn-quiet" onClick={props.onBack}>
            Andere Fahrt suchen
          </button>
        </div>
      </Sheet>
    );
  }

  const kind = kindOfProduct(j.product);
  const next = j.nextStopIndex != null ? j.stops[j.nextStopIndex] : null;
  const nextTime = next ? (next.arrival ?? next.when) : null;
  const durationMin =
    j.startTime && j.endTime
      ? Math.round((Date.parse(j.endTime) - Date.parse(j.startTime)) / 60000)
      : null;
  const duration =
    durationMin == null
      ? ''
      : durationMin < 60
        ? `${durationMin} min`
        : `${Math.floor(durationMin / 60)} h ${durationMin % 60} min`;
  const remaining = j.nextStopIndex != null ? j.stops.length - j.nextStopIndex : 0;

  return (
    <Sheet
      title={`${j.line}${j.towards ? ` → ${j.towards}` : ''}`}
      meta={`${j.product ?? 'Fahrt'} · ${STATE_DE[j.state]} · ${delayText(j.delayMin, j.realTime)}`}
      onClose={props.onClose}
    >
      {j.cancelled && <p className="err">Diese Fahrt fällt aus.</p>}

      {/* Das Wichtigste zuerst: wo die Fahrt gerade ist und wann sie wo ist. */}
      <div className="tj-now">
        <span className={`line-pill ${kind}`}>{j.line}</span>
        <div className="tj-next">
          {j.state === 'done' ? (
            <b>Fahrt beendet</b>
          ) : next ? (
            <>
              <b>
                {j.state === 'planned'
                  ? 'fährt ab '
                  : j.atStop
                    ? 'steht in '
                    : 'nächster Halt '}
                {next.name}
              </b>
              <span>
                {j.atStop || j.state === 'planned' ? 'ab ' : 'an '}
                {timeHM(j.atStop || j.state === 'planned' ? next.when : nextTime)}
                {next.delayMin ? ` (+${next.delayMin})` : ''}
                {' · in '}
                {timeUntil(j.atStop || j.state === 'planned' ? next.when : nextTime)}
                {next.track ? ` · ${trackLabel(j.product)} ${next.track}` : ''}
              </span>
            </>
          ) : (
            <b>Fahrt beginnt {departureTime(j.startTime)}</b>
          )}
        </div>
      </div>

      {/* Fortschritt der Fahrt — grob, aber sofort lesbar. */}
      <div className="tj-bar" role="img" aria-label={`Fahrt zu ${Math.round(j.progress * 100)} % zurückgelegt`}>
        <i style={{ width: `${Math.round(j.progress * 100)}%` }} />
      </div>
      <div className="tj-ends">
        <span>{j.origin}</span>
        <span>{j.destination}</span>
      </div>

      <div className="rp-actions" style={{ margin: '12px 0' }}>
        <button type="button" className="btn-primary" onClick={props.onShowOnMap}>
          Auf der Karte
        </button>
        <button
          type="button"
          className={`btn-quiet${props.follow ? ' is-on' : ''}`}
          aria-pressed={props.follow}
          onClick={() => props.onFollowChange(!props.follow)}
        >
          {props.follow ? 'Karte folgt' : 'Karte folgen lassen'}
        </button>
        <button type="button" className="btn-quiet" onClick={props.onBack}>
          Andere Fahrt
        </button>
      </div>

      <div className="sect-label">Fahrtdaten</div>
      <dl className="tj-data">
        <div>
          <dt>Linie</dt>
          <dd>{j.line}{j.product ? ` · ${j.product}` : ''}</dd>
        </div>
        <div>
          <dt>Von / nach</dt>
          <dd>{j.origin} → {j.destination}</dd>
        </div>
        <div>
          <dt>Planmäßig</dt>
          <dd>
            {departureTime(j.startTime)} – {timeHM(j.endTime)}
            {duration ? ` · ${duration}` : ''}
          </dd>
        </div>
        <div>
          <dt>Halte</dt>
          <dd>{j.stops.length}{remaining > 0 ? ` · noch ${remaining}` : ''}</dd>
        </div>
        {j.operator && (
          <div>
            <dt>Betreiber</dt>
            <dd>{j.operator}</dd>
          </div>
        )}
        {/* Nur gemeldete Zusagen anzeigen: „nein" steht in den Fahrplandaten
            auch dann, wenn schlicht nichts hinterlegt ist. */}
        {(j.bikes || j.wheelchair) && (
          <div>
            <dt>Ausstattung</dt>
            <dd>
              {[j.bikes ? 'Fahrradmitnahme' : null, j.wheelchair ? 'barrierefrei' : null]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </div>
        )}
        {j.position && (
          <div>
            <dt>Position</dt>
            <dd>
              {j.position.lat.toFixed(4)}, {j.position.lon.toFixed(4)} · Kurs {j.position.bearing}°
            </dd>
          </div>
        )}
        <div>
          <dt>Stand</dt>
          <dd>{timeHM(j.at)}{props.loading ? ' · wird aufgefrischt' : ''}</dd>
        </div>
      </dl>

      <div className="sect-label">Laufweg ({j.stops.length} Halte)</div>
      <ol className="trip-stops">
        {j.stops.map((s, i) => {
          const passed = j.nextStopIndex == null ? j.state === 'done' : i < j.nextStopIndex;
          const here = i === j.nextStopIndex;
          return (
            <li key={`${s.name}-${i}`} className={here ? 'is-here' : passed ? 'is-past' : ''}>
              <i />
              <button
                type="button"
                className="ts-name ts-link"
                onClick={() => props.onRouteToStop({ name: s.name, lat: s.lat, lon: s.lon })}
                title="Route zu diesem Halt"
              >
                {s.name}
              </button>
              {s.track && <span className="tp-track">{trackLabel(j.product)} {s.track}</span>}
              <span className={`ts-time${s.cancelled ? ' cancelled' : s.delayMin ? ' late' : ''}`}>
                {s.cancelled
                  ? 'entfällt'
                  : `${departureTime(s.when ?? s.arrival ?? null)}${s.delayMin ? ` +${s.delayMin}` : ''}`}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="sr-hint" style={{ marginTop: 12 }}>
        Die Marke ist <b>keine GPS-Ortung</b>: Die Position wird aus dem Fahrplan gerechnet — bei
        Fahrten mit Echtzeitmeldung samt gemeldeter Verspätung. Daten von{' '}
        <a href="https://transitous.org/" target="_blank" rel="noreferrer">transitous.org</a>.
      </p>
    </Sheet>
  );
}
