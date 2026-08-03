import { useEffect, useState } from 'react';
import type { Coords, GeoResult, RescuePoint } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { CoordinateList } from './LocationSheet.js';
import { poisOffline } from './offline/client.js';
import { distanceM } from './offline/graph.js';
import { formatLength } from './geo.js';
import { formatDegMin } from './coords.js';

/**
 * Notfallblatt.
 *
 * Gedacht für den Augenblick, in dem man den Notruf wählt: Nummern, die eigene
 * Position in der Schreibweise, die eine Leitstelle hören will, die fünf
 * Fragen — und die nächsten Anlaufstellen. Alles aus dem Gerät, ohne Netz;
 * gesucht wird im **Offline-Index** der Region.
 *
 * Bewusst nüchtern gehalten und druckbar: Wer es einmal ausdruckt, hat es auch
 * dann, wenn das Gerät leer ist.
 */

interface Props {
  coords: Coords;
  /** Region mit heruntergeladenem Suchindex (oder null). */
  offlineCode: string | null;
  /** Rettungspunkte aus der Karte, falls die Ebene schon geladen hat. */
  rescue: RescuePoint[];
  onRoute: (place: { name: string; lat: number; lon: number }) => void;
  onClose: () => void;
}

/** Nummern, die bundesweit gelten. */
const NUMBERS: { number: string; label: string; note: string }[] = [
  { number: '112', label: 'Feuerwehr und Rettungsdienst', note: 'europaweit, auch ohne Netz des eigenen Anbieters' },
  { number: '110', label: 'Polizei', note: '' },
  { number: '116117', label: 'Ärztlicher Bereitschaftsdienst', note: 'wenn es kein Notfall ist, die Praxis aber zu hat' },
  { number: '0800 1110111', label: 'Telefonseelsorge', note: 'rund um die Uhr, kostenfrei' },
];

/**
 * Giftinformationszentralen. Bewusst **als Liste der Städte**, nicht nach
 * Bundesland zugeordnet: Die Zuständigkeiten überschneiden sich, und eine
 * falsche Zuordnung wäre im Ernstfall schlimmer als eine Zeile mehr zum Lesen.
 * Im Zweifel führt die 112 weiter.
 */
const POISON = [
  ['Berlin', '030 19240'],
  ['Bonn', '0228 19240'],
  ['Erfurt', '0361 730730'],
  ['Freiburg', '0761 19240'],
  ['Göttingen', '0551 19240'],
  ['Homburg', '06841 19240'],
  ['Mainz', '06131 19240'],
  ['München', '089 19240'],
  ['Nürnberg', '0911 3982451'],
];

const FIVE_W = [
  ['Wo ist es passiert?', 'Ort, Straße, Hausnummer — oder die Koordinaten von unten.'],
  ['Was ist passiert?', 'Unfall, Feuer, Sturz, Brustschmerz …'],
  ['Wie viele Betroffene?', 'Zahl der Verletzten oder Erkrankten.'],
  ['Welche Verletzungen?', 'Bewusstsein? Atmung? Blutung?'],
  ['Warten auf Rückfragen!', 'Nicht auflegen — die Leitstelle beendet das Gespräch.'],
];

const CATEGORIES = ['hospital', 'pharmacy', 'doctor', 'police', 'fire_station'];
const CATEGORY_DE: Record<string, string> = {
  hospital: 'Klinik',
  pharmacy: 'Apotheke',
  doctor: 'Arzt',
  police: 'Polizei',
  fire_station: 'Feuerwehr',
};

export function EmergencySheet(props: Props) {
  const [near, setNear] = useState<(GeoResult & { distanceM: number })[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!props.offlineCode) return;
    let cancelled = false;
    setSearching(true);
    const box = {
      west: props.coords.lon - 0.12,
      south: props.coords.lat - 0.08,
      east: props.coords.lon + 0.12,
      north: props.coords.lat + 0.08,
    };
    poisOffline(props.offlineCode, CATEGORIES, box, 200)
      .then((list) => {
        if (cancelled) return;
        const withDistance = list
          .map((p) => ({
            ...p,
            distanceM: distanceM(props.coords.lat, props.coords.lon, p.lat, p.lon),
          }))
          .sort((a, b) => a.distanceM - b.distanceM);
        // Je Art der nächste — eine Liste mit acht Apotheken hilft niemandem.
        const seen = new Set<string>();
        setNear(
          withDistance.filter((p) => {
            if (seen.has(p.category ?? '')) return false;
            seen.add(p.category ?? '');
            return true;
          }),
        );
      })
      .catch(() => !cancelled && setNear([]))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [props.offlineCode, props.coords.lat, props.coords.lon]);

  const rescue = [...props.rescue]
    .map((r) => ({ ...r, away: distanceM(props.coords.lat, props.coords.lon, r.lat, r.lon) }))
    .sort((a, b) => a.away - b.away)
    .slice(0, 3);

  return (
    <Sheet title="Notfallblatt" meta="ohne Netz nutzbar" onClose={props.onClose}>
      <div className="em-sheet">
        <div className="em-numbers">
          {NUMBERS.map((n) => (
            <a key={n.number} className={`em-num${n.number === '112' ? ' is-first' : ''}`} href={`tel:${n.number.replace(/\s/g, '')}`}>
              <b>{n.number}</b>
              <span>{n.label}</span>
              {n.note && <em>{n.note}</em>}
            </a>
          ))}
        </div>

        <div className="sect-label">Was die Leitstelle hören will</div>
        <ol className="em-w">
          {FIVE_W.map(([q, a]) => (
            <li key={q}>
              <b>{q}</b>
              <span>{a}</span>
            </li>
          ))}
        </ol>

        <div className="sect-label">Mein Standort</div>
        <p className="em-say">
          Für die Leitstelle vorlesen: <b className="mono">{formatDegMin(props.coords)}</b>
        </p>
        <CoordinateList coords={props.coords} />

        {rescue.length > 0 && (
          <>
            <div className="sect-label">Nächste Rettungspunkte</div>
            <ul className="em-list">
              {rescue.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => props.onRoute({ name: r.ref ?? 'Rettungspunkt', lat: r.lat, lon: r.lon })}>
                    <b>{r.ref ?? 'Rettungspunkt'}</b>
                    <span className="mono">
                      {formatLength(r.away)} · {formatDegMin({ lat: r.lat, lon: r.lon })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="sect-label">Nächste Anlaufstellen</div>
        {!props.offlineCode ? (
          <p className="muted">
            Für diese Gegend ist kein Suchindex gespeichert — ohne ihn kann die App Kliniken und
            Apotheken nicht ohne Netz finden. Region unter „Offline" laden.
          </p>
        ) : near.length === 0 ? (
          <p className="muted">{searching ? 'wird gesucht …' : 'In der Nähe nichts gefunden.'}</p>
        ) : (
          <ul className="em-list">
            {near.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button type="button" onClick={() => props.onRoute({ name: p.name, lat: p.lat, lon: p.lon })}>
                  <b>
                    {CATEGORY_DE[p.category ?? ''] ?? p.category}: {p.name}
                  </b>
                  <span className="mono">
                    {formatLength(p.distanceM)}
                    {p.detail ? ` · ${p.detail}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="sect-label">Giftnotruf</div>
        <p className="muted em-note">
          Die Zuständigkeiten überschneiden sich — im Zweifel führt die 112 weiter.
        </p>
        <ul className="em-poison">
          {POISON.map(([city, number]) => (
            <li key={city}>
              <span>{city}</span>
              <a className="mono" href={`tel:${number!.replace(/\s/g, '')}`}>
                {number}
              </a>
            </li>
          ))}
        </ul>

        <button type="button" className="btn-quiet em-print" onClick={() => window.print()}>
          Blatt drucken
        </button>
      </div>
    </Sheet>
  );
}
