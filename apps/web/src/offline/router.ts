/**
 * Routenberechnung auf dem Offline-Graphen: Fangen des Start-/Zielpunkts aufs
 * Straßennetz, A*-Suche und daraus die Fahranweisungen auf Deutsch.
 *
 * Läuft im Worker (siehe worker.ts) — hier steht reine Rechenlogik ohne
 * Browser-Bezug, damit sie sich auch in Node testen lässt.
 */

import type {
  Coords,
  ManeuverModifier,
  ManeuverType,
  RouteLeg,
  RouteOutcome,
  RouteProfile,
  RouteResult,
  RouteStep,
} from '@lagebild/shared';
import { CLASS, FLAG, RESTRICTION, RouteGraph, distanceM, type Restriction } from './graph.js';

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/** Rad-/Fußgeschwindigkeiten je Straßenklasse (km/h). */
const BIKE_SPEED = [0, 0, 17, 17, 17, 16, 16, 10, 12, 8, 11, 11, 7, 18, 2, 15];
const FOOT_SPEED = [0, 0, 5, 5, 5, 5, 5, 5, 5, 5, 4.5, 4.5, 5, 5, 1.6, 10];

export interface Profile {
  id: RouteProfile;
  /** Höchstgeschwindigkeit in m/s — Grundlage der A*-Schätzung. */
  maxSpeedMs: number;
  /** Zusatzkosten je Kreuzung in Sekunden. */
  junctionPenaltyS: number;
  /** Bit in den Abbiegeverboten (0 = zu Fuß, für Fußgänger gelten sie nicht). */
  restrictionBit: number;
  allowed(flags: number, forward: boolean): boolean;
  /** Reisezeit einer Kante in Sekunden. */
  cost(graph: RouteGraph, edge: number): number;
}

const kmh = (v: number) => v / 3.6;

export const PROFILES: Record<RouteProfile, Profile> = {
  car: {
    id: 'car',
    maxSpeedMs: kmh(135),
    junctionPenaltyS: 2.5,
    restrictionBit: RESTRICTION.CAR,
    allowed: (flags, forward) => (flags & (forward ? FLAG.CAR_F : FLAG.CAR_B)) !== 0,
    cost: (g, e) => {
      const speed = g.edgeSpeed[e] || 30;
      // Realistischer als das Schild: Ortsdurchfahrten und Kurven kosten Zeit.
      const factor = speed >= 100 ? 0.95 : speed >= 60 ? 0.88 : 0.8;
      return g.lengthM(e) / kmh(speed * factor);
    },
  },
  bike: {
    id: 'bike',
    maxSpeedMs: kmh(20),
    junctionPenaltyS: 1.5,
    restrictionBit: RESTRICTION.BIKE,
    allowed: (flags, forward) => (flags & (forward ? FLAG.BIKE_F : FLAG.BIKE_B)) !== 0,
    cost: (g, e) => {
      const cls = g.edgeClass[e]!;
      let speed = BIKE_SPEED[cls] ?? 14;
      // Auf großen Straßen ohne Radweg fährt es sich unangenehm — leicht meiden.
      if (cls <= CLASS.secondary) speed *= 0.75;
      return g.lengthM(e) / kmh(Math.max(3, speed));
    },
  },
  foot: {
    id: 'foot',
    maxSpeedMs: kmh(6),
    junctionPenaltyS: 0,
    restrictionBit: 0,
    allowed: (flags, forward) => (flags & (forward ? FLAG.FOOT_F : FLAG.FOOT_B)) !== 0,
    cost: (g, e) => {
      const cls = g.edgeClass[e]!;
      let speed = FOOT_SPEED[cls] ?? 5;
      if (cls <= CLASS.primary) speed *= 0.9;
      return g.lengthM(e) / kmh(Math.max(1, speed));
    },
  },
};

/* ------------------------------------------------------------------ */
/* Fangen auf das Straßennetz                                          */
/* ------------------------------------------------------------------ */

export interface Snap {
  edge: number;
  /** Gefangener Punkt auf der Straße. */
  lat: number;
  lon: number;
  /** Abstand des Eingabepunkts zur Straße. */
  offRoadM: number;
  /** Lage auf der Kante, gemessen von Knoten A in Metern. */
  alongM: number;
  totalM: number;
  nodeA: number;
  nodeB: number;
  name: string | null;
}

/** Projiziert P auf die Strecke AB und gibt Parameter t sowie den Abstand zurück. */
function project(
  plat: number,
  plon: number,
  alat: number,
  alon: number,
  blat: number,
  blon: number,
): { t: number; lat: number; lon: number } {
  const kx = Math.cos(((alat + blat) / 2) * (Math.PI / 180));
  const ax = alon * kx;
  const ay = alat;
  const bx = blon * kx;
  const by = blat;
  const px = plon * kx;
  const py = plat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { t, lat: alat + (blat - alat) * t, lon: alon + (blon - alon) * t };
}

/** Wie weit hinter dem besten Treffer noch Ausweichkanten gesammelt werden. */
const SNAP_SPREAD_M = 250;

/**
 * Sucht die für das Profil nutzbaren Kanten in der Nähe, die nächste zuerst.
 * Es werden die Kanten aller Knoten in der Nähe geprüft — dadurch wird auch
 * ein Punkt mitten auf einer langen Autobahnkante richtig gefangen.
 *
 * Warum mehrere? Weil die nächstgelegene Kante ein Stichweg sein kann, von dem
 * aus es für das Profil nicht weitergeht (eine Parkplatzgasse, ein für Autos
 * gesperrter Parkweg). Dann muss die Suche eine Kante weiter außen versuchen
 * dürfen, statt „keine Verbindung" zu melden.
 */
export function snapCandidates(
  graph: RouteGraph,
  point: Coords,
  profile: Profile,
  limit = 3,
): Snap[] {
  const candidates = graph.nodesNear(point.lat, point.lon, 24, 8000);
  if (!candidates.length) return [];
  const seen = new Set<number>();
  const found: Snap[] = [];

  for (const n of candidates) {
    for (let i = graph.arcOff[n]!; i < graph.arcOff[n + 1]!; i++) {
      const edge = graph.arcEdge[i]!;
      if (seen.has(edge)) continue;
      seen.add(edge);
      // Kanten der Länge 0 verbinden nur zwei Regionen an der Grenze — auf so
      // eine darf nichts gefangen werden.
      if (graph.edgeLen[edge] === 0) continue;
      const flags = graph.edgeFlags[edge]!;
      if (!profile.allowed(flags, true) && !profile.allowed(flags, false)) continue;

      const pts = graph.geometry(edge, true);
      let along = 0;
      let bestOnEdge: { d: number; along: number; lat: number; lon: number } | null = null;
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const alat = pts[k]!;
        const alon = pts[k + 1]!;
        const blat = pts[k + 2]!;
        const blon = pts[k + 3]!;
        const segLen = distanceM(alat, alon, blat, blon);
        const pr = project(point.lat, point.lon, alat, alon, blat, blon);
        const d = distanceM(point.lat, point.lon, pr.lat, pr.lon);
        if (!bestOnEdge || d < bestOnEdge.d) {
          bestOnEdge = { d, along: along + segLen * pr.t, lat: pr.lat, lon: pr.lon };
        }
        along += segLen;
      }
      if (!bestOnEdge) continue;
      found.push({
        edge,
        lat: bestOnEdge.lat,
        lon: bestOnEdge.lon,
        offRoadM: bestOnEdge.d,
        alongM: bestOnEdge.along,
        totalM: along,
        nodeA: graph.edgeA[edge]!,
        nodeB: graph.edgeB[edge]!,
        name: graph.name(edge),
      });
    }
  }
  if (!found.length) return [];
  found.sort((x, y) => x.offRoadM - y.offRoadM);
  // Nur Kanten in Rufweite des besten Treffers — sonst begänne die Route im
  // nächsten Ortsteil.
  const cutoff = found[0]!.offRoadM + SNAP_SPREAD_M;
  return found.filter((f) => f.offRoadM <= cutoff).slice(0, limit);
}

/** Nur der nächstgelegene Treffer (Prüfskripte, Abstandsmessung). */
export function snap(graph: RouteGraph, point: Coords, profile: Profile): Snap | null {
  return snapCandidates(graph, point, profile, 1)[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Vorrangwarteschlange                                                */
/* ------------------------------------------------------------------ */

class MinHeap {
  private keys = new Float64Array(1024);
  private vals = new Uint32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }
  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Uint32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    this.keys[i] = key;
    this.vals[i] = val;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  peekKey(): number {
    return this.size ? this.keys[0]! : Infinity;
  }
  pop(): number {
    const top = this.vals[0]!;
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]!;
      this.vals[0] = this.vals[this.size]!;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.size && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const v = this.vals[a]!;
    this.vals[a] = this.vals[b]!;
    this.vals[b] = v;
  }
}

/** Wiederverwendete Suchpuffer — ein Graph, viele Anfragen. */
class SearchState {
  /** Kosten je gerichteter Kante (Bogen) — Float32 reicht für Sekunden. */
  readonly dist: Float32Array;
  readonly stamp: Uint32Array;
  readonly prevArc: Int32Array;
  readonly heap = new MinHeap();
  run = 0;
  constructor(arcs: number) {
    this.dist = new Float32Array(arcs);
    this.stamp = new Uint32Array(arcs);
    this.prevArc = new Int32Array(arcs);
  }
  begin(): void {
    this.run++;
    this.heap.clear();
  }
}

const states = new WeakMap<RouteGraph, SearchState>();
function stateFor(graph: RouteGraph): SearchState {
  let s = states.get(graph);
  if (!s) states.set(graph, (s = new SearchState(graph.edgeCount * 2)));
  return s;
}

/* ------------------------------------------------------------------ */
/* A* über gerichtete Kanten                                           */
/* ------------------------------------------------------------------ */

interface Leg {
  edges: number[];
  forwards: boolean[];
  /** Knoten, an dem die Zielkante erreicht wurde (-1 bei gleicher Kante). */
  endNode: number;
}

/**
 * Die Suche läuft über **gerichtete Kanten** statt über Knoten. Das kostet
 * doppelt so viel Speicher, macht aber zwei Dinge exakt, die sich sonst nur
 * schätzen lassen: das Wendeverbot an Ort und Stelle und die Abbiegeverbote
 * aus OSM (die davon abhängen, aus welcher Straße man kommt).
 *
 * `lowClassRadiusM` begrenzt kleine Straßen auf die Nähe von Start und Ziel —
 * das beschleunigt lange Fahrten stark; scheitert die Suche, wiederholt
 * `route()` sie ohne diese Einschränkung.
 */
function search(
  graph: RouteGraph,
  from: Snap,
  to: Snap,
  profile: Profile,
  lowClassRadiusM: number,
  ignoreRestrictions = false,
  options: { avoidMotorways?: boolean; penalty?: Uint8Array } = {},
): Leg | null {
  const { avoidMotorways, penalty } = options;
  /** Reisezeit einer Kante inklusive Aufschlägen für Alternativen/Autobahn. */
  const edgeCost = (edge: number): number => {
    let cost = profile.cost(graph, edge);
    if (avoidMotorways && graph.edgeClass[edge]! <= CLASS.trunk) cost *= MOTORWAY_PENALTY;
    if (penalty && penalty[edge]) cost *= ALTERNATIVE_PENALTY;
    return cost;
  };
  const st = stateFor(graph);
  st.begin();
  const { dist, stamp, prevArc, heap } = st;
  const destLat = to.lat;
  const destLon = to.lon;
  const invMax = 1 / profile.maxSpeedMs;
  /** Kopf eines Bogens: der Knoten, an dem man ankommt. */
  const head = (arc: number) => (arc & 1 ? graph.edgeA[arc >> 1]! : graph.edgeB[arc >> 1]!);
  const h = (node: number) =>
    distanceM(graph.nodeLat(node), graph.nodeLon(node), destLat, destLon) * invMax;

  const push = (arc: number, g: number, prev: number) => {
    if (stamp[arc] === st.run && dist[arc]! <= g) return;
    stamp[arc] = st.run;
    dist[arc] = g;
    prevArc[arc] = prev;
    heap.push(g + h(head(arc)), arc);
  };

  // Einstieg: von der gefangenen Stelle zu den Enden der Startkante.
  const startFlags = graph.edgeFlags[from.edge]!;
  const startCost = edgeCost(from.edge) / Math.max(1, from.totalM);
  if (profile.allowed(startFlags, true)) {
    push(from.edge * 2, startCost * (from.totalM - from.alongM), -1);
  }
  if (profile.allowed(startFlags, false)) {
    push(from.edge * 2 + 1, startCost * from.alongM, -1);
  }

  // Ausstieg: Restweg von den Enden der Zielkante zur gefangenen Stelle.
  const endFlags = graph.edgeFlags[to.edge]!;
  const endCost = edgeCost(to.edge) / Math.max(1, to.totalM);
  const finishA = profile.allowed(endFlags, true) ? endCost * to.alongM : Infinity;
  const finishB = profile.allowed(endFlags, false) ? endCost * (to.totalM - to.alongM) : Infinity;

  // Sonderfall: beide Punkte auf derselben Kante.
  if (from.edge === to.edge) {
    const forward = to.alongM >= from.alongM;
    if (profile.allowed(startFlags, forward)) return { edges: [], forwards: [], endNode: -1 };
  }

  let bestTotal = Infinity;
  let bestArc = -1;
  let bestNode = -1;
  const modeBit = ignoreRestrictions ? 0 : profile.restrictionBit;
  let guard = 0;

  while (heap.size > 0) {
    if (heap.peekKey() >= bestTotal) break;
    if (++guard > 8_000_000) break; // Notbremse
    const arc = heap.pop();
    const g = dist[arc]!;
    if (stamp[arc] !== st.run) continue;
    const edge = arc >> 1;
    const node = head(arc);

    // Ziel erreicht? (Restweg auf der Zielkante kommt oben drauf.)
    if (node === to.nodeA && g + finishA < bestTotal) {
      bestTotal = g + finishA;
      bestArc = arc;
      bestNode = node;
    }
    if (node === to.nodeB && g + finishB < bestTotal) {
      bestTotal = g + finishB;
      bestArc = arc;
      bestNode = node;
    }

    const nearEnds =
      lowClassRadiusM === Infinity ||
      distanceM(graph.nodeLat(node), graph.nodeLon(node), destLat, destLon) < lowClassRadiusM ||
      distanceM(graph.nodeLat(node), graph.nodeLon(node), from.lat, from.lon) < lowClassRadiusM;

    // Abbiegeverbote an diesem Knoten, die zu unserer Herkunftskante passen.
    let banned: Restriction[] | null = null;
    let onlyTo = -1;
    if (modeBit) {
      const list = graph.restrictionsAt(node);
      if (list) {
        for (const r of list) {
          if (r.from !== edge || !(r.flags & modeBit)) continue;
          if (r.flags & RESTRICTION.ONLY) onlyTo = r.to;
          else (banned ??= []).push(r);
        }
      }
    }

    for (let i = graph.arcOff[node]!; i < graph.arcOff[node + 1]!; i++) {
      const next = graph.arcEdge[i]!;
      if (next === edge) continue; // kein Wenden auf der Stelle
      const forward = graph.edgeA[next]! === node;
      if (!profile.allowed(graph.edgeFlags[next]!, forward)) continue;
      if (!nearEnds && graph.edgeClass[next]! > CLASS.tertiary) continue;
      if (onlyTo >= 0 && next !== onlyTo) continue;
      if (banned) {
        let blocked = false;
        for (const r of banned) {
          if (r.to === next) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }
      const nextArc = next * 2 + (forward ? 0 : 1);
      const ng = g + edgeCost(next) + profile.junctionPenaltyS;
      if (stamp[nextArc] === st.run && dist[nextArc]! <= ng) continue;
      push(nextArc, ng, arc);
    }
  }

  if (bestArc < 0) return null;

  // Weg zurückverfolgen.
  const edges: number[] = [];
  const forwards: boolean[] = [];
  let arc = bestArc;
  while (arc >= 0) {
    edges.push(arc >> 1);
    forwards.push((arc & 1) === 0);
    arc = prevArc[arc]!;
  }
  edges.reverse();
  forwards.reverse();
  return { edges, forwards, endNode: bestNode };
}

/* ------------------------------------------------------------------ */
/* Geometrie zusammensetzen                                            */
/* ------------------------------------------------------------------ */

/** Punkt in einer bestimmten Entfernung entlang der Punktfolge. */
function pointAt(pts: Float64Array, m: number): [number, number] {
  let along = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const segLen = distanceM(pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!);
    if (along + segLen >= m || k + 5 >= pts.length) {
      const t = segLen > 0 ? Math.max(0, Math.min(1, (m - along) / segLen)) : 0;
      return [pts[k]! + (pts[k + 2]! - pts[k]!) * t, pts[k + 1]! + (pts[k + 3]! - pts[k + 1]!) * t];
    }
    along += segLen;
  }
  return [pts[0]!, pts[1]!];
}

/** Schneidet aus einer Punktfolge den Bereich zwischen zwei Metermarken. */
function cut(pts: Float64Array, startM: number, endM: number): number[] {
  const [slat, slon] = pointAt(pts, startM);
  const out: number[] = [slat, slon];
  let along = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const segLen = distanceM(pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!);
    along += segLen;
    // Stützpunkte, die innerhalb des Bereichs liegen, unverändert übernehmen.
    if (along > startM && along < endM) out.push(pts[k + 2]!, pts[k + 3]!);
  }
  const [elat, elon] = pointAt(pts, endM);
  out.push(elat, elon);
  return out;
}

function reversePairs(arr: number[]): number[] {
  const out: number[] = [];
  for (let i = arr.length - 2; i >= 0; i -= 2) out.push(arr[i]!, arr[i + 1]!);
  return out;
}

/* ------------------------------------------------------------------ */
/* Anweisungen                                                         */
/* ------------------------------------------------------------------ */

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Differenz zweier Kurse als Wert zwischen -180 und 180. */
function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function modifierFor(angle: number): ManeuverModifier {
  const a = Math.abs(angle);
  if (a < 18) return 'straight';
  if (a > 160) return 'uturn';
  if (a > 120) return angle > 0 ? 'sharp-right' : 'sharp-left';
  if (a < 45) return angle > 0 ? 'slight-right' : 'slight-left';
  return angle > 0 ? 'right' : 'left';
}

const COMPASS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]!;

const TURN_TEXT: Record<ManeuverModifier, string> = {
  left: 'Links abbiegen',
  right: 'Rechts abbiegen',
  'slight-left': 'Leicht links halten',
  'slight-right': 'Leicht rechts halten',
  'sharp-left': 'Scharf links abbiegen',
  'sharp-right': 'Scharf rechts abbiegen',
  straight: 'Geradeaus weiter',
  uturn: 'Wenden',
};

function stepText(
  type: ManeuverType,
  mod: ManeuverModifier | null,
  name: string | null,
  extra: { exit?: number; fromFastRoad?: boolean } = {},
): string {
  const on = name ? ` auf ${name}` : '';
  const side = mod === 'left' || mod === 'slight-left' || mod === 'sharp-left' ? 'links' : 'rechts';
  switch (type) {
    case 'arrive':
      return 'Ziel erreicht';
    case 'roundabout':
      return `Im Kreisverkehr die ${extra.exit ?? 1}. Ausfahrt nehmen${on}`;
    case 'merge':
      return `Auffahren${on}`;
    case 'fork':
      // Rampen: von der Schnellstraße geht es ab, sonst hinauf.
      return extra.fromFastRoad
        ? `Ausfahrt ${side} nehmen${on}`
        : `Auffahrt nehmen${on}`;
    case 'continue':
      return name ? `Weiter auf ${name}` : 'Geradeaus weiter';
    default:
      return `${TURN_TEXT[mod ?? 'straight']}${on}`;
  }
}

/* ------------------------------------------------------------------ */
/* Öffentliche Routenberechnung                                        */
/* ------------------------------------------------------------------ */

export interface RouteOptions {
  /** Umkreis, in dem auch kleine Straßen benutzt werden (Meter). */
  lowClassRadiusM?: number;
  /** Abbiegeverbote übergehen (Rückfall, wenn sonst gar nichts gefunden wird). */
  ignoreRestrictions?: boolean;
  /** Autobahnen und Kraftfahrstraßen meiden. */
  avoidMotorways?: boolean;
  /** Wie viele verschiedene Wege gesucht werden sollen (1–3). */
  alternatives?: number;
}

/** Aufschlag auf schon benutzte Kanten, damit die nächste Suche anders läuft. */
const ALTERNATIVE_PENALTY = 2.2;
/** Aufschlag auf Autobahnen/Kraftfahrstraßen, wenn sie gemieden werden sollen. */
const MOTORWAY_PENALTY = 9;
/** Eine Alternative zählt nur, wenn sie sich so weit unterscheidet … */
const MAX_OVERLAP = 0.68;
/** … und nicht wesentlich länger dauert. */
const MAX_DETOUR_FACTOR = 1.45;
const MAX_DETOUR_S = 240;

/** Ab diesem Abstand zum nächsten Weg gilt ein Punkt als nicht abgedeckt. */
const OFF_GRID_M = 3000;

/** Kurzform ohne Begründung (Prüfskripte, Tests). */
export function route(
  graph: RouteGraph,
  from: Coords,
  to: Coords,
  profileId: RouteProfile,
  options: RouteOptions = {},
): RouteResult | null {
  return routeDetailed(graph, from, to, profileId, options).route;
}

/** Wiederverwendeter Aufschlags-Speicher je Graph (für Alternativen). */
const penalties = new WeakMap<RouteGraph, Uint8Array>();
function penaltyFor(graph: RouteGraph): Uint8Array {
  let p = penalties.get(graph);
  if (!p) penalties.set(graph, (p = new Uint8Array(graph.edgeCount)));
  else p.fill(0);
  return p;
}

/**
 * Route mit Begründung und bis zu drei Varianten. Ob eine Gegend überhaupt im
 * Gerät liegt, wird an den Daten selbst geprüft (lässt sich der Punkt aufs Netz
 * fangen?) — die groben Bundesland-Rechtecke überlappen sich und taugen dafür
 * nicht.
 *
 * Alternativen entstehen, indem die schon benutzten Kanten mit einem Aufschlag
 * belegt und die Suche wiederholt wird. Übernommen wird ein Weg nur, wenn er
 * sich deutlich unterscheidet und nicht wesentlich länger dauert.
 */
export function routeDetailed(
  graph: RouteGraph,
  from: Coords,
  to: Coords,
  profileId: RouteProfile,
  options: RouteOptions = {},
): RouteOutcome {
  const profile = PROFILES[profileId];
  const aCands = snapCandidates(graph, from, profile);
  const bCands = snapCandidates(graph, to, profile);
  const startOffRoadM = aCands[0]?.offRoadM ?? null;
  const endOffRoadM = bCands[0]?.offRoadM ?? null;
  const empty = { routes: [] as RouteResult[], route: null, startOffRoadM, endOffRoadM };
  if (!aCands.length || aCands[0]!.offRoadM > OFF_GRID_M) return { status: 'start-off-grid', ...empty };
  if (!bCands.length || bCands[0]!.offRoadM > OFF_GRID_M) return { status: 'end-off-grid', ...empty };

  const wanted = Math.max(1, Math.min(3, options.alternatives ?? 1));
  const penalty = wanted > 1 ? penaltyFor(graph) : undefined;
  const routes: RouteResult[] = [];
  const edgeSets: { edges: Set<number>; lengthM: number }[] = [];

  // Welche Anfangs- und Endkante trägt? Einmal ermitteln — die Varianten
  // müssen an derselben Stelle beginnen und enden.
  const first = findLegNear(graph, aCands, bCands, profile, profileId, options, undefined);
  if (!first) return { status: 'no-path', ...empty };
  const { a, b } = first;

  for (let attempt = 0; attempt < wanted; attempt++) {
    const leg =
      attempt === 0 ? first.leg : findLeg(graph, a, b, profile, profileId, options, penalty);
    if (!leg) break;
    const built = assemble(graph, a, b, leg, profile, profileId);
    if (!built) break;

    // Unterscheidet sich der Weg genug von allen bisherigen?
    if (attempt > 0) {
      const tooSimilar = edgeSets.some((prev) => {
        let shared = 0;
        for (const e of built.edges) if (prev.edges.has(e)) shared += graph.lengthM(e);
        return shared / Math.max(1, Math.min(prev.lengthM, built.lengthM)) > MAX_OVERLAP;
      });
      const tooSlow =
        built.result.durationS > routes[0]!.durationS * MAX_DETOUR_FACTOR + MAX_DETOUR_S;
      if (tooSimilar || tooSlow) break;
    }

    routes.push(built.result);
    edgeSets.push({ edges: new Set(built.edges), lengthM: built.lengthM });
    if (penalty) for (const e of built.edges) penalty[e] = 1;
  }

  if (!routes.length) return { status: 'no-path', ...empty };
  // Die erste Suche ist die schnellste; die Alternativen entstehen in der
  // Reihenfolge der Aufschläge, nicht der Fahrzeit — also noch sortieren.
  routes.sort((x, y) => x.durationS - y.durationS);
  return { status: 'ok', route: routes[0]!, routes, startOffRoadM, endOffRoadM };
}

/**
 * Route über Zwischenziele: die Abschnitte werden einzeln gesucht und
 * aneinandergehängt.
 *
 * Warum nicht in einem Rutsch? Weil A* immer den kürzesten Weg zwischen zwei
 * Punkten sucht — die Reihenfolge der Zwischenziele ist eine Vorgabe des
 * Nutzers, keine Optimierungsaufgabe. Wer eine andere Reihenfolge will, sortiert
 * die Liste um.
 *
 * **Varianten gibt es dabei nicht:** Sie entstehen aus Aufschlägen auf schon
 * benutzte Kanten, und über mehrere Abschnitte hinweg käme dabei nur Willkür
 * heraus. Wer Zwischenziele setzt, hat den Weg ohnehin selbst festgelegt.
 */
export function routeVia(
  graph: RouteGraph,
  points: Coords[],
  profileId: RouteProfile,
  options: RouteOptions = {},
): RouteOutcome {
  if (points.length < 2) {
    return { status: 'no-path', route: null, routes: [], startOffRoadM: null, endOffRoadM: null };
  }
  if (points.length === 2) {
    return routeDetailed(graph, points[0]!, points[1]!, profileId, options);
  }

  const profile = PROFILES[profileId];
  const snaps = points.map((p) => snapCandidates(graph, p, profile));
  const startOffRoadM = snaps[0]?.[0]?.offRoadM ?? null;
  const endOffRoadM = snaps[snaps.length - 1]?.[0]?.offRoadM ?? null;
  const empty = { routes: [] as RouteResult[], route: null, startOffRoadM, endOffRoadM };

  for (let i = 0; i < snaps.length; i++) {
    const best = snaps[i]![0];
    if (best && best.offRoadM <= OFF_GRID_M) continue;
    if (i === 0) return { status: 'start-off-grid', ...empty };
    if (i === snaps.length - 1) return { status: 'end-off-grid', ...empty };
    return { status: 'via-off-grid', offGridVia: i - 1, ...empty };
  }

  const parts: RouteResult[] = [];
  /** Tatsächlich benutzte Endkante je Abschnitt. */
  let previousEnd: Snap | null = null;
  for (let i = 1; i < snaps.length; i++) {
    // Der Übergang muss zusammenpassen: der nächste Abschnitt beginnt genau
    // dort, wo der vorige endet — sonst klaffte an der Naht eine Lücke.
    const from = previousEnd ? [previousEnd] : snaps[0]!;
    const found = findLegNear(graph, from, snaps[i]!, profile, profileId, options, undefined);
    const built = found && assemble(graph, found.a, found.b, found.leg, profile, profileId);
    if (!built) return { status: 'no-path', ...empty };
    previousEnd = found.b;
    parts.push(built.result);
  }

  const joined = joinLegs(parts, profileId);
  return { status: 'ok', route: joined, routes: [joined], startOffRoadM, endOffRoadM };
}

/** Zwei Punkte gelten als derselbe, wenn sie unter einem Zentimeter auseinanderliegen. */
const samePoint = (a: [number, number], b: [number, number]): boolean =>
  Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

/** Abschnitte zu einer durchgehenden Route zusammensetzen. */
function joinLegs(parts: RouteResult[], profileId: RouteProfile): RouteResult {
  const coordinates: [number, number][] = [];
  const steps: RouteStep[] = [];
  const legs: RouteLeg[] = [];
  const waypoints: Coords[] = [];
  let distanceM = 0;
  let durationS = 0;

  parts.forEach((part, i) => {
    const last = coordinates[coordinates.length - 1];
    // Der Übergangspunkt gehört beiden Abschnitten — er darf nur einmal in die
    // Linie, sonst zählt die Anzeige einen Punkt doppelt.
    const overlap = !!last && !!part.coordinates[0] && samePoint(last, part.coordinates[0]!);
    const offset = overlap ? coordinates.length - 1 : coordinates.length;
    legs.push({
      distanceM: part.distanceM,
      durationS: part.durationS,
      stepIndex: steps.length,
      coordIndex: Math.max(0, offset),
    });
    coordinates.push(...(overlap ? part.coordinates.slice(1) : part.coordinates));

    part.steps.forEach((step, k) => {
      // Der Aufbruch mitten in der Fahrt ist keine Anweisung.
      if (i > 0 && step.type === 'depart') return;
      const shifted: RouteStep = { ...step, index: step.index + offset };
      if (step.type === 'arrive' && i < parts.length - 1) {
        shifted.type = 'waypoint';
        // Kurz halten: der Satz wird auch angesagt („In 400 Metern …").
        shifted.text = `Zwischenziel ${i + 1}`;
      }
      steps.push(shifted);
      void k;
    });

    if (i < parts.length - 1) waypoints.push(part.snappedEnd);
    distanceM += part.distanceM;
    durationS += part.durationS;
  });

  return {
    profile: profileId,
    distanceM,
    durationS,
    coordinates,
    steps,
    snappedStart: parts[0]!.snappedStart,
    snappedEnd: parts[parts.length - 1]!.snappedEnd,
    waypoints,
    legs,
  };
}

/**
 * Wie `findLeg`, probiert aber der Reihe nach die Ausweichkanten aus dem
 * Fangen durch: erst die beiden nächsten, dann jeweils eine weiter außen.
 * Gemessen an echten Kartenklicks ist das nötig — ein Punkt im Bürgerpark
 * fängt sich sonst auf einem Fußweg, von dem kein Auto herunterkommt.
 */
function findLegNear(
  graph: RouteGraph,
  aCands: Snap[],
  bCands: Snap[],
  profile: Profile,
  profileId: RouteProfile,
  options: RouteOptions,
  penalty: Uint8Array | undefined,
): { leg: Leg; a: Snap; b: Snap } | null {
  const a1 = usable(graph, aCands, profile);
  const b1 = usable(graph, bCands, profile);
  const started = Date.now();
  for (const [i, j] of SNAP_TRIES) {
    const a = a1[i];
    const b = b1[j];
    if (!a || !b) continue;
    const leg = findLeg(graph, a, b, profile, profileId, options, penalty);
    if (leg) return { leg, a, b };
    // Hat die Suche lange gebraucht, hat sie ein großes Netz abgegrast: dann
    // gibt es schlicht keine Verbindung, und eine andere Anfangskante kostet
    // nur Zeit. Die Sackgassen sind zu diesem Zeitpunkt schon aussortiert.
    if (Date.now() - started > SNAP_RETRY_BUDGET_MS) break;
  }
  return null;
}

/** Zeitbudget für Versuche mit Ausweichkanten. */
const SNAP_RETRY_BUDGET_MS = 400;
/** So viele erreichbare Knoten gelten als „hier geht es weiter". */
const ESCAPE_NODES = 64;

/**
 * Kanten aussortieren, die in einer Sackgasse liegen.
 *
 * Ein Kartenklick fängt sich gern auf einer Parkplatzgasse oder einem für Autos
 * gesperrten Parkweg. Die A*-Suche merkt das erst, nachdem sie das **ganze**
 * übrige Netz abgesucht hat (gemessen: 1,7 s statt 40 ms). Ein paar Dutzend
 * Schritte im Voraus verraten dasselbe in Mikrosekunden.
 */
function usable(graph: RouteGraph, cands: Snap[], profile: Profile): Snap[] {
  if (cands.length < 2) return cands;
  const open = cands.filter((c) => escapes(graph, c, profile));
  // Führt keine heraus, bleibt es beim ursprünglichen Vorschlag — lieber ein
  // Versuch zu viel als gar keiner.
  return open.length ? open : cands;
}

/** Erreicht man von dieser Kante aus genug Knoten, um irgendwo hinzukommen? */
function escapes(graph: RouteGraph, cand: Snap, profile: Profile): boolean {
  const seen = new Set<number>([cand.nodeA, cand.nodeB]);
  const queue = [cand.nodeA, cand.nodeB];
  for (let head = 0; head < queue.length && seen.size < ESCAPE_NODES; head++) {
    const node = queue[head]!;
    for (let i = graph.arcOff[node]!; i < graph.arcOff[node + 1]!; i++) {
      const edge = graph.arcEdge[i]!;
      const flags = graph.edgeFlags[edge]!;
      // Richtung bleibt außen vor: eine Einbahnstraße ist keine Sackgasse.
      if (!profile.allowed(flags, true) && !profile.allowed(flags, false)) continue;
      const other = graph.edgeA[edge]! === node ? graph.edgeB[edge]! : graph.edgeA[edge]!;
      if (seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return seen.size >= ESCAPE_NODES;
}

/** Reihenfolge der Versuche (Index der Anfangs-/Endkante). */
const SNAP_TRIES: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [2, 0],
  [0, 2],
];

/* ------------------------------------------------------------------ */
/* Route aus einer fertigen Linie (eingelesene GPX-Tour)                */
/* ------------------------------------------------------------------ */

/**
 * Durchschnittstempo je Fortbewegungsart, wenn **keine Straßendaten** dahinter
 * liegen. Eine eingelesene Linie kennt weder Straßenklasse noch Tempolimit —
 * mehr als ein ehrlicher Mittelwert ist nicht zu holen, und die Zahl steht in
 * der Oberfläche neben der Länge, damit niemand sie für eine Messung hält.
 */
const LINE_SPEED_KMH: Record<RouteProfile, number> = { car: 50, bike: 16, foot: 4.5 };

/** Abstand, über den die Richtung vor und nach einem Knick gemittelt wird. */
const TURN_WINDOW_M = 25;
/** Ab diesem Winkel gilt es als Richtungswechsel. */
const TURN_ANGLE = 32;
/** Zwei Anweisungen dürfen nicht dichter aufeinander folgen. */
const TURN_MIN_GAP_M = 60;

/**
 * Macht aus einem fertigen Linienzug eine Route, **ohne den Graphen**.
 *
 * Damit lässt sich einer eingelesenen GPX-Tour Punkt für Punkt folgen — auch
 * dort, wo gar keine Straße liegt (Wanderweg, Forstweg, Wasser) und auch ohne
 * heruntergeladene Region. Die Anweisungen entstehen allein aus den
 * Richtungswechseln, also ohne Straßennamen: „In 200 m rechts abbiegen".
 */
export function routeFromLine(coords: [number, number][], profileId: RouteProfile): RouteResult | null {
  if (coords.length < 2) return null;

  /** Auflaufende Länge bis zu jedem Stützpunkt. */
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1]! + distanceM(coords[i - 1]![1], coords[i - 1]![0], coords[i]![1], coords[i]![0]));
  }
  const total = cum[cum.length - 1]!;
  const durationS = (total / (LINE_SPEED_KMH[profileId] * 1000)) * 3600;

  /** Richtung über ein Stück Weg, damit einzelne Ausreißer nichts auslösen. */
  const bearingAround = (index: number, back: boolean): number | null => {
    const target = back ? cum[index]! - TURN_WINDOW_M : cum[index]! + TURN_WINDOW_M;
    let other = index;
    while (back ? other > 0 && cum[other]! > target : other < coords.length - 1 && cum[other]! < target) {
      other += back ? -1 : 1;
    }
    if (other === index) return null;
    const a = back ? coords[other]! : coords[index]!;
    const b = back ? coords[index]! : coords[other]!;
    return bearing(a[1], a[0], b[1], b[0]);
  };

  const steps: RouteStep[] = [];
  const startBearing = bearingAround(0, false) ?? 0;
  steps.push({
    type: 'depart',
    modifier: null,
    name: null,
    distanceM: 0,
    durationS: 0,
    lat: coords[0]![1],
    lon: coords[0]![0],
    index: 0,
    text: `Richtung ${compass(startBearing)} der Spur folgen`,
  });

  let lastAt = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    if (cum[i]! - lastAt < TURN_MIN_GAP_M) continue;
    const inB = bearingAround(i, true);
    const outB = bearingAround(i, false);
    if (inB == null || outB == null) continue;
    const angle = angleDiff(inB, outB);
    if (Math.abs(angle) < TURN_ANGLE) continue;
    const modifier = modifierFor(angle);
    steps.push({
      type: 'turn',
      modifier,
      name: null,
      distanceM: 0,
      durationS: 0,
      lat: coords[i]![1],
      lon: coords[i]![0],
      index: i,
      text: stepText('turn', modifier, null),
    });
    lastAt = cum[i]!;
  }

  steps.push({
    type: 'arrive',
    modifier: null,
    name: null,
    distanceM: 0,
    durationS: 0,
    lat: coords[coords.length - 1]![1],
    lon: coords[coords.length - 1]![0],
    index: coords.length - 1,
    text: 'Ende der Spur erreicht',
  });

  for (let i = 0; i < steps.length; i++) {
    const from = cum[steps[i]!.index] ?? 0;
    const to = i + 1 < steps.length ? (cum[steps[i + 1]!.index] ?? total) : total;
    steps[i]!.distanceM = Math.max(0, to - from);
    steps[i]!.durationS = total > 0 ? (durationS * steps[i]!.distanceM) / total : 0;
  }

  return {
    profile: profileId,
    distanceM: Math.round(total),
    durationS: Math.round(durationS),
    coordinates: coords,
    steps,
    snappedStart: { lat: coords[0]![1], lon: coords[0]![0] },
    snappedEnd: { lat: coords[coords.length - 1]![1], lon: coords[coords.length - 1]![0] },
  };
}

/**
 * Stützpunkte einer Linie auf Zwischenziele ausdünnen — für den Fall, dass die
 * Tour **auf dem Straßennetz** nachgerechnet werden soll. Zu viele Punkte
 * machen die Rechnung langsam und zwingen den Router auf jeden Messfehler.
 */
export function viaPointsFromLine(coords: [number, number][], maxPoints = 18): Coords[] {
  if (coords.length < 3) return [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += distanceM(coords[i - 1]![1], coords[i - 1]![0], coords[i]![1], coords[i]![0]);
  }
  // Start und Ziel kommen von außen, dazwischen gleichmäßig verteilte Punkte.
  const spacing = total / (maxPoints + 1);
  const out: Coords[] = [];
  let walked = 0;
  let next = spacing;
  for (let i = 1; i < coords.length - 1 && out.length < maxPoints; i++) {
    walked += distanceM(coords[i - 1]![1], coords[i - 1]![0], coords[i]![1], coords[i]![0]);
    if (walked >= next) {
      out.push({ lat: coords[i]![1], lon: coords[i]![0] });
      next += spacing;
    }
  }
  return out;
}

/** Sucht einen Weg samt der üblichen Rückfallstufen. */
function findLeg(
  graph: RouteGraph,
  a: Snap,
  b: Snap,
  profile: Profile,
  profileId: RouteProfile,
  options: RouteOptions,
  penalty: Uint8Array | undefined,
): Leg | null {
  const radius = options.lowClassRadiusM ?? (profileId === 'car' ? 20000 : Infinity);
  const ignore = options.ignoreRestrictions === true;
  const extra = { avoidMotorways: options.avoidMotorways, penalty };
  let leg = search(graph, a, b, profile, radius, ignore, extra);
  // Hat die Abkürzung über große Straßen nichts gefunden, ohne sie erneut suchen.
  if (!leg && radius !== Infinity) leg = search(graph, a, b, profile, Infinity, ignore, extra);
  // Immer noch nichts: lieber eine Route ohne Abbiegeverbote als gar keine.
  if (!leg && !ignore) leg = search(graph, a, b, profile, Infinity, true, extra);
  return leg;
}

/** Baut aus dem gefundenen Kantenzug Geometrie, Anweisungen und Kennzahlen. */
function assemble(
  graph: RouteGraph,
  a: Snap,
  b: Snap,
  leg: Leg,
  profile: Profile,
  profileId: RouteProfile,
): { result: RouteResult; edges: number[]; lengthM: number } | null {
  const { edges, forwards } = leg;
  let endNode = leg.endNode;

  // Die Suche liefert die Startkante als erstes Element; die Zielkante darf
  // nicht doppelt auftauchen (einmal als gefahrene Kante, einmal als Reststück).
  if (edges.length > 1 && edges[edges.length - 1] === b.edge) {
    const wasForward = forwards.pop()!;
    edges.pop();
    endNode = wasForward ? graph.edgeA[b.edge]! : graph.edgeB[b.edge]!;
  }
  // Verbindungskanten zwischen zwei Regionen sind 0 m lang und tragen weder
  // Geometrie noch Anweisungen — sie fliegen vor dem Zusammensetzen raus.
  for (let i = edges.length - 1; i >= 0; i--) {
    if (graph.edgeLen[edges[i]!] === 0 && edges[i] !== a.edge && edges[i] !== b.edge) {
      edges.splice(i, 1);
      forwards.splice(i, 1);
    }
  }

  /* --- Geometrie --- */
  const coords: number[] = []; // [lat, lon, …]
  const pushPts = (pts: number[]) => {
    for (let i = 0; i < pts.length; i += 2) {
      const n = coords.length;
      if (n >= 2 && Math.abs(coords[n - 2]! - pts[i]!) < 1e-9 && Math.abs(coords[n - 1]! - pts[i + 1]!) < 1e-9) {
        continue;
      }
      coords.push(pts[i]!, pts[i + 1]!);
    }
  };

  let distanceTotal = 0;
  let durationTotal = 0;
  /** Startindex jeder Kante in `coords` (Punktindex, nicht Zahlenindex). */
  const edgeStartIndex: number[] = [];

  if (edges.length === 0) {
    // Start und Ziel auf derselben Kante.
    const pts = graph.geometry(a.edge, true);
    const forward = b.alongM >= a.alongM;
    const seg = cut(pts, Math.min(a.alongM, b.alongM), Math.max(a.alongM, b.alongM));
    pushPts(forward ? seg : reversePairs(seg));
    distanceTotal = Math.abs(b.alongM - a.alongM);
    durationTotal = (profile.cost(graph, a.edge) / Math.max(1, a.totalM)) * distanceTotal;
  } else {
    // Erstes Element ist die Startkante — davon nur das Stück ab dem
    // gefangenen Punkt in Fahrtrichtung.
    const aPts = graph.geometry(a.edge, true);
    if (forwards[0]) {
      pushPts(cut(aPts, a.alongM, a.totalM));
      distanceTotal += a.totalM - a.alongM;
    } else {
      pushPts(reversePairs(cut(aPts, 0, a.alongM)));
      distanceTotal += a.alongM;
    }
    durationTotal += (profile.cost(graph, a.edge) / Math.max(1, a.totalM)) * distanceTotal;
    edgeStartIndex.push(0);

    for (let i = 1; i < edges.length; i++) {
      const edge = edges[i]!;
      edgeStartIndex.push(coords.length / 2 - 1);
      const pts = graph.geometry(edge, forwards[i]!);
      pushPts(Array.from(pts));
      distanceTotal += graph.lengthM(edge);
      durationTotal += profile.cost(graph, edge);
    }

    // Teilstück der Zielkante ab dem letzten Knoten.
    const bPts = graph.geometry(b.edge, true);
    if (endNode === b.nodeA) {
      const seg = cut(bPts, 0, b.alongM);
      pushPts(seg);
      distanceTotal += b.alongM;
      durationTotal += (profile.cost(graph, b.edge) / Math.max(1, b.totalM)) * b.alongM;
    } else if (endNode === b.nodeB) {
      const seg = reversePairs(cut(bPts, b.alongM, b.totalM));
      pushPts(seg);
      distanceTotal += b.totalM - b.alongM;
      durationTotal += (profile.cost(graph, b.edge) / Math.max(1, b.totalM)) * (b.totalM - b.alongM);
    }
  }

  /* --- Anweisungen --- */
  const steps: RouteStep[] = [];
  const startBearing =
    coords.length >= 4 ? bearing(coords[0]!, coords[1]!, coords[2]!, coords[3]!) : 0;
  const startName = edges.length ? graph.name(edges[0]!) : a.name;
  steps.push({
    type: 'depart',
    modifier: null,
    name: startName,
    distanceM: 0,
    durationS: 0,
    lat: a.lat,
    lon: a.lon,
    index: 0,
    text: `Richtung ${compass(startBearing)} starten${startName ? ` auf ${startName}` : ''}`,
  });

  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1]!;
    const cur = edges[i]!;
    const prevPts = graph.geometry(prev, forwards[i - 1]!);
    const curPts = graph.geometry(cur, forwards[i]!);
    const inB = bearing(
      prevPts[prevPts.length - 4]!,
      prevPts[prevPts.length - 3]!,
      prevPts[prevPts.length - 2]!,
      prevPts[prevPts.length - 1]!,
    );
    const outB = bearing(curPts[0]!, curPts[1]!, curPts[2]!, curPts[3]!);
    const angle = angleDiff(inB, outB);
    const absAngle = Math.abs(angle);
    const prevName = graph.name(prev);
    const curName = graph.name(cur);
    const prevFlags = graph.edgeFlags[prev]!;
    const curFlags = graph.edgeFlags[cur]!;
    const prevClass = graph.edgeClass[prev]!;
    const curClass = graph.edgeClass[cur]!;
    const node = forwards[i]! ? graph.edgeA[cur]! : graph.edgeB[cur]!;

    // Gibt es an dieser Kreuzung überhaupt eine Wahl? Wo nichts abzweigt,
    // braucht niemand eine Ansage — OSM teilt Wege ständig ohne Anlass.
    let branches = 0;
    for (let x = graph.arcOff[node]!; x < graph.arcOff[node + 1]!; x++) {
      const cand = graph.arcEdge[x]!;
      if (cand === prev || cand === cur) continue;
      if (profile.allowed(graph.edgeFlags[cand]!, graph.edgeA[cand]! === node)) branches++;
    }

    let type: ManeuverType = 'turn';
    let modifier: ManeuverModifier | null = modifierFor(angle);
    let exit: number | undefined;
    let fromFastRoad = false;

    if (curFlags & FLAG.ROUNDABOUT) {
      if (prevFlags & FLAG.ROUNDABOUT) continue; // im Kreisel unterwegs
      // Ausfahrten zählen, bis der Kreisverkehr wieder verlassen wird.
      let count = 0;
      let k = i;
      while (k < edges.length && graph.edgeFlags[edges[k]!]! & FLAG.ROUNDABOUT) {
        const endOfSeg = forwards[k]! ? graph.edgeB[edges[k]!]! : graph.edgeA[edges[k]!]!;
        for (let x = graph.arcOff[endOfSeg]!; x < graph.arcOff[endOfSeg + 1]!; x++) {
          const cand = graph.arcEdge[x]!;
          if (graph.edgeFlags[cand]! & FLAG.ROUNDABOUT) continue;
          if (profile.allowed(graph.edgeFlags[cand]!, graph.edgeA[cand]! === endOfSeg)) {
            count++;
            break;
          }
        }
        k++;
      }
      type = 'roundabout';
      modifier = null;
      exit = Math.max(1, count);
    } else if (prevFlags & FLAG.ROUNDABOUT) {
      continue; // Ausfahrt gehört zur Kreisverkehr-Anweisung
    } else if (curFlags & FLAG.LINK && !(prevFlags & FLAG.LINK)) {
      // Auf eine Rampe wechseln — nur beim Auffahren ansagen, nicht bei jedem
      // Teilstück der Rampe.
      type = 'fork';
      fromFastRoad = prevClass <= CLASS.trunk;
    } else if (prevFlags & FLAG.LINK && !(curFlags & FLAG.LINK) && curClass <= CLASS.trunk) {
      type = 'merge';
      modifier = null;
    } else if (prevFlags & FLAG.LINK && curFlags & FLAG.LINK) {
      // Innerhalb eines Autobahnkreuzes nur bei echter Gabelung ansagen.
      if (branches === 0 || absAngle < 40) continue;
      type = 'fork';
      fromFastRoad = true;
    } else if (branches === 0 && absAngle < 100) {
      continue; // Weg teilt sich nur formal
    } else if (absAngle < 45 && prevName !== null && prevName === curName) {
      continue; // dieselbe Straße macht eine Kurve
    } else if (modifier === 'straight') {
      if (prevName === curName) continue;
      type = 'continue';
    }

    steps.push({
      type,
      modifier,
      name: curName,
      distanceM: 0,
      durationS: 0,
      lat: graph.nodeLat(node),
      lon: graph.nodeLon(node),
      index: edgeStartIndex[i] ?? 0,
      exit,
      text: stepText(type, modifier, curName, { exit, fromFastRoad }),
    });
  }

  steps.push({
    type: 'arrive',
    modifier: null,
    name: b.name,
    distanceM: 0,
    durationS: 0,
    lat: b.lat,
    lon: b.lon,
    index: Math.max(0, coords.length / 2 - 1),
    text: 'Ziel erreicht',
  });

  // Längen und Zeiten je Abschnitt aus der Geometrie nachtragen.
  const cum: number[] = [0];
  for (let i = 2; i < coords.length; i += 2) {
    cum.push(cum[cum.length - 1]! + distanceM(coords[i - 2]!, coords[i - 1]!, coords[i]!, coords[i + 1]!));
  }
  const totalGeom = cum[cum.length - 1] ?? 0;
  for (let i = 0; i < steps.length; i++) {
    const from2 = cum[steps[i]!.index] ?? 0;
    const to2 = i + 1 < steps.length ? (cum[steps[i + 1]!.index] ?? totalGeom) : totalGeom;
    steps[i]!.distanceM = Math.max(0, to2 - from2);
    steps[i]!.durationS = totalGeom > 0 ? (durationTotal * steps[i]!.distanceM) / totalGeom : 0;
  }

  const coordinates: [number, number][] = [];
  for (let i = 0; i < coords.length; i += 2) coordinates.push([coords[i + 1]!, coords[i]!]);

  return {
    edges,
    lengthM: totalGeom || distanceTotal,
    result: {
      profile: profileId,
      distanceM: Math.round(totalGeom || distanceTotal),
      durationS: Math.round(durationTotal),
      coordinates,
      steps,
      snappedStart: { lat: a.lat, lon: a.lon },
      snappedEnd: { lat: b.lat, lon: b.lon },
    },
  };
}
