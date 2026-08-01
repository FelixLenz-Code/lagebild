/**
 * Der Routing-Graph im Speicher: typisierte Sichten auf die Paketdatei plus
 * zwei beim Laden erzeugte Hilfsstrukturen — die Nachbarschaftsliste (CSR) und
 * ein Gitter für „welcher Knoten liegt hier in der Nähe?".
 *
 * Beides wird bewusst nicht mitgeliefert, sondern gerechnet: es dauert unter
 * einer Sekunde und spart bei großen Ländern zweistellige Megabyte im Download.
 *
 * Mehrere Regionen lassen sich mit `mergeGraphs` zu einem Netz verbinden —
 * die Auszüge überlappen an den Landesgrenzen, dort liegen dieselben Knoten mit
 * identischen Koordinaten in beiden Dateien.
 */

import { Container, StringTable, VarintReader } from './container.js';

/** Kantenmerkmale — identisch zu FLAG in scripts/lib/osmtags.mjs. */
export const FLAG = {
  CAR_F: 1,
  CAR_B: 2,
  BIKE_F: 4,
  BIKE_B: 8,
  FOOT_F: 16,
  FOOT_B: 32,
  ROUNDABOUT: 64,
  LINK: 128,
} as const;

/** Straßenklassen — Index entspricht ROAD_CLASSES im Build-Skript. */
export const CLASS = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  unclassified: 5,
  residential: 6,
  living_street: 7,
  service: 8,
  pedestrian: 9,
  track: 10,
  path: 11,
  footway: 12,
  cycleway: 13,
  steps: 14,
  ferry: 15,
} as const;

/** Abbiegeverbote: Bit 0/1 = gilt für Auto/Rad, Bit 7 = „nur diese Richtung". */
export const RESTRICTION = { CAR: 1, BIKE: 2, ONLY: 128 } as const;

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

/** Entfernung in Metern (Haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Zugriff auf Straßennamen (eine Datei oder mehrere zusammengesetzte). */
export interface Names {
  get(id: number): string | null;
}

/** Namenstabellen mehrerer Regionen hintereinander. */
class JoinedNames implements Names {
  constructor(private readonly parts: { start: number; table: Names }[]) {}
  get(id: number): string | null {
    if (id === 0xffffffff) return null;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      if (id >= p.start) return p.table.get(id - p.start);
    }
    return null;
  }
}

/** Rohdaten eines Graphen — aus einer Datei gelesen oder zusammengesetzt. */
export interface GraphData {
  meta: Record<string, unknown>;
  nodes: Int32Array;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  edgeLen: Uint32Array;
  edgeFlags: Uint8Array;
  edgeClass: Uint8Array;
  edgeSpeed: Uint8Array;
  edgeName: Uint32Array;
  edgeGeomOff: Uint32Array;
  edgeGeomLen: Uint16Array;
  geom: Uint8Array;
  names: Names;
  restrFrom: Uint32Array;
  restrTo: Uint32Array;
  restrVia: Uint32Array;
  restrFlags: Uint8Array;
  /** Anzahl der Einträge in der Namenstabelle (fürs Zusammenführen). */
  nameCount: number;
}

/** Ein einzelnes Abbiegeverbot am Knoten. */
export interface Restriction {
  from: number;
  to: number;
  flags: number;
}

export class RouteGraph {
  readonly meta: Record<string, unknown>;
  readonly nodes: Int32Array;
  readonly edgeA: Uint32Array;
  readonly edgeB: Uint32Array;
  readonly edgeLen: Uint32Array;
  readonly edgeFlags: Uint8Array;
  readonly edgeClass: Uint8Array;
  readonly edgeSpeed: Uint8Array;
  readonly edgeName: Uint32Array;
  readonly edgeGeomOff: Uint32Array;
  readonly edgeGeomLen: Uint16Array;
  readonly geom: Uint8Array;
  readonly names: Names;
  readonly nameCount: number;

  readonly nodeCount: number;
  readonly edgeCount: number;

  /** Nachbarschaft: arcEdge[arcOff[n] … arcOff[n+1]) sind die Kanten an Knoten n. */
  readonly arcOff: Uint32Array;
  readonly arcEdge: Uint32Array;

  /** Abbiegeverbote, nach dem Knoten gruppiert, an dem sie greifen. */
  private readonly restrictions: Map<number, Restriction[]>;
  readonly restrictionCount: number;

  /** Gitter über die Knoten (Zellen zeilenweise). */
  private readonly gridOff: Uint32Array;
  private readonly gridNodes: Uint32Array;
  private readonly minLat: number;
  private readonly minLon: number;
  private readonly cellLat: number;
  private readonly cellLon: number;
  private readonly rows: number;
  private readonly cols: number;

  static fromContainer(container: Container): RouteGraph {
    const optional = (name: string, type: 'u32' | 'u8') =>
      container.has(name) ? container.section(name, type) : null;
    const names = new StringTable(
      container.section('nameOff', 'u32'),
      container.section('nameBytes', 'u8'),
    );
    return new RouteGraph({
      meta: container.meta,
      nodes: container.section('nodes', 'i32'),
      edgeA: container.section('edgeA', 'u32'),
      edgeB: container.section('edgeB', 'u32'),
      edgeLen: container.section('edgeLen', 'u32'),
      edgeFlags: container.section('edgeFlags', 'u8'),
      edgeClass: container.section('edgeClass', 'u8'),
      edgeSpeed: container.section('edgeSpeed', 'u8'),
      edgeName: container.section('edgeName', 'u32'),
      edgeGeomOff: container.section('edgeGeomOff', 'u32'),
      edgeGeomLen: container.section('edgeGeomLen', 'u16'),
      geom: container.section('geom', 'u8'),
      names,
      restrFrom: (optional('restrFrom', 'u32') as Uint32Array) ?? new Uint32Array(0),
      restrTo: (optional('restrTo', 'u32') as Uint32Array) ?? new Uint32Array(0),
      restrVia: (optional('restrVia', 'u32') as Uint32Array) ?? new Uint32Array(0),
      restrFlags: (optional('restrFlags', 'u8') as Uint8Array) ?? new Uint8Array(0),
      nameCount: names.length,
    });
  }

  constructor(data: GraphData) {
    this.meta = data.meta;
    this.nodes = data.nodes;
    this.edgeA = data.edgeA;
    this.edgeB = data.edgeB;
    this.edgeLen = data.edgeLen;
    this.edgeFlags = data.edgeFlags;
    this.edgeClass = data.edgeClass;
    this.edgeSpeed = data.edgeSpeed;
    this.edgeName = data.edgeName;
    this.edgeGeomOff = data.edgeGeomOff;
    this.edgeGeomLen = data.edgeGeomLen;
    this.geom = data.geom;
    this.names = data.names;
    this.nameCount = data.nameCount;
    this.nodeCount = this.nodes.length / 2;
    this.edgeCount = this.edgeA.length;

    // --- Nachbarschaftsliste (Zählsortierung) ---
    const counts = new Uint32Array(this.nodeCount + 1);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edgeA[e]!;
      const b = this.edgeB[e]!;
      if (a === b) continue; // Schleife auf sich selbst bringt nichts
      counts[a]!++;
      counts[b]!++;
    }
    const arcOff = new Uint32Array(this.nodeCount + 1);
    let sum = 0;
    for (let n = 0; n < this.nodeCount; n++) {
      arcOff[n] = sum;
      sum += counts[n]!;
    }
    arcOff[this.nodeCount] = sum;
    const fill = arcOff.slice();
    const arcEdge = new Uint32Array(sum);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edgeA[e]!;
      const b = this.edgeB[e]!;
      if (a === b) continue;
      arcEdge[fill[a]!++] = e;
      arcEdge[fill[b]!++] = e;
    }
    this.arcOff = arcOff;
    this.arcEdge = arcEdge;

    // --- Abbiegeverbote nach Knoten gruppieren ---
    this.restrictions = new Map();
    for (let i = 0; i < data.restrVia.length; i++) {
      const via = data.restrVia[i]!;
      let list = this.restrictions.get(via);
      if (!list) this.restrictions.set(via, (list = []));
      list.push({ from: data.restrFrom[i]!, to: data.restrTo[i]!, flags: data.restrFlags[i]! });
    }
    this.restrictionCount = data.restrVia.length;

    // --- Gitter für die Nächster-Punkt-Suche (~600 m Kantenlänge) ---
    const bbox = (this.meta.bbox as number[]) ?? [5.8, 47.2, 15.1, 55.1];
    this.minLon = bbox[0]!;
    this.minLat = bbox[1]!;
    const spanLon = Math.max(0.01, bbox[2]! - bbox[0]!);
    const spanLat = Math.max(0.01, bbox[3]! - bbox[1]!);
    this.cellLat = 0.0055;
    this.cellLon = 0.0055 / Math.max(0.3, Math.cos(((bbox[1]! + bbox[3]!) / 2) * RAD));
    this.rows = Math.ceil(spanLat / this.cellLat) + 1;
    this.cols = Math.ceil(spanLon / this.cellLon) + 1;
    const cells = this.rows * this.cols;
    const cellCount = new Uint32Array(cells + 1);
    const cellOfNode = new Uint32Array(this.nodeCount);
    for (let n = 0; n < this.nodeCount; n++) {
      const c = this.cellOf(this.nodes[n * 2]! / 1e7, this.nodes[n * 2 + 1]! / 1e7);
      cellOfNode[n] = c;
      cellCount[c]!++;
    }
    const gridOff = new Uint32Array(cells + 1);
    let acc = 0;
    for (let c = 0; c < cells; c++) {
      gridOff[c] = acc;
      acc += cellCount[c]!;
    }
    gridOff[cells] = acc;
    const gridFill = gridOff.slice();
    const gridNodes = new Uint32Array(this.nodeCount);
    for (let n = 0; n < this.nodeCount; n++) gridNodes[gridFill[cellOfNode[n]!]!++] = n;
    this.gridOff = gridOff;
    this.gridNodes = gridNodes;
  }

  private cellOf(lat: number, lon: number): number {
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor((lat - this.minLat) / this.cellLat)));
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor((lon - this.minLon) / this.cellLon)));
    return r * this.cols + c;
  }

  nodeLat(n: number): number {
    return this.nodes[n * 2]! / 1e7;
  }
  nodeLon(n: number): number {
    return this.nodes[n * 2 + 1]! / 1e7;
  }
  /** Straßenname einer Kante. */
  name(edge: number): string | null {
    return this.names.get(this.edgeName[edge]!);
  }
  /** Länge einer Kante in Metern. */
  lengthM(edge: number): number {
    return this.edgeLen[edge]! / 10;
  }
  /** Der andere Endknoten einer Kante. */
  other(edge: number, node: number): number {
    const a = this.edgeA[edge]!;
    return a === node ? this.edgeB[edge]! : a;
  }
  /** Abbiegeverbote, die an diesem Knoten greifen. */
  restrictionsAt(node: number): Restriction[] | undefined {
    return this.restrictions.get(node);
  }
  /** Alle Verbote als (Knoten, Liste) — fürs Zusammenführen mehrerer Regionen. */
  restrictionEntries(): IterableIterator<[number, Restriction[]]> {
    return this.restrictions.entries();
  }

  /**
   * Geometrie einer Kante als [lat, lon, …] inklusive beider Endknoten.
   * `forward=false` gibt sie von B nach A zurück.
   */
  geometry(edge: number, forward = true): Float64Array {
    const inner = this.edgeGeomLen[edge]!;
    const out = new Float64Array((inner + 2) * 2);
    const a = this.edgeA[edge]!;
    const b = this.edgeB[edge]!;
    out[0] = this.nodes[a * 2]! / 1e7;
    out[1] = this.nodes[a * 2 + 1]! / 1e7;
    if (inner > 0) {
      const r = new VarintReader(this.geom, this.edgeGeomOff[edge]!);
      let lat = Math.round(this.nodes[a * 2]! / 10);
      let lon = Math.round(this.nodes[a * 2 + 1]! / 10);
      for (let i = 1; i <= inner; i++) {
        lat += r.sint();
        lon += r.sint();
        out[i * 2] = lat / 1e6;
        out[i * 2 + 1] = lon / 1e6;
      }
    }
    out[(inner + 1) * 2] = this.nodes[b * 2]! / 1e7;
    out[(inner + 1) * 2 + 1] = this.nodes[b * 2 + 1]! / 1e7;
    if (forward) return out;
    const rev = new Float64Array(out.length);
    for (let i = 0, j = out.length - 2; i < out.length; i += 2, j -= 2) {
      rev[i] = out[j]!;
      rev[i + 1] = out[j + 1]!;
    }
    return rev;
  }

  /**
   * Knoten im Umkreis, ringweise nach außen. Liefert Indizes, bis `wanted`
   * Treffer beisammen sind oder `maxRadiusM` erreicht ist.
   */
  nodesNear(lat: number, lon: number, wanted = 24, maxRadiusM = 6000): number[] {
    const found: number[] = [];
    const r0 = Math.min(this.rows - 1, Math.max(0, Math.floor((lat - this.minLat) / this.cellLat)));
    const c0 = Math.min(this.cols - 1, Math.max(0, Math.floor((lon - this.minLon) / this.cellLon)));
    const maxRing = Math.ceil(maxRadiusM / (this.cellLat * 111000));
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= this.rows) continue;
        for (let dc = -ring; dc <= ring; dc++) {
          if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
          const c = c0 + dc;
          if (c < 0 || c >= this.cols) continue;
          const cell = r * this.cols + c;
          for (let i = this.gridOff[cell]!; i < this.gridOff[cell + 1]!; i++) {
            found.push(this.gridNodes[i]!);
          }
        }
      }
      // Einen Ring über den ersten Treffer hinaus sammeln — der nächste Punkt
      // kann in der Nachbarzelle liegen.
      if (found.length >= wanted && ring > 0) break;
    }
    return found;
  }
}

/* ------------------------------------------------------------------ */
/* Regionen verbinden                                                  */
/* ------------------------------------------------------------------ */

/** Alle Fortbewegungsarten in beide Richtungen — für die Verbindungskanten. */
const STITCH_FLAGS =
  FLAG.CAR_F | FLAG.CAR_B | FLAG.BIKE_F | FLAG.BIKE_B | FLAG.FOOT_F | FLAG.FOOT_B;

/** Schlüssel eines Punktes auf ~1 m genau (Grenzknoten sind koordinatengleich). */
const posKey = (lat1e7: number, lon1e7: number) => Math.round(lat1e7 / 100) * 1e7 + Math.round(lon1e7 / 100);

function concatU32(parts: Uint32Array[], total: number, shift?: (i: number) => number): Uint32Array {
  const out = new Uint32Array(total);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const add = shift ? shift(i) : 0;
    const part = parts[i]!;
    if (add === 0) out.set(part, at);
    else for (let k = 0; k < part.length; k++) out[at + k] = part[k]! + add;
    at += part.length;
  }
  return out;
}

/**
 * Setzt mehrere Regionsgraphen zu einem Netz zusammen. Knoten, die in zwei
 * Regionen an derselben Stelle liegen (die Geofabrik-Auszüge überlappen an den
 * Landesgrenzen), werden mit einer Kante der Länge 0 verbunden — dadurch
 * braucht der Router keine Sonderbehandlung.
 */
export function mergeGraphs(graphs: RouteGraph[]): RouteGraph {
  if (graphs.length === 1) return graphs[0]!;

  const nodeOffset: number[] = [];
  const edgeNameOffset: number[] = [];
  const geomOffset: number[] = [];
  let nodeTotal = 0;
  let edgeTotal = 0;
  let geomTotal = 0;
  let nameTotal = 0;
  let restrTotal = 0;
  for (const g of graphs) {
    nodeOffset.push(nodeTotal);
    edgeNameOffset.push(nameTotal);
    geomOffset.push(geomTotal);
    nodeTotal += g.nodeCount;
    edgeTotal += g.edgeCount;
    geomTotal += g.geom.length;
    nameTotal += g.nameCount;
    restrTotal += g.restrictionCount;
  }

  // --- Grenzknoten paarweise suchen (nur im gemeinsamen Ausschnitt) ---
  const bboxes = graphs.map((g) => (g.meta.bbox as number[]) ?? [-180, -90, 180, 90]);
  const stitches: [number, number][] = [];
  for (let i = 0; i < graphs.length; i++) {
    for (let j = i + 1; j < graphs.length; j++) {
      const a = bboxes[i]!;
      const b = bboxes[j]!;
      const west = Math.max(a[0]!, b[0]!);
      const south = Math.max(a[1]!, b[1]!);
      const east = Math.min(a[2]!, b[2]!);
      const north = Math.min(a[3]!, b[3]!);
      if (west >= east || south >= north) continue;

      const gi = graphs[i]!;
      const gj = graphs[j]!;
      const inBox = (g: RouteGraph, n: number) => {
        const lat = g.nodes[n * 2]! / 1e7;
        const lon = g.nodes[n * 2 + 1]! / 1e7;
        return lon >= west && lon <= east && lat >= south && lat <= north;
      };
      const index = new Map<number, number>();
      for (let n = 0; n < gi.nodeCount; n++) {
        if (inBox(gi, n)) index.set(posKey(gi.nodes[n * 2]!, gi.nodes[n * 2 + 1]!), n);
      }
      if (!index.size) continue;
      for (let n = 0; n < gj.nodeCount; n++) {
        if (!inBox(gj, n)) continue;
        const hit = index.get(posKey(gj.nodes[n * 2]!, gj.nodes[n * 2 + 1]!));
        if (hit !== undefined) stitches.push([nodeOffset[i]! + hit, nodeOffset[j]! + n]);
      }
    }
  }

  const stitchCount = stitches.length;
  const edgeAll = edgeTotal + stitchCount;

  const nodes = new Int32Array(nodeTotal * 2);
  let at = 0;
  for (const g of graphs) {
    nodes.set(g.nodes, at);
    at += g.nodes.length;
  }

  const edgeA = concatU32(graphs.map((g) => g.edgeA), edgeAll, (i) => nodeOffset[i]!);
  const edgeB = concatU32(graphs.map((g) => g.edgeB), edgeAll, (i) => nodeOffset[i]!);
  const edgeLen = concatU32(graphs.map((g) => g.edgeLen), edgeAll);
  const edgeName = new Uint32Array(edgeAll);
  {
    let at = 0;
    for (let i = 0; i < graphs.length; i++) {
      const part = graphs[i]!.edgeName;
      const add = edgeNameOffset[i]!;
      for (let k = 0; k < part.length; k++) {
        const id = part[k]!;
        edgeName[at + k] = id === 0xffffffff ? 0xffffffff : id + add;
      }
      at += part.length;
    }
  }
  const edgeGeomOff = concatU32(graphs.map((g) => g.edgeGeomOff), edgeAll, (i) => geomOffset[i]!);

  const edgeFlags = new Uint8Array(edgeAll);
  const edgeClass = new Uint8Array(edgeAll);
  const edgeSpeed = new Uint8Array(edgeAll);
  const edgeGeomLen = new Uint16Array(edgeAll);
  const geom = new Uint8Array(geomTotal);
  let e0 = 0;
  let g0 = 0;
  for (const g of graphs) {
    edgeFlags.set(g.edgeFlags, e0);
    edgeClass.set(g.edgeClass, e0);
    edgeSpeed.set(g.edgeSpeed, e0);
    edgeGeomLen.set(g.edgeGeomLen, e0);
    geom.set(g.geom, g0);
    e0 += g.edgeCount;
    g0 += g.geom.length;
  }

  // Verbindungskanten an den Landesgrenzen (Länge 0, für alle Arten frei).
  for (let s = 0; s < stitchCount; s++) {
    const e = edgeTotal + s;
    edgeA[e] = stitches[s]![0];
    edgeB[e] = stitches[s]![1];
    edgeLen[e] = 0;
    edgeFlags[e] = STITCH_FLAGS;
    edgeClass[e] = CLASS.service;
    edgeSpeed[e] = 50;
    edgeName[e] = 0xffffffff;
    edgeGeomOff[e] = 0;
    edgeGeomLen[e] = 0;
  }

  // Abbiegeverbote übernehmen (Kanten- und Knotennummern verschieben sich).
  const restrFrom = new Uint32Array(restrTotal);
  const restrTo = new Uint32Array(restrTotal);
  const restrVia = new Uint32Array(restrTotal);
  const restrFlags = new Uint8Array(restrTotal);
  let r0 = 0;
  let edgeBase = 0;
  for (let i = 0; i < graphs.length; i++) {
    const g = graphs[i]!;
    for (const [via, list] of g.restrictionEntries()) {
      for (const r of list) {
        restrFrom[r0] = r.from + edgeBase;
        restrTo[r0] = r.to + edgeBase;
        restrVia[r0] = via + nodeOffset[i]!;
        restrFlags[r0] = r.flags;
        r0++;
      }
    }
    edgeBase += g.edgeCount;
  }

  const bbox = [
    Math.min(...bboxes.map((b) => b[0]!)),
    Math.min(...bboxes.map((b) => b[1]!)),
    Math.max(...bboxes.map((b) => b[2]!)),
    Math.max(...bboxes.map((b) => b[3]!)),
  ];

  return new RouteGraph({
    meta: {
      bbox,
      regions: graphs.map((g) => g.meta.code),
      stitches: stitchCount,
    },
    nodes,
    edgeA,
    edgeB,
    edgeLen,
    edgeFlags,
    edgeClass,
    edgeSpeed,
    edgeName,
    edgeGeomOff,
    edgeGeomLen,
    geom,
    names: new JoinedNames(graphs.map((g, i) => ({ start: edgeNameOffset[i]!, table: g.names }))),
    nameCount: nameTotal,
    restrFrom,
    restrTo,
    restrVia,
    restrFlags,
  });
}
