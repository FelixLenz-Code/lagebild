/**
 * Minimaler Leser für OSM-PBF-Dateien (Geofabrik-Extrakte).
 *
 * Bewusst ohne Abhängigkeiten: das Format ist überschaubar und der Build soll
 * mit einem nackten Node laufen. Aufbau einer .osm.pbf-Datei:
 *
 *   [4 Byte Länge BE][BlobHeader][Blob] … wiederholt bis Dateiende
 *
 * BlobHeader nennt Typ ('OSMHeader' | 'OSMData') und Blob-Länge; der Blob
 * enthält die Nutzdaten roh oder zlib-gepackt. Ein Datenblob ist ein
 * PrimitiveBlock mit Zeichenkettentabelle und Gruppen aus Knoten (meist
 * „dense", delta-kodiert), Wegen und Relationen.
 *
 * Zahlen werden als JS-Number gelesen (exakt bis 2^53 — OSM-IDs liegen weit
 * darunter), Varints ohne BigInt.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ */
/* Protobuf-Grundlagen                                                 */
/* ------------------------------------------------------------------ */

/** Leserzustand über einem Buffer. */
function reader(buf, start = 0, end = buf.length) {
  return { buf, p: start, end };
}

/** Varint als Number (Multiplikation statt Shift — hält über 32 Bit). */
function varint(r) {
  const buf = r.buf;
  let result = 0;
  let shift = 1;
  let b;
  do {
    b = buf[r.p++];
    result += (b & 0x7f) * shift;
    shift *= 128;
  } while (b & 0x80);
  return result;
}

/** ZigZag-Dekodierung für sint32/sint64 (auch jenseits von 32 Bit korrekt). */
function zigzag(n) {
  return n % 2 ? -(n + 1) / 2 : n / 2;
}

/** Überspringt ein Feld anhand seines Drahttyps. */
function skip(r, wire) {
  switch (wire) {
    case 0:
      varint(r);
      break;
    case 1:
      r.p += 8;
      break;
    case 2:
      r.p += varint(r);
      break;
    case 5:
      r.p += 4;
      break;
    default:
      throw new Error(`Unbekannter Protobuf-Drahttyp ${wire}`);
  }
}

/** Liest ein längenbegrenztes Feld und gibt seinen Bereich zurück. */
function slice(r) {
  const len = varint(r);
  const start = r.p;
  r.p += len;
  return { start, end: r.p };
}

/** Packed varints in ein Array (mit ZigZag, wenn gewünscht). */
function packed(buf, start, end, sint, out) {
  const r = reader(buf, start, end);
  while (r.p < end) {
    const v = varint(r);
    out.push(sint ? zigzag(v) : v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Blob-Ebene                                                          */
/* ------------------------------------------------------------------ */

function parseBlobHeader(buf) {
  const r = reader(buf);
  let type = '';
  let datasize = 0;
  while (r.p < r.end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const s = slice(r);
      type = buf.toString('utf8', s.start, s.end);
    } else if (field === 3 && wire === 0) {
      datasize = varint(r);
    } else {
      skip(r, wire);
    }
  }
  return { type, datasize };
}

function decodeBlob(buf) {
  const r = reader(buf);
  let raw = null;
  let zlibData = null;
  while (r.p < r.end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) {
      const s = slice(r);
      raw = buf.subarray(s.start, s.end);
    } else if (field === 3 && wire === 2) {
      const s = slice(r);
      zlibData = buf.subarray(s.start, s.end);
    } else {
      skip(r, wire);
    }
  }
  if (raw) return raw;
  if (zlibData) return inflateSync(zlibData);
  throw new Error('Blob-Kompression nicht unterstützt (nur roh oder zlib).');
}

/* ------------------------------------------------------------------ */
/* PrimitiveBlock                                                      */
/* ------------------------------------------------------------------ */

function parseStringTable(buf, start, end) {
  const r = reader(buf, start, end);
  const out = [];
  while (r.p < end) {
    const key = varint(r);
    const wire = key & 7;
    if (key >>> 3 === 1 && wire === 2) {
      const s = slice(r);
      out.push(buf.toString('utf8', s.start, s.end));
    } else {
      skip(r, wire);
    }
  }
  return out;
}

/** Tags eines Elements aus parallelen keys/vals-Listen. */
function tagsOf(strings, keys, vals) {
  const tags = {};
  for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
  return tags;
}

function parseDenseNodes(buf, start, end, block, handlers) {
  const r = reader(buf, start, end);
  const ids = [];
  const lats = [];
  const lons = [];
  let kvStart = 0;
  let kvEnd = 0;
  while (r.p < end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire !== 2) {
      skip(r, wire);
      continue;
    }
    const s = slice(r);
    if (field === 1) packed(buf, s.start, s.end, true, ids);
    else if (field === 8) packed(buf, s.start, s.end, true, lats);
    else if (field === 9) packed(buf, s.start, s.end, true, lons);
    else if (field === 10) {
      kvStart = s.start;
      kvEnd = s.end;
    }
  }

  // keys_vals: je Knoten Paare (key, val), abgeschlossen durch 0.
  const kv = reader(buf, kvStart, kvEnd);
  const { strings, granularity, latOffset, lonOffset } = block;
  let id = 0;
  let lat = 0;
  let lon = 0;
  const onNode = handlers.node;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i];
    lat += lats[i];
    lon += lons[i];
    let tags = null;
    if (kvStart !== kvEnd) {
      // Auch ohne Tag-Bedarf muss der Zeiger weiterlaufen (0 = Ende des Knotens).
      while (kv.p < kvEnd) {
        const k = varint(kv);
        if (k === 0) break;
        const v = varint(kv);
        if (tags === null) tags = {};
        tags[strings[k]] = strings[v];
      }
    }
    if (onNode) {
      onNode(id, (latOffset + granularity * lat) / 1e9, (lonOffset + granularity * lon) / 1e9, tags);
    }
  }
}

function parseWay(buf, start, end, block, handlers) {
  const r = reader(buf, start, end);
  let id = 0;
  const keys = [];
  const vals = [];
  const refs = [];
  while (r.p < end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 0) {
      id = varint(r);
      continue;
    }
    if (wire !== 2) {
      skip(r, wire);
      continue;
    }
    const s = slice(r);
    if (field === 2) packed(buf, s.start, s.end, false, keys);
    else if (field === 3) packed(buf, s.start, s.end, false, vals);
    else if (field === 8) packed(buf, s.start, s.end, true, refs);
  }
  // refs sind delta-kodiert.
  let ref = 0;
  for (let i = 0; i < refs.length; i++) {
    ref += refs[i];
    refs[i] = ref;
  }
  handlers.way(id, refs, tagsOf(block.strings, keys, vals));
}

function parseRelation(buf, start, end, block, handlers) {
  const r = reader(buf, start, end);
  let id = 0;
  const keys = [];
  const vals = [];
  const roles = [];
  const memids = [];
  const types = [];
  while (r.p < end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 0) {
      id = varint(r);
      continue;
    }
    if (wire !== 2) {
      skip(r, wire);
      continue;
    }
    const s = slice(r);
    if (field === 2) packed(buf, s.start, s.end, false, keys);
    else if (field === 3) packed(buf, s.start, s.end, false, vals);
    else if (field === 8) packed(buf, s.start, s.end, false, roles);
    else if (field === 9) packed(buf, s.start, s.end, true, memids);
    else if (field === 10) packed(buf, s.start, s.end, false, types);
  }
  let mem = 0;
  const members = [];
  for (let i = 0; i < memids.length; i++) {
    mem += memids[i];
    members.push({ ref: mem, type: types[i], role: block.strings[roles[i]] ?? '' });
  }
  handlers.relation(id, members, tagsOf(block.strings, keys, vals));
}

function parseGroup(buf, start, end, block, handlers) {
  const r = reader(buf, start, end);
  while (r.p < end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire !== 2) {
      skip(r, wire);
      continue;
    }
    const s = slice(r);
    if (field === 2 && handlers.node) parseDenseNodes(buf, s.start, s.end, block, handlers);
    else if (field === 3 && handlers.way) parseWay(buf, s.start, s.end, block, handlers);
    else if (field === 4 && handlers.relation) parseRelation(buf, s.start, s.end, block, handlers);
    // Feld 1 (einzelne Knoten ohne dense) kommt in Geofabrik-Dateien nicht vor.
  }
}

function parseBlock(buf, handlers) {
  // Erst die Kopfdaten (Granularität steht hinter den Gruppen), dann die Gruppen.
  const r = reader(buf);
  const groups = [];
  const block = { strings: [], granularity: 100, latOffset: 0, lonOffset: 0 };
  while (r.p < r.end) {
    const key = varint(r);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 2) {
      const s = slice(r);
      if (field === 1) block.strings = parseStringTable(buf, s.start, s.end);
      else if (field === 2) groups.push(s);
    } else if (wire === 0) {
      const v = varint(r);
      if (field === 17) block.granularity = v;
      else if (field === 19) block.latOffset = v;
      else if (field === 20) block.lonOffset = v;
    } else {
      skip(r, wire);
    }
  }
  for (const g of groups) parseGroup(buf, g.start, g.end, block, handlers);
}

/* ------------------------------------------------------------------ */
/* Öffentliche Schnittstelle                                           */
/* ------------------------------------------------------------------ */

/**
 * Liest eine PBF-Datei einmal durch und ruft die übergebenen Handler auf.
 * Nicht gesetzte Handler werden übersprungen (spart beim Wege-Durchlauf das
 * Auspacken der Knotenlisten nicht, aber deren Dekodierung — der teure Teil).
 *
 * @param {string} path Pfad zur .osm.pbf
 * @param {{ node?: Function, way?: Function, relation?: Function, progress?: (f:number)=>void }} handlers
 */
export function readPbf(path, handlers) {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  const lenBuf = Buffer.allocUnsafe(4);
  let pos = 0;
  let lastReport = 0;
  try {
    while (pos + 4 <= size) {
      readSync(fd, lenBuf, 0, 4, pos);
      pos += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      const headerBuf = Buffer.allocUnsafe(headerLen);
      readSync(fd, headerBuf, 0, headerLen, pos);
      pos += headerLen;
      const { type, datasize } = parseBlobHeader(headerBuf);
      const blobBuf = Buffer.allocUnsafe(datasize);
      readSync(fd, blobBuf, 0, datasize, pos);
      pos += datasize;
      if (type === 'OSMData') parseBlock(decodeBlob(blobBuf), handlers);
      if (handlers.progress && pos - lastReport > 16 * 1024 * 1024) {
        lastReport = pos;
        handlers.progress(pos / size);
      }
    }
  } finally {
    closeSync(fd);
  }
  if (handlers.progress) handlers.progress(1);
}
