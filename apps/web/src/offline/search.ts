/**
 * Offline-Suche über den Index aus scripts/build-routing.mjs.
 *
 * Der Index enthält Orte, Straßen und POIs mit einer sortierten Begriffsliste
 * (Präfixsuche per binärer Suche) sowie die Hausnummern jeder Straße. Die
 * Hausnummernblöcke bleiben in der Datei liegen und werden erst gelesen, wenn
 * jemand tatsächlich nach einer Nummer sucht — sie machen den Löwenanteil des
 * Index aus.
 */

import type { Coords, GeoResult } from '@lagebild/shared';
import { Container, StringTable, VarintReader } from './container.js';
import { distanceM } from './graph.js';

/** Gleiche Normalisierung wie im Build (Umlaute, „str." → „strasse"). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/str\.(?=\s|$)/g, 'strasse')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ENTRY_KIND = ['place', 'street', 'poi'] as const;
export type EntryKind = (typeof ENTRY_KIND)[number];

export interface CategoryInfo {
  label: string;
  icon: string;
}

export interface HouseNumber {
  number: string;
  lat: number;
  lon: number;
}

const enc = new TextEncoder();

export class SearchIndex {
  readonly code: string;
  readonly categories: Record<string, CategoryInfo>;
  private readonly categoryKeys: string[];
  private readonly type: Uint8Array;
  private readonly cat: Uint8Array;
  private readonly lat: Int32Array;
  private readonly lon: Int32Array;
  private readonly nameId: Uint32Array;
  private readonly cityId: Uint32Array;
  private readonly addrOff: Uint32Array;
  private readonly addrCount: Uint32Array;
  private readonly strings: StringTable;
  private readonly termOff: Uint32Array;
  private readonly termBytes: Uint8Array;
  private readonly postOff: Uint32Array;
  private readonly postings: Uint32Array;
  private readonly addrRange: { start: number; length: number };
  private readonly readBytes: (start: number, length: number) => Promise<Uint8Array>;

  constructor(container: Container, readBytes: (start: number, length: number) => Promise<Uint8Array>) {
    this.code = String(container.meta.code ?? '');
    this.categories = (container.meta.categories as Record<string, CategoryInfo>) ?? {};
    this.categoryKeys = (container.meta.categoryKeys as string[]) ?? Object.keys(this.categories);
    this.type = container.section('entryType', 'u8');
    this.cat = container.section('entryCat', 'u8');
    this.lat = container.section('entryLat', 'i32');
    this.lon = container.section('entryLon', 'i32');
    this.nameId = container.section('entryName', 'u32');
    this.cityId = container.section('entryCity', 'u32');
    this.addrOff = container.section('entryAddrOff', 'u32');
    this.addrCount = container.section('entryAddrCount', 'u32');
    this.strings = new StringTable(container.section('strOff', 'u32'), container.section('strBytes', 'u8'));
    this.termOff = container.section('termOff', 'u32');
    this.termBytes = container.section('termBytes', 'u8');
    this.postOff = container.section('postOff', 'u32');
    this.postings = container.section('postings', 'u32');
    this.addrRange = container.range('addrBytes');
    this.readBytes = readBytes;
  }

  get entryCount(): number {
    return this.type.length;
  }
  get termCount(): number {
    return Math.max(0, this.termOff.length - 1);
  }

  /** Vergleicht den Begriff `i` mit `q`; nur die ersten q.length Bytes zählen. */
  private startsWith(i: number, q: Uint8Array): number {
    const start = this.termOff[i]!;
    const end = this.termOff[i + 1]!;
    const len = end - start;
    const n = Math.min(len, q.length);
    for (let k = 0; k < n; k++) {
      const d = this.termBytes[start + k]! - q[k]!;
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    if (len < q.length) return -1; // Begriff ist kürzer → liegt davor
    return 0; // Begriff beginnt mit q
  }

  /** Alle Einträge, deren Begriffe mit `prefix` beginnen. */
  private candidates(prefix: string, cap = 300000): Uint32Array | null {
    const q = enc.encode(prefix);
    if (!q.length) return null;
    let lo = 0;
    let hi = this.termCount - 1;
    let first = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.startsWith(mid, q);
      if (c < 0) lo = mid + 1;
      else {
        if (c === 0) first = mid;
        hi = mid - 1;
      }
    }
    if (first < 0) return null;
    const ids: number[] = [];
    for (let t = first; t < this.termCount && this.startsWith(t, q) === 0; t++) {
      const from = this.postOff[t]!;
      const to = this.postOff[t + 1]!;
      for (let p = from; p < to && ids.length < cap; p++) ids.push(this.postings[p]!);
      if (ids.length >= cap) break;
    }
    return Uint32Array.from(ids);
  }

  name(id: number): string {
    return this.strings.get(this.nameId[id]!) ?? '';
  }
  city(id: number): string | null {
    return this.strings.get(this.cityId[id]!);
  }
  kind(id: number): EntryKind {
    return ENTRY_KIND[this.type[id]!] ?? 'poi';
  }
  categoryKey(id: number): string {
    return this.categoryKeys[this.cat[id]!] ?? 'poi';
  }
  coords(id: number): Coords {
    return { lat: this.lat[id]! / 1e7, lon: this.lon[id]! / 1e7 };
  }

  /** Ein Eintrag als Suchergebnis. */
  private toResult(id: number, near?: Coords, houseNumber?: HouseNumber): GeoResult {
    const key = this.categoryKey(id);
    const info = this.categories[key];
    const city = this.city(id);
    const name = houseNumber ? `${this.name(id)} ${houseNumber.number}` : this.name(id);
    const lat = houseNumber ? houseNumber.lat : this.lat[id]! / 1e7;
    const lon = houseNumber ? houseNumber.lon : this.lon[id]! / 1e7;
    const kind = this.kind(id);
    const detailParts = [houseNumber ? 'Adresse' : kind === 'poi' ? (info?.label ?? null) : null, city];
    return {
      name,
      lat,
      lon,
      detail: detailParts.filter(Boolean).join(' · ') || null,
      category: houseNumber ? 'address' : key,
      source: 'offline',
      entryId: id,
      addressCount: this.addrCount[id] || 0,
      distanceM: near ? distanceM(near.lat, near.lon, lat, lon) : undefined,
    };
  }

  /**
   * Alle Einträge bestimmter Kategorien im Ausschnitt — z.B. Haltestellen für
   * die Kartenebene. Ein linearer Durchlauf über die typisierten Felder ist bei
   * ein paar hunderttausend Einträgen schnell genug (wenige Millisekunden).
   */
  inBbox(categories: string[], bbox: { west: number; south: number; east: number; north: number }, limit = 600): GeoResult[] {
    const wanted = new Set(
      categories.map((key) => this.categoryKeys.indexOf(key)).filter((i) => i >= 0),
    );
    if (!wanted.size) return [];
    const west = Math.round(bbox.west * 1e7);
    const east = Math.round(bbox.east * 1e7);
    const south = Math.round(bbox.south * 1e7);
    const north = Math.round(bbox.north * 1e7);
    const out: GeoResult[] = [];
    for (let id = 0; id < this.cat.length && out.length < limit; id++) {
      if (!wanted.has(this.cat[id]!)) continue;
      const lat = this.lat[id]!;
      const lon = this.lon[id]!;
      if (lat < south || lat > north || lon < west || lon > east) continue;
      out.push(this.toResult(id));
    }
    return out;
  }

  /** Hausnummern einer Straße (aus der Datei nachgeladen). */
  async houseNumbers(entryId: number): Promise<HouseNumber[]> {
    const count = this.addrCount[entryId] ?? 0;
    const off = this.addrOff[entryId]!;
    if (!count || off === 0xffffffff) return [];
    // Obergrenze je Adresse: Nummer (≤ 24 Byte) + zwei Varints.
    const length = Math.min(this.addrRange.length - off, count * 32 + 16);
    const bytes = await this.readBytes(this.addrRange.start + off, length);
    const r = new VarintReader(bytes, 0);
    const baseLat = this.lat[entryId]!;
    const baseLon = this.lon[entryId]!;
    const out: HouseNumber[] = [];
    for (let i = 0; i < count && r.pos < bytes.length; i++) {
      const len = r.uint();
      const number = r.utf8(len);
      const lat = (baseLat + r.sint()) / 1e7;
      const lon = (baseLon + r.sint()) / 1e7;
      out.push({ number, lat, lon });
    }
    return out;
  }

  /**
   * Sucht nach Orten, Straßen, POIs und (mit Nummer im Text) Adressen.
   * `near` sortiert die Treffer nach Nähe — ohne Bezugspunkt zählt nur die
   * Namensgüte.
   */
  async query(raw: string, near?: Coords, limit = 12): Promise<GeoResult[]> {
    const norm = normalize(raw);
    if (!norm) return [];
    const tokens = norm.split(' ').filter(Boolean);

    // Eine Hausnummer steckt als eigenes Wort im Text („hauptstrasse 12 b").
    let house: string | null = null;
    const textTokens: string[] = [];
    for (const t of tokens) {
      if (/^\d+[a-z]?$/.test(t) && textTokens.length > 0) house = house ? house + t : t;
      else textTokens.push(t);
    }
    if (!textTokens.length) return [];

    // Kandidaten je Wort, dann Schnittmenge über das kürzeste Ergebnis.
    const lists: Uint32Array[] = [];
    for (const t of textTokens) {
      const list = this.candidates(t);
      if (!list || !list.length) return [];
      lists.push(list);
    }
    lists.sort((a, b) => a.length - b.length);
    let ids = new Set<number>(lists[0]!);
    for (let i = 1; i < lists.length && ids.size; i++) {
      const other = new Set<number>(lists[i]!);
      const next = new Set<number>();
      for (const id of ids) if (other.has(id)) next.add(id);
      ids = next;
    }
    if (!ids.size) return [];

    const nameQuery = textTokens.join(' ');
    const scored: { id: number; score: number }[] = [];
    for (const id of ids) {
      const n = normalize(this.name(id));
      let score = 0;
      if (n === nameQuery) score += 60;
      else if (n.startsWith(nameQuery)) score += 40;
      else if (n.includes(nameQuery)) score += 20;
      // Orte vor Straßen vor Punkten — bei gleicher Namensgüte.
      const kind = this.type[id]!;
      score += kind === 0 ? 12 : kind === 1 ? 6 : 0;
      if (house && this.addrCount[id]) score += 25;
      if (near) {
        const km = distanceM(near.lat, near.lon, this.lat[id]! / 1e7, this.lon[id]! / 1e7) / 1000;
        score -= Math.log1p(km) * 9;
      }
      scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const out: GeoResult[] = [];
    for (const { id } of scored.slice(0, limit * 3)) {
      if (out.length >= limit) break;
      if (house && this.addrCount[id]) {
        const list = await this.houseNumbers(id);
        const hit =
          list.find((h) => normalize(h.number) === house) ??
          list.find((h) => normalize(h.number).startsWith(house!));
        if (hit) {
          out.push(this.toResult(id, near, hit));
          continue;
        }
      }
      out.push(this.toResult(id, near));
    }
    // Bei Hausnummer-Suche die Treffer mit Nummer nach vorn.
    if (house) out.sort((a, b) => (b.category === 'address' ? 1 : 0) - (a.category === 'address' ? 1 : 0));
    return out.slice(0, limit);
  }
}
