/**
 * Gefahrgut nachschlagen.
 *
 * Die orangefarbene Tafel am Fahrzeug trägt zwei Zahlen: oben die
 * **Gefahrnummer** (Kemler-Zahl), unten die **UN-Nummer**. Beide führen hier
 * zum Ziel — und aus der UN-Nummer kommen die Abstände, die man als Erstes
 * braucht: wie weit rundum abzusperren ist und wie weit die Wolke stromab
 * reicht.
 *
 * Die Stoffdaten stehen in `public/hazmat.json` (gebaut von
 * `scripts/build-hazmat.mjs` aus dem gemeinfreien **Emergency Response
 * Guidebook 2024**). Geladen wird die Datei erst beim ersten Nachschlagen,
 * danach bleibt sie im Speicher; der Service Worker hat sie ohnehin im Vorrat,
 * damit das Nachschlagen auch ohne Netz geht.
 *
 * **Grenze, die überall mitläuft:** Das ERG ist ein Handbuch für die ersten
 * Minuten, keine Ersatzquelle für ERI-Karte, Beförderungspapier und
 * Einsatzleitung. Die App sagt das an jeder Stelle, an der sie eine Zahl nennt.
 */

export interface HazmatMaterial {
  /** UN-Nummer. */
  id: number;
  /** Leitfadennummer im ERG, z. B. „128" oder „131P". */
  guide: string;
  name: string;
  /** Weitere Benennungen derselben Nummer. */
  also: string[];
}

export interface HazmatDistances {
  /** Absperrung rundum bei kleiner Menge, in Metern. */
  smallIsolationM?: number;
  /** Schutzabstand stromab bei kleiner Menge, in Kilometern. */
  smallDayKm?: number;
  smallNightKm?: number;
  largeIsolationM?: number;
  largeDayKm?: number;
  largeNightKm?: number;
  /** Bei großer Menge verweist die Tabelle auf die Tankgrößen-Tabelle 3. */
  largeRefersToTable3?: boolean;
}

interface HazmatData {
  source: string;
  edition: number;
  guides: Record<string, string>;
  materials: HazmatMaterial[];
  table1: Record<string, HazmatDistances>;
}

let cache: HazmatData | null = null;
let loading: Promise<HazmatData> | null = null;

export function loadHazmat(): Promise<HazmatData> {
  if (cache) return Promise.resolve(cache);
  loading ??= fetch('/hazmat.json')
    .then((r) => {
      if (!r.ok) throw new Error(`hazmat.json → HTTP ${r.status}`);
      return r.json() as Promise<HazmatData>;
    })
    .then((d) => {
      cache = d;
      return d;
    })
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

export interface HazmatHit {
  material: HazmatMaterial;
  /** Titel des Leitfadens (englisch, wie im ERG). */
  guideTitle: string | null;
  distances: HazmatDistances | null;
}

export function lookupUn(data: HazmatData, id: number): HazmatHit | null {
  const material = data.materials.find((m) => m.id === id);
  if (!material) return null;
  return {
    material,
    guideTitle: data.guides[material.guide.replace(/P$/, '')] ?? null,
    distances: data.table1[String(id)] ?? null,
  };
}

/** Freitextsuche über Benennung und Synonyme. */
export function searchHazmat(data: HazmatData, query: string, limit = 20): HazmatHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: HazmatHit[] = [];
  for (const m of data.materials) {
    const names = [m.name, ...m.also];
    if (!names.some((n) => n.toLowerCase().includes(q))) continue;
    out.push({
      material: m,
      guideTitle: data.guides[m.guide.replace(/P$/, '')] ?? null,
      distances: data.table1[String(m.id)] ?? null,
    });
    if (out.length >= limit) break;
  }
  // Treffer am Wortanfang zuerst — „Benzol" soll nicht hinter „Chlorbenzol" stehen.
  return out.sort((a, b) => {
    const av = a.material.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bv = b.material.name.toLowerCase().startsWith(q) ? 0 : 1;
    return av - bv || a.material.id - b.material.id;
  });
}

/* ------------------------------------------------------------------ *
 * Gefahrnummer (Kemler-Zahl)
 * ------------------------------------------------------------------ */

/**
 * Bedeutung der einzelnen Ziffern nach ADR 5.3.2.3. Die erste Ziffer nennt die
 * Hauptgefahr, jede weitere eine zusätzliche; eine **verdoppelte** Ziffer
 * verstärkt die Aussage („33" = leicht entzündbar), eine angehängte **0**
 * bedeutet, dass es bei der einen Gefahr bleibt.
 */
const DIGIT: Record<string, string> = {
  '2': 'Entweichen von Gas durch Druck oder chemische Reaktion',
  '3': 'Entzündbarkeit von flüssigen Stoffen und Gasen oder selbsterhitzungsfähig',
  '4': 'Entzündbarkeit fester Stoffe oder selbsterhitzungsfähiger fester Stoff',
  '5': 'oxidierende (brandfördernde) Wirkung',
  '6': 'Giftigkeit oder Ansteckungsgefahr',
  '7': 'Radioaktivität',
  '8': 'Ätzwirkung',
  '9': 'Gefahr einer spontanen heftigen Reaktion',
};

export interface KemlerReading {
  /** Die Nummer, wie sie gelesen wurde (ohne Leerzeichen). */
  number: string;
  /** true, wenn ein „X" vorangeht. */
  noWater: boolean;
  lines: string[];
}

/**
 * Liest eine Gefahrnummer. Gibt `null`, wenn sie nicht zum Schema passt.
 *
 * Bewusst **regelbasiert**: Das Schema selbst steht im ADR, einzelne
 * Kombinationen haben dort zusätzlich eine engere Bedeutung. Die App sagt
 * deshalb, was die Ziffern bedeuten, und verweist für die genaue Einstufung auf
 * das Beförderungspapier — statt eine Tabelle nachzubauen, in der ein einziger
 * Tippfehler im Einsatz teuer wäre.
 */
export function readKemler(input: string): KemlerReading | null {
  const raw = input.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^(X?)(\d{2,3})$/.exec(raw);
  if (!m) return null;
  const digits = m[2]!;
  const lines: string[] = [];

  const first = digits[0]!;
  lines.push(`${first} — ${DIGIT[first] ?? 'unbekannte Hauptgefahr'}`);

  for (let i = 1; i < digits.length; i++) {
    const d = digits[i]!;
    if (d === '0') {
      lines.push('0 — keine weitere Gefahr');
      continue;
    }
    if (d === digits[i - 1]) {
      lines.push(`${d} — verstärkt: ${DIGIT[d] ?? 'siehe oben'}`);
      continue;
    }
    lines.push(`${d} — ${DIGIT[d] ?? 'unbekannt'}`);
  }

  return { number: raw, noWater: m[1] === 'X', lines };
}

/* ------------------------------------------------------------------ *
 * Eingabe von der orangefarbenen Tafel
 * ------------------------------------------------------------------ */

export interface PlateInput {
  un: number | null;
  kemler: string | null;
  /** Freitext, wenn keine Zahl erkannt wurde. */
  text: string | null;
}

/**
 * Liest, was jemand eingetippt hat: „1203", „33/1203", „X423", „Benzin".
 *
 * Die Tafel steht zweizeilig, viele schreiben sie deshalb als „33/1203" oder
 * „33 1203". Vierstellige Zahlen sind UN-Nummern, zwei- bis dreistellige (mit
 * möglichem X davor) Gefahrnummern.
 */
export function readPlate(input: string): PlateInput {
  const raw = input.trim();
  const out: PlateInput = { un: null, kemler: null, text: null };
  if (!raw) return out;

  const parts = raw.toUpperCase().split(/[^0-9X]+/).filter(Boolean);
  for (const p of parts) {
    if (/^\d{4}$/.test(p) && out.un == null) out.un = Number(p);
    else if (/^X?\d{2,3}$/.test(p) && out.kemler == null) out.kemler = p;
  }
  if (out.un == null && out.kemler == null) out.text = raw;
  return out;
}
