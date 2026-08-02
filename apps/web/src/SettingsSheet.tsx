import { useState } from 'react';
import { Sheet } from './Sheet.js';
import {
  ALWAYS_SHOWN,
  LAYER_CATALOG,
  NEEDS_REASON,
  type LayerInfo,
  type LayerRowId,
} from './layerCatalog.js';
import { PROJECTS, SOURCE_BY_KEY, SOURCE_GROUPS } from './sources.js';
import { REFRESH_CHOICES, type Settings } from './settings.js';
import {
  DEFAULT_SECONDS,
  newPresetId,
  type MapPreset,
  type SlideshowSettings,
} from './mapPresets.js';

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  /** Welche Ebenen der Server überhaupt anbietet (Schlüssel vorhanden). */
  available: { flow: boolean; ais: boolean; aprs: boolean; lightning: boolean };
  onOpenRegions: () => void;
  onClose: () => void;
  /* --- Diashow --- */
  presets: MapPreset[];
  onPresets: (next: MapPreset[]) => void;
  slideshow: SlideshowSettings;
  onSlideshow: (next: SlideshowSettings) => void;
  /** Gerade eingeschaltete Ebenen — Vorlage für „Aktuelle Ansicht sichern". */
  activeLayers: LayerRowId[];
  /** Eine Karte zur Ansicht auf die Karte legen. */
  onPreview: (preset: MapPreset) => void;
  /** Diashow starten (schließt das Blatt). */
  onStart: () => void;
}

type Tab = 'ebenen' | 'diashow' | 'app' | 'quellen';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ebenen', label: 'Ebenen' },
  { id: 'diashow', label: 'Diashow' },
  { id: 'app', label: 'App' },
  { id: 'quellen', label: 'Quellen' },
];

/** Standzeiten zur Auswahl (Sekunden). */
const DWELL_CHOICES = [10, 20, 30, 60, 120];

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

  // Alle Ebenen stehen in der Liste — die ohne Schlüssel ausgegraut, damit man
  // sieht, dass es sie gibt und woran es fehlt.
  const listed = LAYER_CATALOG.filter((l) => !ALWAYS_SHOWN.includes(l.id));
  const has = (l: LayerInfo) => !l.needs || props.available[l.needs];
  /** Nur einsatzbereite Ebenen taugen als Vorlage für Karten und Zähler. */
  const usable = listed.filter(has);
  const groups = [...new Set(listed.map((l) => l.group))];
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
            wird. <b>Ausgegraute</b> Ebenen brauchen einen Zugang, den der Server nicht hat; sie
            erscheinen erst mit dem passenden Schlüssel.
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
                {listed
                  .filter((l) => l.group === group)
                  .map((l) => {
                    const ready = has(l);
                    const on = ready && !hidden.has(l.id);
                    const src = l.source ? SOURCE_BY_KEY[l.source] : undefined;
                    return (
                      <li key={l.id}>
                        <button
                          type="button"
                          className={`st-item${ready ? '' : ' is-off'}`}
                          role="switch"
                          aria-checked={on}
                          aria-disabled={!ready}
                          disabled={!ready}
                          title={ready ? undefined : NEEDS_REASON[l.needs!]}
                          onClick={() => toggleLayer(l.id)}
                        >
                          <span className="k" style={{ background: l.color }} />
                          <span className="st-label">
                            {l.label}
                            <span className="st-hint">
                              {ready
                                ? [l.hint, src?.name].filter(Boolean).join(' · ')
                                : NEEDS_REASON[l.needs!]}
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

      {tab === 'diashow' && (
        <SlideshowTab
          usable={usable}
          presets={props.presets}
          onPresets={props.onPresets}
          slideshow={props.slideshow}
          onSlideshow={props.onSlideshow}
          activeLayers={props.activeLayers}
          hidden={hidden}
          onPreview={props.onPreview}
          onStart={props.onStart}
        />
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

/**
 * Reiter „Diashow": Karten anlegen, ordnen, Standzeit setzen, starten.
 *
 * Eine „Karte" ist nichts weiter als eine Liste eingeschalteter Ebenen. Sie
 * entsteht deshalb aus der aktuellen Ansicht — was man auf der Karte sieht,
 * wird gesichert. Das erspart eine zweite Ebenen-Auswahl an dieser Stelle.
 */
function SlideshowTab(props: {
  /** Ebenen, die überhaupt zur Wahl stehen (Schlüssel vorhanden). */
  usable: LayerInfo[];
  presets: MapPreset[];
  onPresets: (next: MapPreset[]) => void;
  slideshow: SlideshowSettings;
  onSlideshow: (next: SlideshowSettings) => void;
  activeLayers: LayerRowId[];
  hidden: Set<LayerRowId>;
  onPreview: (preset: MapPreset) => void;
  onStart: () => void;
}) {
  const { presets, usable } = props;
  /** Welche Karte hat gerade ihre Ebenenauswahl offen? */
  const [editing, setEditing] = useState<string | null>(null);
  /** Ziehen: welche Karte hängt am Zeiger, über welcher schwebt sie? */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const nameOf = (id: LayerRowId) => usable.find((l) => l.id === id)?.label ?? id;
  /** Ausgeblendete Ebenen gehören nicht in eine Karte — man fände sie nicht wieder. */
  const pickable = () => props.activeLayers.filter((id) => !props.hidden.has(id));

  const update = (id: string, patch: Partial<MapPreset>) =>
    props.onPresets(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  /** Karte von `from` an die Stelle von `to` setzen (Ziehen und ↑/↓ teilen sich das). */
  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= presets.length) return;
    const next = [...presets];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    props.onPresets(next);
  };

  const addPreset = (layers: LayerRowId[], open: boolean) => {
    const id = newPresetId();
    props.onPresets([
      ...presets,
      { id, name: `Karte ${presets.length + 1}`, layers, seconds: DEFAULT_SECONDS },
    ]);
    if (open) setEditing(id);
  };

  const toggleLayerOf = (preset: MapPreset, layer: LayerRowId) => {
    const has = preset.layers.includes(layer);
    update(preset.id, {
      layers: has ? preset.layers.filter((l) => l !== layer) : [...preset.layers, layer],
    });
  };

  const groups = [...new Set(usable.map((l) => l.group))];
  const total = presets.reduce((sum, p) => sum + p.seconds, 0);

  return (
    <>
      <p className="muted st-intro">
        Eine <b>Karte</b> ist eine Zusammenstellung von Ebenen. Mehrere Karten in eine Reihenfolge
        gebracht und mit Standzeit versehen ergeben eine Diashow — gedacht für einen großen
        Monitor, der ohne Zutun durchläuft. Die Reihenfolge lässt sich mit der Maus ziehen.
      </p>

      <div className="rp-actions" style={{ marginBottom: 14 }}>
        <button type="button" className="btn-primary" onClick={() => addPreset([], true)}>
          Neue Karte zusammenstellen
        </button>
        <button type="button" className="btn-quiet" onClick={() => addPreset(pickable(), false)}>
          Aktuelle Ansicht sichern
        </button>
        {presets.length > 1 && (
          <button type="button" className="btn-quiet" onClick={props.onStart}>
            Diashow starten
          </button>
        )}
      </div>

      {!presets.length && (
        <p className="muted">
          Noch keine Karte. „Neue Karte zusammenstellen" öffnet gleich die Ebenenauswahl;
          „Aktuelle Ansicht sichern" übernimmt, was gerade auf der Karte liegt.
        </p>
      )}

      {!!presets.length && (
        <>
          <div className="sect-label">
            {presets.length} Karten · Durchlauf {Math.round(total / 6) / 10} min
          </div>
          <ol className="ps-list">
            {presets.map((p, i) => (
              <li
                key={p.id}
                draggable={dragId === p.id}
                className={`${dragId === p.id ? 'is-dragging' : ''}${overId === p.id && dragId !== p.id ? ' is-over' : ''}`}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  // Firefox zieht nur mit gesetzten Daten.
                  e.dataTransfer.setData('text/plain', p.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === p.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setOverId(p.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = presets.findIndex((x) => x.id === dragId);
                  if (from >= 0) reorder(from, i);
                  setDragId(null);
                  setOverId(null);
                }}
              >
                <div className="ps-head">
                  {/* Ziehen erst ab dem Griff — sonst ließe sich der Name nicht
                      mehr markieren. */}
                  <span
                    className="ps-grip"
                    title="Zum Sortieren ziehen"
                    aria-hidden="true"
                    onMouseDown={() => setDragId(p.id)}
                    onTouchStart={() => setDragId(p.id)}
                  >
                    ⠿
                  </span>
                  <span className="ps-num">{i + 1}</span>
                  <input
                    className="ps-name"
                    value={p.name}
                    aria-label={`Name der ${i + 1}. Karte`}
                    onChange={(e) => update(p.id, { name: e.target.value })}
                  />
                  <button
                    type="button"
                    className="ps-btn"
                    onClick={() => reorder(i, i - 1)}
                    disabled={i === 0}
                    aria-label="Nach oben"
                    title="Nach oben"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ps-btn"
                    onClick={() => reorder(i, i + 1)}
                    disabled={i === presets.length - 1}
                    aria-label="Nach unten"
                    title="Nach unten"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="ps-btn ps-del"
                    onClick={() => props.onPresets(presets.filter((x) => x.id !== p.id))}
                    aria-label="Karte löschen"
                    title="Karte löschen"
                  >
                    ✕
                  </button>
                </div>

                <button
                  type="button"
                  className="ps-layers"
                  aria-expanded={editing === p.id}
                  onClick={() => setEditing(editing === p.id ? null : p.id)}
                >
                  <span>
                    {p.layers.length
                      ? p.layers.map(nameOf).join(' · ')
                      : 'noch keine Ebene gewählt'}
                  </span>
                  <span className="ps-caret" aria-hidden="true">
                    {editing === p.id ? '▴' : '▾'}
                  </span>
                </button>

                {editing === p.id && (
                  <div className="ps-pick">
                    {groups.map((group) => (
                      <div key={group} className="ps-pick-group">
                        <div className="sect-label">{group}</div>
                        {usable
                          .filter((l) => l.group === group)
                          .map((l) => {
                            const on = p.layers.includes(l.id);
                            return (
                              <button
                                key={l.id}
                                type="button"
                                className="ps-pick-row"
                                role="switch"
                                aria-checked={on}
                                onClick={() => toggleLayerOf(p, l.id)}
                              >
                                <span className="k" style={{ background: l.color }} />
                                <span className="st-label">{l.label}</span>
                                <span className={`st-switch${on ? ' is-on' : ''}`} aria-hidden="true">
                                  <i />
                                </span>
                              </button>
                            );
                          })}
                      </div>
                    ))}
                    <div className="ps-foot">
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => update(p.id, { layers: pickable() })}
                        title="Die gerade eingeschalteten Ebenen übernehmen"
                      >
                        Aktuelle Ansicht übernehmen
                      </button>
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => update(p.id, { layers: [] })}
                        disabled={!p.layers.length}
                      >
                        Alle abwählen
                      </button>
                    </div>
                  </div>
                )}

                <div className="ps-foot">
                  <label className="ps-secs">
                    Standzeit
                    <select
                      value={DWELL_CHOICES.includes(p.seconds) ? p.seconds : DEFAULT_SECONDS}
                      onChange={(e) => update(p.id, { seconds: Number(e.target.value) })}
                    >
                      {DWELL_CHOICES.map((sec) => (
                        <option key={sec} value={sec}>
                          {sec < 60 ? `${sec} s` : `${sec / 60} min`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn-quiet" onClick={() => props.onPreview(p)}>
                    Auf der Karte zeigen
                  </button>
                </div>
              </li>
            ))}
          </ol>

          <div className="sect-label" style={{ marginTop: 18 }}>
            Ablauf
          </div>
          <ul className="st-list">
            <li>
              <button
                type="button"
                className="st-item"
                role="switch"
                aria-checked={props.slideshow.mapOnly}
                onClick={() => props.onSlideshow({ ...props.slideshow, mapOnly: !props.slideshow.mapOnly })}
              >
                <span className="st-label">
                  Nur die Karte zeigen
                  <span className="st-hint">Kachelspalte ausblenden — für den großen Monitor</span>
                </span>
                <span className={`st-switch${props.slideshow.mapOnly ? ' is-on' : ''}`} aria-hidden="true">
                  <i />
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="st-item"
                role="switch"
                aria-checked={props.slideshow.loop}
                onClick={() => props.onSlideshow({ ...props.slideshow, loop: !props.slideshow.loop })}
              >
                <span className="st-label">
                  Endlos wiederholen
                  <span className="st-hint">sonst endet die Diashow nach der letzten Karte</span>
                </span>
                <span className={`st-switch${props.slideshow.loop ? ' is-on' : ''}`} aria-hidden="true">
                  <i />
                </span>
              </button>
            </li>
          </ul>
        </>
      )}
    </>
  );
}
