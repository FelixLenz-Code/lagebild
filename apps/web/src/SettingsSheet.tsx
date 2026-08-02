import { useState } from 'react';
import { Sheet } from './Sheet.js';
import { ALWAYS_SHOWN, LAYER_CATALOG, type LayerRowId } from './layerCatalog.js';
import { PROJECTS, SOURCE_BY_KEY, SOURCE_GROUPS } from './sources.js';
import { REFRESH_CHOICES, type Settings } from './settings.js';

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  /** Welche Ebenen der Server überhaupt anbietet (Schlüssel vorhanden). */
  available: { flow: boolean; ais: boolean; aprs: boolean };
  onOpenRegions: () => void;
  onClose: () => void;
}

type Tab = 'ebenen' | 'app' | 'quellen';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ebenen', label: 'Ebenen' },
  { id: 'app', label: 'App' },
  { id: 'quellen', label: 'Quellen' },
];

/**
 * Einstellungen und Herkunft der Daten.
 *
 * Drei Abteilungen, damit das Blatt Platz für Weiteres behält: **Ebenen**
 * (was im Karten-Menü überhaupt erscheinen soll), **App** (Verhalten) und
 * **Quellen** (wessen Daten hier zu sehen sind, mit Rücklink — mehrere
 * Anbieter bitten ausdrücklich darum).
 */
export function SettingsSheet(props: Props) {
  const [tab, setTab] = useState<Tab>('ebenen');
  const { settings } = props;

  const set = (patch: Partial<Settings>) => props.onChange({ ...settings, ...patch });

  const hidden = new Set<LayerRowId>(settings.hiddenLayers);
  const toggleLayer = (id: LayerRowId) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ hiddenLayers: [...next] });
  };

  // Ebenen ohne Schlüssel stehen gar nicht erst zur Wahl.
  const usable = LAYER_CATALOG.filter(
    (l) => !ALWAYS_SHOWN.includes(l.id) && (!l.needs || props.available[l.needs]),
  );
  const groups = [...new Set(usable.map((l) => l.group))];
  const shownCount = usable.filter((l) => !hidden.has(l.id)).length;

  return (
    <Sheet
      title="Einstellungen"
      meta={`${shownCount} von ${usable.length} Ebenen im Menü`}
      onClose={props.onClose}
    >
      <div className="st-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`st-tab${tab === t.id ? ' is-on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'ebenen' && (
        <>
          <p className="muted st-intro">
            Was hier abgewählt ist, verschwindet aus dem Menü „Ebenen" auf der Karte — die Ebene
            wird dabei ausgeschaltet. Das ändert nichts an den Daten, nur an dem, was angeboten
            wird.
          </p>
          <div className="rp-actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => set({ hiddenLayers: [] })}
              disabled={!settings.hiddenLayers.length}
            >
              Alle anzeigen
            </button>
          </div>
          {groups.map((group) => (
            <div key={group} className="st-group">
              <div className="sect-label">{group}</div>
              <ul className="st-list">
                {usable
                  .filter((l) => l.group === group)
                  .map((l) => {
                    const on = !hidden.has(l.id);
                    const src = l.source ? SOURCE_BY_KEY[l.source] : undefined;
                    return (
                      <li key={l.id}>
                        <button
                          type="button"
                          className="st-item"
                          role="switch"
                          aria-checked={on}
                          onClick={() => toggleLayer(l.id)}
                        >
                          <span className="k" style={{ background: l.color }} />
                          <span className="st-label">
                            {l.label}
                            <span className="st-hint">
                              {l.hint}
                              {src ? ` · ${src.name}` : ''}
                            </span>
                          </span>
                          <span className={`st-switch${on ? ' is-on' : ''}`} aria-hidden="true">
                            <i />
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </>
      )}

      {tab === 'app' && (
        <>
          <div className="sect-label">Aktualisieren</div>
          <p className="muted st-intro">
            Der Knopf in der Kopfzeile holt alles sofort neu. Zusätzlich kann die App das in einem
            festen Takt tun — ohne Verbindung passiert dabei nichts.
          </p>
          <div className="st-choices" role="group" aria-label="Selbsttätig aktualisieren">
            {REFRESH_CHOICES.map((min) => (
              <button
                key={min}
                type="button"
                className={`st-choice${settings.autoRefreshMin === min ? ' is-on' : ''}`}
                aria-pressed={settings.autoRefreshMin === min}
                onClick={() => set({ autoRefreshMin: min })}
              >
                {min === 0 ? 'Aus' : `alle ${min} min`}
              </button>
            ))}
          </div>

          <div className="sect-label" style={{ marginTop: 18 }}>
            Verhalten
          </div>
          <ul className="st-list">
            <li>
              <button
                type="button"
                className="st-item"
                role="switch"
                aria-checked={settings.locateOnStart}
                onClick={() => set({ locateOnStart: !settings.locateOnStart })}
              >
                <span className="st-label">
                  Beim Start orten
                  <span className="st-hint">
                    sonst bleibt der zuletzt gewählte Ort stehen, bis du selbst ortest
                  </span>
                </span>
                <span className={`st-switch${settings.locateOnStart ? ' is-on' : ''}`} aria-hidden="true">
                  <i />
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="st-item"
                role="switch"
                aria-checked={settings.voiceGuidance}
                onClick={() => set({ voiceGuidance: !settings.voiceGuidance })}
              >
                <span className="st-label">
                  Ansagen bei der Zielführung
                  <span className="st-hint">gesprochene Abbiegehinweise über die Gerätestimme</span>
                </span>
                <span className={`st-switch${settings.voiceGuidance ? ' is-on' : ''}`} aria-hidden="true">
                  <i />
                </span>
              </button>
            </li>
          </ul>

          <div className="sect-label" style={{ marginTop: 18 }}>
            Offline
          </div>
          <p className="muted st-intro">
            Karte, Routing und Suche liegen je Bundesland als Paket im Browser. Ohne Verbindung
            arbeitet die App damit weiter.
          </p>
          <div className="rp-actions">
            <button type="button" className="btn-primary" onClick={props.onOpenRegions}>
              Offline-Regionen verwalten
            </button>
          </div>

          <div className="sect-label" style={{ marginTop: 18 }}>
            Über Lagebild
          </div>
          <p className="muted st-intro">
            Alle Daten bleiben auf dem Gerät: gespeicherte Ziele, Markierungen, Rufzeichen und der
            letzte Datenstand liegen im Browser, nicht auf einem Server. Der eigene Server ist nur
            ein Vermittler zu den Quellen im Reiter „Quellen" und speichert nichts über einen
            kurzen Zwischenspeicher hinaus.
          </p>
        </>
      )}

      {tab === 'quellen' && (
        <>
          <p className="muted st-intro">
            Diese App zeigt fremde Daten. Wer sie bereitstellt, steht hier — mit Rücklink, wie es
            mehrere Anbieter ausdrücklich erbitten.
          </p>
          {SOURCE_GROUPS.map((g) => (
            <div key={g.group} className="st-group">
              <div className="sect-label">{g.group}</div>
              <ul className="src-list">
                {g.items.map((s) => (
                  <li key={s.key}>
                    <a href={s.url} target="_blank" rel="noreferrer" className="src-name">
                      {s.name}
                    </a>
                    <span className="src-use">{s.use}</span>
                    {s.terms && <span className="src-terms">{s.terms}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="st-group">
            <div className="sect-label">Verwendete Projekte</div>
            <ul className="src-list">
              {PROJECTS.map((p) => (
                <li key={p.name}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="src-name">
                    {p.name}
                  </a>
                  <span className="src-use">{p.use}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="sr-hint" style={{ marginTop: 12 }}>
            Karten- und Routendaten stammen von{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap-Mitwirkenden
            </a>{' '}
            (ODbL). Wetterdaten kommen vom Deutschen Wetterdienst.
          </p>
        </>
      )}
    </Sheet>
  );
}
