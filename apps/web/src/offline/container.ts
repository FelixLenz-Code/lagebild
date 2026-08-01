/**
 * Leser für die Offline-Pakete aus scripts/build-routing.mjs.
 *
 * Aufbau: "LGBLD\0" | Version u16 | Kopflänge u32 | Kopf (JSON) | Nutzlast.
 * Die Nutzlast ist eine Aneinanderreihung typisierter Felder; über sie werden
 * hier nur Sichten gelegt (kein Parsen, kein Kopieren).
 */

export const MAGIC = 'LGBLD\0';

export interface SectionInfo {
  name: string;
  type: 'i32' | 'u32' | 'u16' | 'i16' | 'u8';
  offset: number;
  length: number;
}

export interface ContainerHeader {
  meta: Record<string, unknown>;
  sections: Record<string, SectionInfo>;
  /** Byte-Offset, an dem die Nutzlast beginnt. */
  payloadStart: number;
  /** Nutzlast liegt gepackt vor (nur auf dem Server, nie im OPFS). */
  deflate: boolean;
  payloadBytes: number;
}

const dec = new TextDecoder();

/** Liest den Kopf aus den ersten Bytes einer Container-Datei. */
export function parseHeader(head: ArrayBuffer): ContainerHeader {
  const bytes = new Uint8Array(head);
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('Kein Lagebild-Paket');
  }
  const dv = new DataView(head);
  const headerLen = dv.getUint32(MAGIC.length + 2, true);
  const start = MAGIC.length + 2 + 4;
  const json = JSON.parse(dec.decode(bytes.subarray(start, start + headerLen))) as {
    sections: SectionInfo[];
    deflate?: boolean;
    payloadBytes: number;
  } & Record<string, unknown>;
  const sections: Record<string, SectionInfo> = {};
  for (const s of json.sections) sections[s.name] = s;
  const { sections: _drop, ...meta } = json;
  return {
    meta,
    sections,
    payloadStart: start + headerLen,
    deflate: json.deflate === true,
    payloadBytes: json.payloadBytes,
  };
}

/** Wie viele Bytes muss man mindestens lesen, um den Kopf zu bekommen? */
export const HEADER_PROBE_BYTES = 64 * 1024;

const CTORS = {
  i32: Int32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  i16: Int16Array,
  u8: Uint8Array,
} as const;

/** Ein geladenes Paket: Kopf plus Sichten auf die Abschnitte. */
export class Container {
  readonly meta: Record<string, unknown>;
  private readonly header: ContainerHeader;
  private readonly buffer: ArrayBuffer;

  constructor(header: ContainerHeader, buffer: ArrayBuffer) {
    this.header = header;
    this.meta = header.meta;
    this.buffer = buffer;
  }

  has(name: string): boolean {
    return name in this.header.sections;
  }

  /** Typisierte Sicht auf einen Abschnitt (ohne Kopie). */
  section<K extends keyof typeof CTORS>(name: string, type?: K): InstanceType<(typeof CTORS)[K]> {
    const info = this.header.sections[name];
    if (!info) throw new Error(`Abschnitt „${name}" fehlt`);
    const Ctor = CTORS[(type ?? info.type) as K];
    const start = this.header.payloadStart + info.offset;
    const count = Math.floor(info.length / Ctor.BYTES_PER_ELEMENT);
    // Der Kopf ist so aufgefüllt, dass die Nutzlast ausgerichtet liegt. Fällt
    // eine Datei doch einmal aus dem Raster, wird notfalls kopiert.
    if (start % Ctor.BYTES_PER_ELEMENT !== 0) {
      const copy = this.buffer.slice(start, start + count * Ctor.BYTES_PER_ELEMENT);
      return new Ctor(copy) as InstanceType<(typeof CTORS)[K]>;
    }
    return new Ctor(this.buffer, start, count) as InstanceType<(typeof CTORS)[K]>;
  }

  /** Byte-Bereich eines Abschnitts in der Gesamtdatei (für gezielte Lesezugriffe). */
  range(name: string): { start: number; length: number } {
    const info = this.header.sections[name];
    if (!info) throw new Error(`Abschnitt „${name}" fehlt`);
    return { start: this.header.payloadStart + info.offset, length: info.length };
  }
}

/** Zeichenkettentabelle aus Offsets + UTF-8-Bytes. */
export class StringTable {
  constructor(
    private readonly offsets: Uint32Array,
    private readonly bytes: Uint8Array,
  ) {}
  get(id: number): string | null {
    if (id === 0xffffffff || id + 1 >= this.offsets.length) return null;
    return dec.decode(this.bytes.subarray(this.offsets[id]!, this.offsets[id + 1]!));
  }
  get length(): number {
    return Math.max(0, this.offsets.length - 1);
  }
}

/** Fortlaufender Leser für ZigZag-/Varint-Bytefolgen (Geometrie, Adressen). */
export class VarintReader {
  pos: number;
  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }
  uint(): number {
    let result = 0;
    let shift = 1;
    let b: number;
    do {
      b = this.bytes[this.pos++]!;
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return result;
  }
  sint(): number {
    const n = this.uint();
    return n % 2 ? -(n + 1) / 2 : n / 2;
  }
  utf8(len: number): string {
    const s = dec.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}
