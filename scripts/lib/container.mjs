/**
 * Gemeinsames Dateiformat für die Offline-Pakete (Routing-Graph, Suchindex).
 *
 * Aufbau:
 *   "LGBLD\0" (6) | Version u16 | Kopflänge u32 | Kopf (JSON, UTF-8) | Nutzlast
 *
 * Der Kopf beschreibt die Abschnitte (Name, Typ, Offset in der Nutzlast,
 * Länge) und trägt frei belegbare Metadaten. Die Nutzlast besteht aus roh
 * aneinandergereihten typisierten Feldern (4-Byte-ausgerichtet) — der Browser
 * legt darüber direkt TypedArray-Sichten, ohne zu parsen.
 *
 * Auf dem Server liegt die Nutzlast deflate-gepackt (`deflate: true`); beim
 * Herunterladen entpackt der Browser sie einmalig und legt sie roh in den
 * OPFS. Dadurch bleibt der Download klein und der Start schnell — und die
 * Adressblöcke lassen sich später gezielt aus der Datei lesen.
 */

import { createWriteStream } from 'node:fs';
import { createDeflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const MAGIC = 'LGBLD\0';
export const FORMAT_VERSION = 1;

/** Typkürzel je TypedArray-Art. */
function typeOf(arr) {
  if (arr instanceof Int32Array) return 'i32';
  if (arr instanceof Uint32Array) return 'u32';
  if (arr instanceof Uint16Array) return 'u16';
  if (arr instanceof Int16Array) return 'i16';
  if (arr instanceof Uint8Array || Buffer.isBuffer(arr)) return 'u8';
  throw new Error('Nicht unterstützter Abschnittstyp');
}

/**
 * Schreibt einen Container.
 *
 * @param {string} path Zieldatei
 * @param {object} meta Metadaten für den Kopf (Format, Code, Bbox, Zähler …)
 * @param {Array<{name: string, data: ArrayBufferView}>} sections
 */
export async function writeContainer(path, meta, sections) {
  const entries = [];
  let offset = 0;
  const chunks = [];
  for (const s of sections) {
    const bytes = Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    entries.push({ name: s.name, type: typeOf(s.data), offset, length: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
  }

  // Der Kopf wird mit Leerzeichen aufgefüllt, bis die Nutzlast an einer
  // 4-Byte-Grenze beginnt — nur dann lassen sich im Browser TypedArray-Sichten
  // ohne Kopie darüberlegen.
  let json = JSON.stringify({ ...meta, deflate: true, payloadBytes: offset, sections: entries });
  const prefixLen = MAGIC.length + 2 + 4;
  while ((prefixLen + Buffer.byteLength(json, 'utf8')) % 4 !== 0) json += ' ';
  const header = Buffer.from(json, 'utf8');
  const prefix = Buffer.alloc(prefixLen);
  prefix.write(MAGIC, 0, 'latin1');
  prefix.writeUInt16LE(FORMAT_VERSION, MAGIC.length);
  prefix.writeUInt32LE(header.length, MAGIC.length + 2);

  const out = createWriteStream(path);
  out.write(prefix);
  out.write(header);
  await pipeline(Readable.from(chunks), createDeflateRaw({ level: 6 }), out, { end: true });
  return { headerBytes: prefix.length + header.length, payloadBytes: offset };
}

/** Wachsende typisierte Liste (verdoppelt bei Bedarf). */
export class Growable {
  constructor(Type, initial = 1024) {
    this.Type = Type;
    this.data = new Type(initial);
    this.length = 0;
  }
  push(v) {
    if (this.length === this.data.length) {
      const next = new this.Type(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  get(i) {
    return this.data[i];
  }
  set(i, v) {
    this.data[i] = v;
  }
  /** Beschnittene Sicht auf die belegten Elemente. */
  view() {
    return this.data.subarray(0, this.length);
  }
}

/** Zeichenketten-Ablage mit Deduplizierung. */
export class StringPool {
  constructor() {
    this.map = new Map();
    this.list = [];
    this.bytes = 0;
  }
  /** Gibt die ID zurück; 0xffffffff steht überall für „keine". */
  intern(s) {
    if (s == null || s === '') return 0xffffffff;
    const hit = this.map.get(s);
    if (hit !== undefined) return hit;
    const id = this.list.length;
    this.map.set(s, id);
    this.list.push(s);
    this.bytes += Buffer.byteLength(s, 'utf8');
    return id;
  }
  get(id) {
    return id === 0xffffffff ? null : this.list[id];
  }
  /** Serialisiert zu Offset-Tabelle (n+1 Einträge) und Byteblock. */
  serialize() {
    const offsets = new Uint32Array(this.list.length + 1);
    const bytes = Buffer.allocUnsafe(this.bytes);
    let pos = 0;
    for (let i = 0; i < this.list.length; i++) {
      offsets[i] = pos;
      pos += bytes.write(this.list[i], pos, 'utf8');
    }
    offsets[this.list.length] = pos;
    return { offsets, bytes };
  }
}

/** ZigZag-Varint in eine wachsende Bytefolge schreiben. */
export function writeSVarint(out, value) {
  let v = value < 0 ? -value * 2 - 1 : value * 2;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** Vorzeichenloses Varint. */
export function writeVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}
