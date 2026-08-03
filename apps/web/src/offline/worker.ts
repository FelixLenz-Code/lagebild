/// <reference lib="webworker" />
/**
 * Worker für Offline-Suche und Routenberechnung.
 *
 * Der Graph eines Bundeslandes kann zweistellige Megabyte groß sein und eine
 * Routenberechnung einige hundert Millisekunden dauern — beides gehört nicht
 * auf den Haupt-Thread, sonst ruckelt die Karte.
 */

import type { Coords, RouteProfile } from '@lagebild/shared';
import { getOfflineFile } from '../offlineMaps.js';
import { Container, HEADER_PROBE_BYTES, parseHeader } from './container.js';
import { RouteGraph, mergeGraphs } from './graph.js';
import { routeVia } from './router.js';
import { Terrain, elevationProfile } from './terrain.js';
import { SearchIndex } from './search.js';

export type WorkerRequest =
  | { id: number; type: 'loadRoute'; codes: string[] }
  | { id: number; type: 'loadSearch'; code: string }
  | { id: number; type: 'search'; code: string; q: string; near?: Coords; limit?: number }
  | { id: number; type: 'houses'; code: string; entryId: number }
  | {
      id: number;
      type: 'poi';
      code: string;
      categories: string[];
      bbox: { west: number; south: number; east: number; north: number };
      limit?: number;
    }
  | {
      id: number;
      type: 'stops';
      code: string;
      bbox: { west: number; south: number; east: number; north: number };
      limit?: number;
    }
  | {
      id: number;
      type: 'elevation';
      /** Regionen, in denen die Linie liegen könnte. */
      codes: string[];
      line: [number, number][];
      /** Höhen aus der Datei selbst (GPX), wenn vorhanden. */
      own?: (number | undefined)[];
    }
  | {
      id: number;
      type: 'route';
      codes: string[];
      from: Coords;
      to: Coords;
      /** Zwischenziele in der gewünschten Reihenfolge. */
      via?: Coords[];
      profile: RouteProfile;
      alternatives?: number;
      avoidMotorways?: boolean;
    };

export interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Eine einzelne Region bleibt geladen; mehrere werden zusammengeführt. */
let single: { code: string; graph: RouteGraph } | null = null;
let joined: { key: string; graph: RouteGraph } | null = null;
let index: SearchIndex | null = null;
let indexCode = '';
/** Zuletzt benutztes Höhenraster (nur eins — sie sind mehrere Megabyte groß). */
let terrain: { code: string; data: Terrain } | null = null;

async function readGraph(code: string): Promise<RouteGraph> {
  const file = await getOfflineFile(code, 'route');
  const buffer = await file.arrayBuffer();
  return RouteGraph.fromContainer(new Container(parseHeader(buffer), buffer));
}

/**
 * Graph für die angefragten Regionen. Bei mehreren werden sie zu einem Netz
 * verbunden (Grenzknoten liegen in beiden Auszügen an derselben Stelle) — die
 * Einzelteile werden danach nicht mehr gehalten, sonst läge alles doppelt im
 * Speicher.
 */
async function loadRoute(codes: string[]): Promise<RouteGraph> {
  const list = [...new Set(codes)].sort();
  if (!list.length) throw new Error('Keine Region angegeben');
  const key = list.join(',');
  if (list.length === 1) {
    if (single?.code === key) return single.graph;
    if (joined?.key === key) return joined.graph;
    const graph = await readGraph(list[0]!);
    single = { code: key, graph };
    joined = null;
    return graph;
  }
  if (joined?.key === key) return joined.graph;
  const parts: RouteGraph[] = [];
  for (const code of list) {
    parts.push(single?.code === code ? single.graph : await readGraph(code));
  }
  const graph = mergeGraphs(parts);
  joined = { key, graph };
  single = null;
  return graph;
}

/**
 * Höhenraster einer Region. Gehalten wird immer nur eines: Hessen sind schon
 * 13 MB im Speicher, und gebraucht wird beim Profil ohnehin nur die Region,
 * in der die Linie liegt.
 */
async function loadTerrain(code: string): Promise<Terrain | null> {
  if (terrain?.code === code) return terrain.data;
  try {
    const file = await getOfflineFile(code, 'terrain');
    const buffer = await file.arrayBuffer();
    const data = new Terrain(new Container(parseHeader(buffer), buffer));
    terrain = { code, data };
    return data;
  } catch {
    // Kein Höhenpaket für diese Region — das ist keine Störung, sondern der
    // Normalfall, solange es niemand heruntergeladen hat.
    return null;
  }
}

async function loadSearch(code: string): Promise<SearchIndex> {
  if (index && indexCode === code) return index;
  const file = await getOfflineFile(code, 'search');
  const header = parseHeader(await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer());
  // Alles außer den Hausnummern in den Speicher holen; die liegen am Ende der
  // Datei und werden erst bei Bedarf stückweise gelesen.
  const addr = header.sections['addrBytes'];
  const eagerBytes = header.payloadStart + (addr ? addr.offset : header.payloadBytes);
  const buffer = await file.slice(0, eagerBytes).arrayBuffer();
  index = new SearchIndex(
    new Container(header, buffer),
    async (start, length) => new Uint8Array(await file.slice(start, start + length).arrayBuffer()),
  );
  indexCode = code;
  return index;
}

async function handle(msg: WorkerRequest): Promise<unknown> {
  switch (msg.type) {
    case 'loadRoute': {
      const g = await loadRoute(msg.codes);
      return { nodes: g.nodeCount, edges: g.edgeCount, restrictions: g.restrictionCount, meta: g.meta };
    }
    case 'loadSearch': {
      const s = await loadSearch(msg.code);
      return { entries: s.entryCount, terms: s.termCount, categories: s.categories };
    }
    case 'search': {
      const s = await loadSearch(msg.code);
      return s.query(msg.q, msg.near, msg.limit ?? 12);
    }
    case 'houses': {
      const s = await loadSearch(msg.code);
      return s.houseNumbers(msg.entryId);
    }
    case 'stops': {
      const s = await loadSearch(msg.code);
      return s.inBbox(['bus_stop', 'tram_stop', 'station', 'ferry_terminal'], msg.bbox, msg.limit ?? 600);
    }
    case 'poi': {
      const s = await loadSearch(msg.code);
      return s.inBbox(msg.categories, msg.bbox, msg.limit ?? 400);
    }
    case 'elevation': {
      // Die erste Region, die den Anfang der Linie kennt, gewinnt.
      const start = msg.line[0];
      for (const code of msg.codes) {
        const t = await loadTerrain(code);
        if (!t) continue;
        if (start && !t.covers(start[1], start[0])) continue;
        return elevationProfile(msg.line, t, msg.own);
      }
      // Ohne Raster bleibt noch die Höhe aus der Datei.
      return elevationProfile(msg.line, null, msg.own);
    }
    case 'route': {
      const g = await loadRoute(msg.codes);
      return routeVia(g, [msg.from, ...(msg.via ?? []), msg.to], msg.profile, {
        alternatives: msg.alternatives,
        avoidMotorways: msg.avoidMotorways,
      });
    }
    default:
      throw new Error('Unbekannte Anfrage');
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  handle(msg)
    .then((data) => {
      const res: WorkerResponse = { id: msg.id, ok: true, data };
      (self as unknown as Worker).postMessage(res);
    })
    .catch((err: unknown) => {
      const res: WorkerResponse = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      (self as unknown as Worker).postMessage(res);
    });
};
