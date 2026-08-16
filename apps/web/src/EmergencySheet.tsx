import { useEffect, useState } from 'react';
import type { Coords, GeoResult, RescuePoint } from '@lagebild/shared';
import { Sheet } from './Sheet.js';
import { CoordinateList } from './LocationSheet.js';
import { poisOffline, travelTimesOffline } from './offline/client.js';
import { distanceM } from './offline/graph.js';
import { formatLength } from './geo.js';
import { formatDecimal, formatDegMin } from './coords.js';
import { copyText } from './share.js';

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
  /** Regionen mit Routing-Paket am Standort — für die Fahrzeit statt Luftlinie. */
  routeCodes: string[];
  /** Rettungspunkte aus der Karte, falls die Ebene schon geladen hat. */
  rescue: RescuePoint[];
  onRoute: (place: { name: string; lat: number; lon: number }) => void;
  /** Fluchtrouting vom eigenen Standort weg. */
  onEscape: () => void;
  onClose: () => void;
}

/**
 * Der Text, der das Gerät verlässt.
 *
 * Aufgebaut für den Menschen am anderen Ende, nicht für eine Maschine: erst
 * was los ist, dann wo — in der Schreibweise, die eine Leitstelle hören will,
 * **und** in Dezimalgrad zum Weiterreichen. Der Kartenlink führt zu
 * OpenStreetMap statt in diese App: Wer die Nachricht bekommt, hat sie in aller
 * Regel nicht, und ein Link, den niemand öffnen kann, hilft im Notfall nicht.
 */
export function emergencyText(coords: Coords, note: string): string {
  const zeit = new Date().toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const karte = `https://www.openstreetmap.org/?mlat=${coords.lat.toFixed(5)}&mlon=${coords.lon.toFixed(
    5,
  )}#map=16/${coords.lat.toFixed(5)}/${coords.lon.toFixed(5)}`;
  return [
    'NOTFALL — ich brauche Hilfe.',
    note.trim() ? note.trim() : null,
    '',
    `Mein Standort (${zeit}):`,
    formatDegMin(coords),
    formatDecimal(coords),
    karte,
    '',
    'Wenn ich nicht mehr antworte: 112 rufen und diesen Standort durchgeben.',
  ]
    .filter((line) => line !== null)
    .join('\n');
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
  /** Eine freiwillige Zeile: was los ist. Steht ganz oben in der Nachricht. */
  const [note, setNote] = useState('');
  const [sent, setSent] = useState<'kopiert' | 'gesendet' | null>(null);
  const [near, setNear] = useState<(GeoResult & { distanceM: number })[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * Fahrzeit zu den gefundenen Anlaufstellen, in derselben Reihenfolge.
   *
   * Die Luftlinie täuscht an genau den Stellen, an denen es darauf ankommt: am
   * Fluss ohne Brücke, an der Autobahn ohne Auffahrt, im Tal hinter dem Berg.
   * Die Fahrzeit kommt aus **einer** Suche im Offline-Netz, nicht aus einer
   * Route je Ziel. Ohne Routing-Paket bleibt sie leer — dann steht weiter die
   * Entfernung da, und die Zeile sagt, warum.
   */
  const [driveS, setDriveS] = useState<(number | null)[] | null>(null);

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

  const nearKey = near.map((p) => `${p.lat},${p.lon}`).join('|');
  const routeKey = props.routeCodes.join(',');
  useEffect(() => {
    setDriveS(null);
    if (!near.length || !props.routeCodes.length) return;
    let cancelled = false;
    // 30 Minuten Budget: Was weiter weg ist, ist für das Notfallblatt ohnehin
    // nicht mehr „die nächste Anlaufstelle".
    travelTimesOffline(
      props.routeCodes,
      props.coords,
      near.map((p) => ({ lat: p.lat, lon: p.lon })),
      'car',
      1800,
    )
      .then((list) => !cancelled && setDriveS(list))
      .catch(() => !cancelled && setDriveS(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearKey, routeKey, props.coords.lat, props.coords.lon]);

  const rescue = [...props.rescue]
    .map((r) => ({ ...r, away: distanceM(props.coords.lat, props.coords.lon, r.lat, r.lon) }))
    .sort((a, b) => a.away - b.away)
    .slice(0, 3);

  const message = emergencyText(props.coords, note);

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

        {/* Nach dem Anruf kommt die zweite Nachricht: die an die eigenen
            Leute. Sie geht über die Teilen-Funktion des Geräts, damit sie in
            WhatsApp, Signal oder als SMS landet — die App selbst verschickt
            nichts und kennt keine Empfänger. */}
        <div className="sect-label">Standort an jemanden senden</div>
        <textarea
          className="em-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Was ist los? (freiwillig, eine Zeile)"
          rows={2}
          aria-label="Kurze Beschreibung für die Nachricht"
        />
        <pre className="em-preview">{message}</pre>
        <div className="tr-actions">
          <button
            type="button"
            className="btn-primary em-send"
            onClick={async () => {
              setSent(null);
              if (typeof navigator.share === 'function') {
                try {
                  await navigator.share({ text: message });
                  setSent('gesendet');
                  return;
                } catch {
                  // Abgebrochen oder nicht erlaubt — dann bleibt die Zwischenablage.
                }
              }
              if (await copyText(message)) setSent('kopiert');
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M8 10.5l8-4M8 13.5l8 4" />
            </svg>
            {typeof navigator.share === 'function' ? 'Standort senden' : 'Text kopieren'}
          </button>
          {sent && (
            <span className="em-sent">
              {sent === 'gesendet' ? 'weitergegeben' : 'in der Zwischenablage — jetzt einfügen'}
            </span>
          )}
        </div>

        {/* Zwei Handlungen stehen im Ernstfall an: rufen — und wegkommen.
            Deshalb direkt unter den Nummern und nicht am Fuß des Blatts. */}
        <button type="button" className="btn-primary em-escape" onClick={props.onEscape}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 3v7h6l-8 11v-7H5z" />
          </svg>
          Weg von hier — Fluchtweg rechnen
        </button>

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
            {near.map((p, i) => {
              const seconds = driveS?.[i] ?? null;
              return (
                <li key={`${p.lat},${p.lon}`}>
                  <button type="button" onClick={() => props.onRoute({ name: p.name, lat: p.lat, lon: p.lon })}>
                    <b>
                      {CATEGORY_DE[p.category ?? ''] ?? p.category}: {p.name}
                    </b>
                    <span className="mono">
                      {seconds != null ? `${Math.max(1, Math.round(seconds / 60))} min Fahrt · ` : ''}
                      {formatLength(p.distanceM)}
                      {p.detail ? ` · ${p.detail}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {near.length > 0 && !props.routeCodes.length && (
          <p className="muted">
            Angegeben ist die Luftlinie — für die Fahrzeit fehlt das Routing-Paket dieser Region.
          </p>
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
