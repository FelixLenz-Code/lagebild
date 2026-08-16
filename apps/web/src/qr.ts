/**
 * QR-Code erzeugen — selbst gerechnet, ohne Bibliothek.
 *
 * Warum überhaupt: Zwei Geräte sollen eine Lage austauschen können, **ohne Netz
 * und ohne Server** — das eine zeigt, das andere liest ab. Ein QR-Code ist dafür
 * das einzige Mittel, das ohne Kopplung, ohne Konto und ohne Funk auskommt.
 *
 * Umfang: Byte-Modus (UTF-8), Versionen 1 bis 20, Fehlerkorrektur L bis Q. Das
 * genügt für Links und kleine Datenpakete; alles Größere gehört ohnehin nicht
 * auf einen Bildschirm zum Abfotografieren.
 *
 * Aufbau nach ISO/IEC 18004: Daten kodieren, Reed-Solomon-Blöcke anhängen,
 * verschachteln, ins Raster schreiben, acht Masken durchprobieren und die mit
 * der geringsten Strafpunktzahl behalten.
 */

export type EccLevel = 'L' | 'M' | 'Q';

/** Zahl der Datenwörter und RS-Blöcke je Version und Stufe. */
interface Spec {
  /** Datenwörter insgesamt. */
  data: number;
  /** Fehlerkorrekturwörter je Block. */
  ecPerBlock: number;
  /** Blockzahl in Gruppe 1 und 2 (Gruppe 2 hat ein Datenwort mehr). */
  g1: number;
  g2: number;
}

/**
 * Tabelle aus der Norm, auf die Stufen L/M/Q und die Versionen 1–20 gekürzt.
 * Reihenfolge je Version: [Datenwörter, EC je Block, Blöcke G1, Blöcke G2].
 */
const SPECS: Record<EccLevel, [number, number, number, number][]> = {
  L: [
    [19, 7, 1, 0], [34, 10, 1, 0], [55, 15, 1, 0], [80, 20, 1, 0], [108, 26, 1, 0],
    [136, 18, 2, 0], [156, 20, 2, 0], [194, 24, 2, 0], [232, 30, 2, 0], [274, 18, 2, 2],
    [324, 20, 4, 0], [370, 24, 2, 2], [428, 26, 4, 0], [461, 30, 3, 1], [523, 22, 5, 1],
    [589, 24, 5, 1], [647, 28, 1, 5], [721, 30, 5, 1], [795, 28, 3, 4], [861, 28, 3, 5],
  ],
  M: [
    [16, 10, 1, 0], [28, 16, 1, 0], [44, 26, 1, 0], [64, 18, 2, 0], [86, 24, 2, 0],
    [108, 16, 4, 0], [124, 18, 4, 0], [154, 22, 2, 2], [182, 22, 3, 2], [216, 26, 4, 1],
    [254, 30, 1, 4], [290, 22, 6, 2], [334, 22, 8, 1], [365, 24, 4, 5], [415, 24, 5, 5],
    [453, 28, 7, 3], [507, 28, 10, 1], [563, 26, 9, 4], [627, 26, 3, 11], [669, 26, 3, 13],
  ],
  Q: [
    [13, 13, 1, 0], [22, 22, 1, 0], [34, 18, 2, 0], [48, 26, 2, 0], [62, 18, 2, 2],
    [76, 24, 4, 0], [88, 18, 2, 4], [110, 22, 4, 2], [132, 20, 4, 4], [154, 24, 6, 2],
    [180, 28, 4, 4], [206, 26, 4, 6], [244, 24, 8, 4], [261, 20, 11, 5], [295, 30, 5, 7],
    [325, 24, 15, 2], [367, 28, 1, 15], [397, 28, 17, 1], [445, 26, 17, 4], [485, 30, 15, 5],
  ],
};

/** Lage der Ausrichtungsmuster je Version (Zeilen-/Spaltenmitten). */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const ECC_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00, Q: 0b11 };

/* --- Galois-Feld GF(256) mit dem QR-Polynom 0x11D --- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** Generatorpolynom für `n` Fehlerkorrekturwörter. */
function generator(n: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon-Reste eines Datenblocks. */
function ecBytes(block: Uint8Array, count: number): Uint8Array {
  const gen = generator(count);
  const out = new Uint8Array(count);
  for (const byte of block) {
    const factor = byte ^ out[0]!;
    out.copyWithin(0, 1);
    out[count - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < count; i++) out[i] ^= mul(gen[i + 1]!, factor);
    }
  }
  return out;
}

/** Anzahl der Bits des Längenfelds im Byte-Modus. */
const lengthBits = (version: number) => (version < 10 ? 8 : 16);

class BitWriter {
  readonly bits: number[] = [];
  push(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
}

/** Kleinste Version, in die die Nutzlast passt. */
function pickVersion(byteLength: number, ecc: EccLevel): number | null {
  for (let v = 1; v <= 20; v++) {
    const spec = SPECS[ecc][v - 1]!;
    const capacityBits = spec[0] * 8 - 4 - lengthBits(v);
    if (byteLength * 8 <= capacityBits) return v;
  }
  return null;
}

/** Fertiges Rastermodell: `true` = dunkel. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
  version: number;
  ecc: EccLevel;
  /** Gewählte Maske (0–7) — steht in der Formatinformation. */
  mask: number;
}

export function encodeQr(text: string, ecc: EccLevel = 'M'): QrMatrix | null {
  const payload = new TextEncoder().encode(text);
  const version = pickVersion(payload.length, ecc);
  if (!version) return null;
  const [dataWords, ecPerBlock, g1, g2] = SPECS[ecc][version - 1]!;
  const spec: Spec = { data: dataWords, ecPerBlock, g1, g2 };

  /* --- Bitstrom: Modus, Länge, Daten, Abschluss, Auffüllung --- */
  const bw = new BitWriter();
  bw.push(0b0100, 4);
  bw.push(payload.length, lengthBits(version));
  for (const b of payload) bw.push(b, 8);
  const capacityBits = spec.data * 8;
  bw.push(0, Math.min(4, capacityBits - bw.bits.length));
  while (bw.bits.length % 8 !== 0) bw.bits.push(0);
  const bytes = new Uint8Array(spec.data);
  for (let i = 0; i < bw.bits.length / 8; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bw.bits[i * 8 + j]!;
    bytes[i] = v;
  }
  // Auffüllbytes wechseln sich ab — so will es die Norm.
  for (let i = Math.ceil(bw.bits.length / 8), pad = 0; i < spec.data; i++, pad++) {
    bytes[i] = pad % 2 === 0 ? 0xec : 0x11;
  }

  /* --- In Blöcke teilen, Fehlerkorrektur anhängen, verschachteln --- */
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  const totalBlocks = spec.g1 + spec.g2;
  const shortLen = Math.floor(spec.data / totalBlocks);
  let offset = 0;
  for (let i = 0; i < totalBlocks; i++) {
    const len = i < spec.g1 ? shortLen : shortLen + 1;
    const data = bytes.slice(offset, offset + len);
    offset += len;
    blocks.push({ data, ec: ecBytes(data, spec.ecPerBlock) });
  }
  const stream: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) stream.push(b.data[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const b of blocks) stream.push(b.ec[i]!);
  }

  /* --- Raster aufbauen --- */
  const size = version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null),
  );
  const set = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && c >= 0 && r < size && c < size) modules[r]![c] = dark;
  };

  // Suchmuster mit ihrem hellen Rand.
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(r0 + r, c0 + c, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Taktmuster.
  for (let i = 8; i < size - 8; i++) {
    if (modules[6]![i] == null) modules[6]![i] = i % 2 === 0;
    if (modules[i]![6] == null) modules[i]![6] = i % 2 === 0;
  }

  // Ausrichtungsmuster (nicht über die Suchmuster).
  for (const r of ALIGN[version - 1]!) {
    for (const c of ALIGN[version - 1]!) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Immer dunkel, und die Felder der Formatinformation freihalten.
  set(size - 8, 8, true);
  // Die fünfzehn Bits der Formatinformation stehen zweimal im Code: einmal um
  // das linke obere Suchmuster herum, einmal verteilt auf die beiden anderen.
  // Bit 0 ist dabei das niederwertigste.
  const formatCells: [number, number][] = [];
  for (let i = 0; i < 15; i++) {
    const a: [number, number] =
      i < 6 ? [8, i] : i === 6 ? [8, 7] : i === 7 ? [8, 8] : i === 8 ? [7, 8] : [14 - i, 8];
    const b: [number, number] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i];
    formatCells.push(a, b);
    if (modules[a[0]]![a[1]] == null) modules[a[0]]![a[1]] = false;
    if (modules[b[0]]![b[1]] == null) modules[b[0]]![b[1]] = false;
  }
  // Versionsinformation ab Version 7.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      modules[r]![c] = dark;
      modules[c]![r] = dark;
    }
  }

  /* --- Daten im Zickzack von rechts unten nach links oben --- */
  let bitIndex = 0;
  const nextBit = (): boolean => {
    const byte = stream[bitIndex >> 3];
    const bit = byte == null ? false : ((byte >> (7 - (bitIndex & 7))) & 1) === 1;
    bitIndex++;
    return bit;
  };
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // die Taktspalte wird übersprungen
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (modules[row]![col] != null) continue;
        modules[row]![col] = nextBit();
      }
    }
    upward = !upward;
  }

  /* --- Masken durchprobieren --- */
  const maskFn: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const isFunction = (r: number, c: number): boolean => {
    if (r === 6 || c === 6) return true;
    if (r < 9 && c < 9) return true;
    // Rechts oben: Suchmuster mit Trennlinie über acht Zeilen, darunter aber
    // nur sieben Formatmodule — die achte Stelle (8, size−8) trägt Daten. Wer
    // sie hier als Funktionsfläche zählt, verschiebt den ganzen Bitstrom.
    if (r < 8 && c >= size - 8) return true;
    if (r === 8 && c >= size - 7) return true;
    if (r >= size - 8 && c < 9) return true;
    if (version >= 7 && ((r < 6 && c >= size - 11) || (c < 6 && r >= size - 11))) return true;
    for (const ar of ALIGN[version - 1]!) {
      for (const ac of ALIGN[version - 1]!) {
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
        if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
      }
    }
    return false;
  };

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const grid = modules.map((row, r) =>
      row.map((v, c) => (v ?? false) !== (!isFunction(r, c) && maskFn[mask]!(r, c))),
    );
    // Formatinformation dieser Maske eintragen (BCH(15,5) mit Maske 0x5412).
    const fmt = (ECC_BITS[ecc] << 3) | mask;
    let rem = fmt;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const bits = ((fmt << 10) | rem) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const [ar, ac] = formatCells[i * 2]!;
      const [br, bc] = formatCells[i * 2 + 1]!;
      grid[ar]![ac] = dark;
      grid[br]![bc] = dark;
    }
    grid[size - 8]![8] = true;

    const score = penalty(grid, size);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
      bestMask = mask;
    }
  }
  return best ? { size, modules: best, version, ecc, mask: bestMask } : null;
}

/** Strafpunkte nach der Norm — je weniger, desto besser lesbar. */
function penalty(grid: boolean[][], size: number): number {
  let score = 0;
  // Regel 1: Reihen gleicher Farbe.
  for (let i = 0; i < size; i++) {
    for (const line of [grid[i]!, grid.map((row) => row[i]!)]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Regel 2: gleichfarbige 2×2-Blöcke.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }
  // Regel 3: Muster, das dem Suchmuster ähnelt.
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = [...pattern].reverse();
  const matches = (line: boolean[], at: number, pat: boolean[]) =>
    pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < size; i++) {
    const row = grid[i]!;
    const col = grid.map((r) => r[i]!);
    for (const line of [row, col]) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matches(line, j, pattern) || matches(line, j, rev)) score += 40;
      }
    }
  }
  // Regel 4: Verhältnis dunkler Felder.
  let dark = 0;
  for (const row of grid) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Den Code als SVG-Pfad ausgeben (scharf in jeder Größe, auch gedruckt). */
export function qrToSvgPath(qr: QrMatrix): string {
  const parts: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]![c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return parts.join('');
}
