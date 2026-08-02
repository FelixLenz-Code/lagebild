import type { HfBandCondition, HfSpaceWeather } from '@lagebild/shared';

/** Stufen mit eigener Farbe **und** eigenem Wort — Farbe allein trägt nicht. */
const LEVEL_DE: Record<HfBandCondition['level'], string> = {
  good: 'Gut',
  fair: 'Mäßig',
  poor: 'Schlecht',
  unknown: '–',
};
const LEVEL_COLOR: Record<HfBandCondition['level'], string> = {
  good: 'var(--ok)',
  fair: 'var(--sev1)',
  poor: 'var(--sev3)',
  unknown: 'var(--faint)',
};

/** Bandgruppen in der Reihenfolge der Quelle, mit deutscher Beschriftung. */
const BAND_LABEL: Record<string, string> = {
  '80m-40m': '80/40 m',
  '30m-20m': '30/20 m',
  '17m-15m': '17/15 m',
  '12m-10m': '12/10 m',
};

function BandCell({ c }: { c: HfBandCondition | undefined }) {
  if (!c) return <span className="hf-cell">–</span>;
  return (
    <span className="hf-cell" style={{ color: LEVEL_COLOR[c.level] }}>
      <i style={{ background: LEVEL_COLOR[c.level] }} />
      {LEVEL_DE[c.level]}
    </span>
  );
}

/** Bandbewertungen als Raster Tag/Nacht — kompakt genug für die Kachel. */
export function HfBands({ data }: { data: HfSpaceWeather }) {
  const groups = [...new Set(data.bands.map((b) => b.band))];
  if (!groups.length) return <p className="muted">Keine Bandbewertungen verfügbar.</p>;
  return (
    <div className="hf-bands">
      <span className="hf-head" />
      <span className="hf-head">Tag</span>
      <span className="hf-head">Nacht</span>
      {groups.map((g) => (
        <FragmentRow key={g} group={g} data={data} />
      ))}
    </div>
  );
}

function FragmentRow({ group, data }: { group: string; data: HfSpaceWeather }) {
  return (
    <>
      <span className="hf-band">{BAND_LABEL[group] ?? group}</span>
      <BandCell c={data.bands.find((b) => b.band === group && b.time === 'day')} />
      <BandCell c={data.bands.find((b) => b.band === group && b.time === 'night')} />
    </>
  );
}

/** Ausführliche Ansicht mit allen Kennzahlen und den Quellenangaben. */
export function HfDetail({ data }: { data: HfSpaceWeather }) {
  const rows: [string, string][] = [
    ['Solarer Fluss (10,7 cm)', data.solarFluxIndex != null ? `${data.solarFluxIndex} sfu` : '–'],
    ['Sonnenflecken', data.sunspots != null ? String(data.sunspots) : '–'],
    ['A-Index', data.aIndex != null ? String(data.aIndex) : '–'],
    ['K-Index', data.kIndex != null ? String(data.kIndex) : '–'],
    ['Röntgenfluss', data.xray ?? '–'],
    ['Erdmagnetfeld', data.geomagField ?? '–'],
    ['Polarlicht-Stufe', data.aurora != null ? String(data.aurora) : '–'],
    ['Störpegel', data.signalNoise ?? '–'],
    ['Sonnenwind', data.solarWindKmS != null ? `${data.solarWindKmS} km/s` : '–'],
  ];
  return (
    <div className="detail-list">
      <div className="hf-grid">
        {rows.map(([k, v]) => (
          <div className="hf-kv" key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>

      <div className="sect-label">Bänder</div>
      <HfBands data={data} />

      <p className="sr-hint" style={{ marginTop: 14 }}>
        Kennzahlen und Bandbewertungen von{' '}
        <a href="https://www.hamqsl.com/solar.html" target="_blank" rel="noreferrer">
          N0NBH (hamqsl.com)
        </a>{' '}
        — stündlich abgerufen. Die Ausbreitungsebene auf der Karte nutzt Ionosonden von{' '}
        <a href="https://prop.kc2g.com/" target="_blank" rel="noreferrer">
          prop.kc2g.com
        </a>{' '}
        (GIRO) und Sonnendaten der NOAA.
      </p>
      <p className="sr-hint">
        Die Bewertungen sind eine Faustregel für den Funkbetrieb, keine Vorhersage für eine
        bestimmte Strecke.
      </p>
    </div>
  );
}
