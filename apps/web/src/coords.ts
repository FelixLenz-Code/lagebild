import type { Coords } from '@lagebild/shared';

/**
 * Koordinaten in den Schreibweisen, die anderswo verlangt werden.
 *
 * - **Dezimalgrad** — Karten, Apps, Notruf per Telefon
 * - **Grad/Dezimalminuten** — Seefahrt, Luftfahrt, Leitstellen
 * - **Grad/Minuten/Sekunden** — Katasterunterlagen, ältere Karten
 * - **UTM** und **MGRS** — Behörden, Bundeswehr, THW, Feuerwehr im Gelände
 *
 * Die Umrechnung nach UTM steht hier selbst (Karney/Krüger-Reihe bis zur
 * vierten Ordnung auf dem WGS84-Ellipsoid); eine Bibliothek dafür wäre die
 * einzige Abhängigkeit im Frontend, und die Formeln sind gut dokumentiert.
 * Genauigkeit: unter einem Millimeter im Gültigkeitsbereich.
 */

const RAD = Math.PI / 180;
/** WGS84 */
const A = 6378137.0;
const F = 1 / 298.257223563;
const K0 = 0.9996;

export interface Utm {
  zone: number;
  /** Breitenband (C–X ohne I und O). */
  band: string;
  north: boolean;
  easting: number;
  northing: number;
}

/** Breitenbänder der UTM-Zonen, 8° hoch, ab 80° Süd. */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

function latBand(lat: number): string {
  if (lat < -80 || lat > 84) return '';
  const i = Math.floor((lat + 80) / 8);
  return BANDS[Math.min(i, BANDS.length - 1)] ?? '';
}

/**
 * Zonennummer inklusive der beiden Sonderfälle: Norwegen weitet Zone 32,
 * Spitzbergen verschiebt 31–37 — wer das ignoriert, liegt dort um eine ganze
 * Zone daneben.
 */
export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon < 21) zone = 33;
    else if (lon < 33) zone = 35;
    else if (lon < 42) zone = 37;
  }
  return zone;
}

/** Geografische Koordinate → UTM (Transversale Mercator-Projektion). */
export function toUtm(c: Coords): Utm | null {
  if (c.lat < -80 || c.lat > 84) return null; // außerhalb gilt UPS
  const zone = utmZone(c.lat, c.lon);
  const λ0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const φ = c.lat * RAD;
  const λ = c.lon * RAD - λ0;

  const e = Math.sqrt(F * (2 - F));
  const n = F / (2 - F);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;

  const cosλ = Math.cos(λ);
  const sinλ = Math.sin(λ);
  const τ = Math.tan(φ);
  const σ = Math.sinh(e * Math.atanh((e * τ) / Math.sqrt(1 + τ * τ)));
  const τ2 = τ * Math.sqrt(1 + σ * σ) - σ * Math.sqrt(1 + τ * τ);
  const ξ2 = Math.atan2(τ2, cosλ);
  const η2 = Math.asinh(sinλ / Math.sqrt(τ2 * τ2 + cosλ * cosλ));

  // Meridianbogenlänge und die Krüger-Reihe (α₁…α₄).
  const Aa = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const α = [
    n / 2 - (2 / 3) * n2 + (5 / 16) * n3,
    (13 / 48) * n2 - (3 / 5) * n3,
    (61 / 240) * n3,
    (49561 / 161280) * n4,
  ];

  let ξ = ξ2;
  let η = η2;
  for (let j = 1; j <= 4; j++) {
    ξ += α[j - 1]! * Math.sin(2 * j * ξ2) * Math.cosh(2 * j * η2);
    η += α[j - 1]! * Math.cos(2 * j * ξ2) * Math.sinh(2 * j * η2);
  }

  let x = K0 * Aa * η;
  let y = K0 * Aa * ξ;
  x += 500_000; // falscher Ostwert
  if (y < 0) y += 10_000_000; // falscher Nordwert auf der Südhalbkugel

  return {
    zone,
    band: latBand(c.lat),
    north: c.lat >= 0,
    easting: Math.round(x * 100) / 100,
    northing: Math.round(y * 100) / 100,
  };
}

/** Spaltenbuchstaben der 100-km-Quadrate, je Zonensatz (Zone mod 3). */
const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
/** Zeilenbuchstaben, abwechselnd ab A bzw. F. */
const ROW_SET = 'ABCDEFGHJKLMNPQRSTUV';

/**
 * UTM → MGRS. Das 100-km-Quadrat ergibt sich aus Ost- und Nordwert; die
 * Buchstabenreihen wiederholen sich je Zone (Spalten) bzw. alle 2.000 km
 * (Zeilen, versetzt bei geraden Zonen).
 */
export function toMgrs(c: Coords, digits: 3 | 4 | 5 = 5): string | null {
  const u = toUtm(c);
  if (!u || !u.band) return null;
  const col = Math.floor(u.easting / 100_000);
  const row = Math.floor(u.northing / 100_000) % 20;
  const colLetters = COL_SETS[(u.zone - 1) % 3]!;
  const colLetter = colLetters[col - 1];
  const rowOffset = u.zone % 2 === 0 ? 5 : 0;
  const rowLetter = ROW_SET[(row + rowOffset) % 20];
  if (!colLetter || !rowLetter) return null;

  const factor = 10 ** (5 - digits);
  const e = Math.floor((u.easting % 100_000) / factor)
    .toString()
    .padStart(digits, '0');
  const n = Math.floor((u.northing % 100_000) / factor)
    .toString()
    .padStart(digits, '0');
  return `${u.zone}${u.band} ${colLetter}${rowLetter} ${e} ${n}`;
}

const de = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');

/** Dezimalgrad: „52,51630 N 13,37770 E". */
export const formatDecimal = (c: Coords): string =>
  `${de(Math.abs(c.lat), 5)} ${c.lat >= 0 ? 'N' : 'S'}  ${de(Math.abs(c.lon), 5)} ${c.lon >= 0 ? 'E' : 'W'}`;

/** Grad und Dezimalminuten: „52° 30,978' N 13° 22,662' E". */
export function formatDegMin(c: Coords): string {
  const part = (v: number, pos: string, neg: string) => {
    const dir = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    return `${deg}° ${de((abs - deg) * 60, 3)}' ${dir}`;
  };
  return `${part(c.lat, 'N', 'S')}  ${part(c.lon, 'E', 'W')}`;
}

/** Grad, Minuten, Sekunden: „52° 30' 58,7\" N". */
export function formatDegMinSec(c: Coords): string {
  const part = (v: number, pos: string, neg: string) => {
    const dir = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const minFull = (abs - deg) * 60;
    const min = Math.floor(minFull);
    return `${deg}° ${min}' ${de((minFull - min) * 60, 1)}" ${dir}`;
  };
  return `${part(c.lat, 'N', 'S')}  ${part(c.lon, 'E', 'W')}`;
}

/** UTM als Zeichenkette: „33U 389880 5819698". */
export function formatUtm(c: Coords): string | null {
  const u = toUtm(c);
  if (!u) return null;
  return `${u.zone}${u.band} ${Math.round(u.easting)} ${Math.round(u.northing)}`;
}

/** Alle Schreibweisen auf einmal — für Anzeige und Kopierknöpfe. */
export function allFormats(c: Coords): { label: string; value: string }[] {
  const out = [
    { label: 'Dezimalgrad', value: formatDecimal(c) },
    { label: 'Grad/Minuten', value: formatDegMin(c) },
    { label: 'Grad/Min/Sek', value: formatDegMinSec(c) },
  ];
  const utm = formatUtm(c);
  if (utm) out.push({ label: 'UTM', value: utm });
  const mgrs = toMgrs(c);
  if (mgrs) out.push({ label: 'MGRS', value: mgrs });
  return out;
}

/* ------------------------------------------------------------------ */
/* Eingabe                                                             */
/* ------------------------------------------------------------------ */

const num = (s: string) => Number(s.replace(',', '.'));

/**
 * Koordinaten aus einer Eingabe lesen — in allen Schreibweisen, die die App
 * auch ausgibt, dazu die üblichen Kopier-Formate aus anderen Karten
 * („52.5163, 13.3777", „N 52 30.978 E 13 22.662", „33U 389880 5819698").
 * Gibt `null` zurück, wenn nichts Eindeutiges erkennbar ist.
 */
export function parseCoords(raw: string): Coords | null {
  const text = raw.trim();
  if (!text) return null;

  // MGRS: „33U UU 89880 19698" bzw. ohne Leerzeichen
  const mgrs = text
    .toUpperCase()
    .match(/^(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-Z])\s*([A-HJ-V])\s*([\d\s]{2,12})$/);
  if (mgrs) {
    // Die beiden Hälften stehen mal zusammen, mal durch ein Leerzeichen getrennt.
    const digits = mgrs[5]!.replace(/\s+/g, '');
    if (digits.length % 2 === 0 && digits.length >= 2) {
      const half = digits.length / 2;
      return fromMgrsParts(
        Number(mgrs[1]),
        mgrs[2]!,
        mgrs[3]!,
        mgrs[4]!,
        Number(digits.slice(0, half)) * 10 ** (5 - half),
        Number(digits.slice(half)) * 10 ** (5 - half),
      );
    }
  }

  // UTM: „33U 389880 5819698"
  const utm = text.toUpperCase().match(/^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{4,7})[\s,]+(\d{4,8})$/);
  if (utm) {
    return fromUtm({
      zone: Number(utm[1]),
      band: utm[2]!,
      north: utm[2]! >= 'N',
      easting: Number(utm[3]),
      northing: Number(utm[4]),
    });
  }

  // Grad/Minuten(/Sekunden) mit Himmelsrichtung
  const dms = [
    ...text.matchAll(
      /([NSEWO])?\s*(-?\d{1,3})\s*[°º:\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*['’′:]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*["”″]?)?\s*([NSEWO])?/gi,
    ),
  ].filter((m) => m[2] !== undefined && m[3] !== undefined);
  if (dms.length >= 2) {
    const value = (m: RegExpMatchArray) => {
      const deg = Math.abs(num(m[2]!));
      const min = num(m[3]!);
      const sec = m[4] ? num(m[4]) : 0;
      const letter = (m[1] || m[5] || '').toUpperCase();
      const sign = letter === 'S' || letter === 'W' ? -1 : m[2]!.startsWith('-') ? -1 : 1;
      return sign * (deg + min / 60 + sec / 3600);
    };
    const first = dms[0]!;
    const second = dms[1]!;
    // Steht vorn eine Himmelsrichtung, gilt sie — sonst die hinten. Sonst
    // greift bei „N 52 30.978 E 13 22.662" das E des zweiten Teils in den
    // ersten hinein und vertauscht Breite und Länge.
    const isLon = (m: RegExpMatchArray) => {
      const lead = m[1] ?? '';
      const tail = m[5] ?? '';
      const letter = lead || tail;
      return /[EWO]/i.test(letter);
    };
    const lat = isLon(first) ? value(second) : value(first);
    const lon = isLon(first) ? value(first) : value(second);
    if (valid(lat, lon)) return { lat, lon };
  }

  // Dezimalgrad: „52.5163, 13.3777" oder „52,5163 13,3777"
  const dec = [...text.matchAll(/(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NSEWO])?/gi)]
    .filter((m) => m[1] && /\d/.test(m[1]))
    .slice(0, 2);
  if (dec.length === 2) {
    const value = (m: RegExpMatchArray) =>
      (/[SW]/i.test(m[2] ?? '') ? -1 : 1) * num(m[1]!);
    let lat = value(dec[0]!);
    let lon = value(dec[1]!);
    // Steht die Himmelsrichtung dabei, ordnet sie die Werte zu.
    if (/[EWO]/i.test(dec[0]![2] ?? '')) [lat, lon] = [lon, lat];
    if (valid(lat, lon)) return { lat, lon };
  }
  return null;
}

const valid = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** UTM → geografisch (Umkehrung der Krüger-Reihe). */
export function fromUtm(u: Utm): Coords | null {
  const n = F / (2 - F);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const Aa = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64);

  const x = u.easting - 500_000;
  const y = u.north ? u.northing : u.northing - 10_000_000;

  const β = [
    n / 2 - (2 / 3) * n2 + (37 / 96) * n3,
    (1 / 48) * n2 + (1 / 15) * n3,
    (17 / 480) * n3,
    (4397 / 161280) * n4,
  ];
  const ξ = y / (K0 * Aa);
  const η = x / (K0 * Aa);
  let ξ2 = ξ;
  let η2 = η;
  for (let j = 1; j <= 4; j++) {
    ξ2 -= β[j - 1]! * Math.sin(2 * j * ξ) * Math.cosh(2 * j * η);
    η2 -= β[j - 1]! * Math.cos(2 * j * ξ) * Math.sinh(2 * j * η);
  }

  const sinhη = Math.sinh(η2);
  const cosξ = Math.cos(ξ2);
  const τ2 = Math.sin(ξ2) / Math.sqrt(sinhη * sinhη + cosξ * cosξ);
  const e = Math.sqrt(F * (2 - F));
  // τ aus τ′ iterativ (konvergiert in wenigen Schritten).
  let τ = τ2;
  for (let i = 0; i < 6; i++) {
    const σ = Math.sinh(e * Math.atanh((e * τ) / Math.sqrt(1 + τ * τ)));
    const τi = τ * Math.sqrt(1 + σ * σ) - σ * Math.sqrt(1 + τ * τ);
    const dτ =
      ((τ2 - τi) / Math.sqrt(1 + τi * τi)) *
      ((1 + (1 - e * e) * τ * τ) / ((1 - e * e) * Math.sqrt(1 + τ * τ)));
    τ += dτ;
    if (Math.abs(dτ) < 1e-12) break;
  }
  const φ = Math.atan(τ);
  const λ = Math.atan2(sinhη, cosξ);
  const λ0 = ((u.zone - 1) * 6 - 180 + 3) * RAD;
  const lat = φ / RAD;
  const lon = (λ + λ0) / RAD;
  return valid(lat, lon) ? { lat, lon } : null;
}

/** MGRS-Bestandteile → geografisch. */
function fromMgrsParts(
  zone: number,
  band: string,
  colLetter: string,
  rowLetter: string,
  east: number,
  north: number,
): Coords | null {
  const colLetters = COL_SETS[(zone - 1) % 3]!;
  const col = colLetters.indexOf(colLetter);
  if (col < 0) return null;
  const rowOffset = zone % 2 === 0 ? 5 : 0;
  let row = ROW_SET.indexOf(rowLetter);
  if (row < 0) return null;
  row = (row - rowOffset + 20) % 20;

  const easting = (col + 1) * 100_000 + east;
  // Das Breitenband legt fest, in welchem 2000-km-Block die Zeile liegt.
  const bandIndex = BANDS.indexOf(band);
  if (bandIndex < 0) return null;
  const approxLat = bandIndex * 8 - 80 + 4;
  const north0 = approxNorthing(approxLat);
  let northing = row * 100_000 + north;
  while (northing < north0 - 1_000_000) northing += 2_000_000;
  while (northing > north0 + 1_000_000) northing -= 2_000_000;

  return fromUtm({ zone, band, north: band >= 'N', easting, northing });
}

/** Grober Nordwert einer Breite — genügt, um den 2000-km-Block zu wählen. */
function approxNorthing(lat: number): number {
  const u = toUtm({ lat, lon: (Math.floor((lat + 0) / 1) % 6) * 0 + 9 });
  return u ? u.northing : 0;
}
