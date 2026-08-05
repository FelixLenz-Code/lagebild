#!/usr/bin/env node
/**
 * build-routing.mjs — erzeugt die Offline-Pakete für Routenplanung und Suche.
 *
 * Aus einem OpenStreetMap-Auszug je Bundesland (Geofabrik, .osm.pbf) entstehen
 * zwei Dateien im Ausgabeordner:
 *
 *   <code>.route    Routing-Graph (Knoten, Kanten, Geometrie, Straßennamen)
 *   <code>.search   Suchindex (Orte, Straßen, POIs, Hausnummern)
 *
 * Nutzung:
 *   scripts/build-routing.mjs                # alle 16 Länder (lädt die PBFs)
 *   scripts/build-routing.mjs 04 10          # nur bestimmte Codes
 *
 * Konfiguration (Env):
 *   PBF_DIR   Ablage der heruntergeladenen .osm.pbf (Default: .cache/osm)
 *   OUT_DIR   Zielordner (Default: apps/api/maps)
 *   PBF       Pfad zu einer bereits vorhandenen .osm.pbf (nur mit einem Code)
 *   KEEP_PBF  auf 0 setzen, um den Auszug nach dem Bauen zu löschen
 *
 * Speicher: große Länder (Bayern, NRW) brauchen ~4 GB Heap. Das Skript startet
 * sich bei Bedarf selbst mit --max-old-space-size neu.
 */

import { existsSync, mkdirSync, statSync, unlinkSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { readPbf } from './lib/pbf.mjs';
import { Growable, StringPool, writeContainer, writeVarint, writeSVarint } from './lib/container.mjs';
import {
  CATEGORIES,
  FLAG,
  PLACE_RANK,
  ROAD_CLASSES,
  catIndex,
  classifyRoad,
  normalize,
  poiCategory,
  poiName,
  terms,
} from './lib/osmtags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Bundesländer: Code → Name und Geofabrik-Kennung. */
const STATES = [
  ['01', 'Schleswig-Holstein', 'schleswig-holstein'],
  ['02', 'Hamburg', 'hamburg'],
  ['03', 'Niedersachsen', 'niedersachsen'],
  ['04', 'Bremen', 'bremen'],
  ['05', 'Nordrhein-Westfalen', 'nordrhein-westfalen'],
  ['06', 'Hessen', 'hessen'],
  ['07', 'Rheinland-Pfalz', 'rheinland-pfalz'],
  ['08', 'Baden-Württemberg', 'baden-wuerttemberg'],
  ['09', 'Bayern', 'bayern'],
  ['10', 'Saarland', 'saarland'],
  ['11', 'Berlin', 'berlin'],
  ['12', 'Brandenburg', 'brandenburg'],
  ['13', 'Mecklenburg-Vorpommern', 'mecklenburg-vorpommern'],
  ['14', 'Sachsen', 'sachsen'],
  ['15', 'Sachsen-Anhalt', 'sachsen-anhalt'],
  ['16', 'Thüringen', 'thueringen'],
];

const PBF_DIR = process.env.PBF_DIR ?? join(ROOT, '.cache/osm');
const OUT_DIR = process.env.OUT_DIR ?? join(ROOT, 'apps/api/maps');
const KEEP_PBF = process.env.KEEP_PBF !== '0';
/** Vereinfachung der Kantengeometrie (Meter) — spart rund die Hälfte der Punkte. */
const SIMPLIFY_M = 4;

/* ------------------------------------------------------------------ */
/* Hilfsmittel                                                         */
/* ------------------------------------------------------------------ */

const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Entfernung in Metern (Haversine). */
function distM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

function human(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

const t0 = Date.now();
const log = (msg) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s] ${msg}`);

/** Binäre Suche in einer sortierten Float64Array. */
function lookupId(ids, id) {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v < id) lo = mid + 1;
    else if (v > id) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * Gitter über Ortspunkte für die Zuordnung „nächstgelegener Ort".
 * Gewichtet: eine Stadt „gewinnt" auch aus größerer Entfernung gegen einen
 * Weiler, damit Straßen sinnvoll beschriftet werden.
 */
class PlaceGrid {
  constructor(places, cellDeg = 0.05) {
    this.places = places;
    this.cell = cellDeg;
    this.map = new Map();
    for (let i = 0; i < places.length; i++) {
      const key = this.key(places[i].lat, places[i].lon);
      let bucket = this.map.get(key);
      if (!bucket) this.map.set(key, (bucket = []));
      bucket.push(i);
    }
  }
  key(lat, lon) {
    return `${Math.floor(lat / this.cell)},${Math.floor(lon / this.cell)}`;
  }
  /** Index des passendsten Orts oder -1. */
  nearest(lat, lon) {
    const cy = Math.floor(lat / this.cell);
    const cx = Math.floor(lon / this.cell);
    let best = -1;
    let bestScore = Infinity;
    for (let r = 0; r <= 40; r++) {
      // Ist der beste Treffer näher als der nächste Ring überhaupt sein kann?
      if (best >= 0 && ((r - 1) * this.cell * 111000) / 4 > bestScore) break;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dy) !== r && Math.abs(dx) !== r) continue;
          const bucket = this.map.get(`${cy + dy},${cx + dx}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const p = this.places[i];
            const score = distM(lat, lon, p.lat, p.lon) / p.weight;
            if (score < bestScore) {
              bestScore = score;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }
}

/** Douglas-Peucker über eine Punktliste [lat, lon, …] (Toleranz in Metern). */
function simplify(pts, toleranceM) {
  const n = pts.length / 2;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(rad(pts[0]));
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2 + 1] * mPerDegLon;
    const ay = pts[a * 2] * mPerDegLat;
    const bx = pts[b * 2 + 1] * mPerDegLon;
    const by = pts[b * 2] * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farDist = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2 + 1] * mPerDegLon;
      const py = pts[i * 2] * mPerDegLat;
      let d;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > farDist) {
        farDist = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return out;
}

/** Natürliche Sortierung von Hausnummern („2", „2a", „10"). */
function houseKey(hn) {
  const m = String(hn).match(/^(\d+)(.*)$/);
  return m ? [Number(m[1]), m[2]] : [Number.MAX_SAFE_INTEGER, String(hn)];
}

/* ------------------------------------------------------------------ */
/* Auszug beschaffen                                                   */
/* ------------------------------------------------------------------ */

async function ensurePbf(slug) {
  if (process.env.PBF) return process.env.PBF;
  mkdirSync(PBF_DIR, { recursive: true });
  const path = join(PBF_DIR, `${slug}-latest.osm.pbf`);
  if (existsSync(path) && statSync(path).size > 1e6) {
    log(`Auszug vorhanden: ${path} (${human(statSync(path).size)})`);
    return path;
  }
  const url = `https://download.geofabrik.de/europe/germany/${slug}-latest.osm.pbf`;
  log(`Lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -5;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastPct + 5) {
      lastPct = pct;
      process.stdout.write(`\r   ${pct} %  (${human(got)})   `);
    }
  });
  await pipeline(body, createWriteStream(`${path}.part`));
  process.stdout.write('\n');
  const { renameSync } = await import('node:fs');
  renameSync(`${path}.part`, path);
  return path;
}

/* ------------------------------------------------------------------ */
/* Abbiegeverbote                                                      */
/* ------------------------------------------------------------------ */

/** Für welche Fortbewegungsarten gilt ein Verbot? (Fuß nie — Verbote gelten Fahrzeugen.) */
const MODE = { CAR: 1, BIKE: 2 };

/**
 * Wertet eine `type=restriction`-Relation aus.
 * @returns {{from:number, via:number, to:number, only:boolean, mask:number}|'via-way'|'unknown'|null}
 */
function parseRestriction(tags, members) {
  const type = tags.type;
  if (!type || !type.startsWith('restriction')) return null;

  // Der Verbotstyp steht je nach Schreibweise unter verschiedenen Schlüsseln.
  let mask = MODE.CAR | MODE.BIKE;
  let kind = tags.restriction;
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith('restriction:')) continue;
    kind = value;
    const mode = key.slice('restriction:'.length);
    if (mode === 'bicycle') mask = MODE.BIKE;
    else if (mode === 'motorcar' || mode === 'motor_vehicle' || mode === 'hgv') mask = MODE.CAR;
  }
  if (type === 'restriction:bicycle') mask = MODE.BIKE;
  if (type === 'restriction:motorcar' || type === 'restriction:motor_vehicle') mask = MODE.CAR;
  if (!kind) return 'unknown';

  // „except=bicycle" nimmt einzelne Arten wieder heraus.
  for (const ex of (tags.except ?? '').split(';')) {
    if (ex === 'bicycle') mask &= ~MODE.BIKE;
    else if (ex === 'motorcar' || ex === 'motor_vehicle') mask &= ~MODE.CAR;
  }
  if (!mask) return null;

  const only = kind.startsWith('only_');
  if (!only && !kind.startsWith('no_')) return 'unknown';

  let from = -1;
  let to = -1;
  let via = -1;
  let viaWay = false;
  for (const m of members) {
    if (m.role === 'from' && m.type === 1) from = m.ref;
    else if (m.role === 'to' && m.type === 1) to = m.ref;
    else if (m.role === 'via') {
      if (m.type === 0) via = m.ref;
      else viaWay = true;
    }
  }
  if (viaWay) return 'via-way';
  if (from < 0 || to < 0 || via < 0) return 'unknown';
  return { from, via, to, only, mask };
}

/** Streckenarten der Wegenetze — passt in ein Byte je Kante. */
export const TRAIL = { HIKE: 1, BIKE: 2, MTB: 4 };

/** Rang des Netzes: je kleiner, desto überregionaler (iwn/icn = 0). */
const NETWORK_RANK = { iwn: 0, icn: 0, nwn: 1, ncn: 1, rwn: 2, rcn: 2, lwn: 3, lcn: 3 };

/**
 * Wertet eine `type=route`-Relation aus (Wander-, Fuß-, Rad- und
 * Mountainbike-Routen). Zurück kommen die Mitglieds-**Wege** — Knoten und
 * Unterrelationen interessieren nicht, gezeichnet wird die Linie.
 */
function parseTrail(tags, members) {
  if (tags.type !== 'route') return null;
  const route = tags.route;
  let mask = 0;
  if (route === 'hiking' || route === 'foot' || route === 'walking') mask = TRAIL.HIKE;
  else if (route === 'bicycle') mask = TRAIL.BIKE;
  else if (route === 'mtb') mask = TRAIL.MTB;
  else return null;

  const ways = [];
  for (const m of members) if (m.type === 1) ways.push(m.ref);
  if (!ways.length) return null;

  // Ohne Namen bleibt die Route trotzdem im Netz — sie wird nur nicht
  // beschriftet. `ref` ist oft die eigentliche Kennung („E1", „D8").
  const name = tags.name ?? null;
  const ref = tags.ref ?? null;
  return {
    ways,
    mask,
    label: ref && name ? `${ref} ${name}` : (name ?? ref),
    rank: NETWORK_RANK[tags.network] ?? 4,
  };
}

/* ------------------------------------------------------------------ */
/* Durchlauf 1 — Wege                                                  */
/* ------------------------------------------------------------------ */

function passWays(pbfPath, strings) {
  // Straßen fürs Routing …
  const refs = new Growable(Float64Array, 1 << 20);
  const wayStart = new Growable(Uint32Array, 1 << 16);
  const wayCount = new Growable(Uint16Array, 1 << 16);
  const wayFlags = new Growable(Uint8Array, 1 << 16);
  const wayCls = new Growable(Uint8Array, 1 << 16);
  const waySpeed = new Growable(Uint8Array, 1 << 16);
  const wayName = new Growable(Uint32Array, 1 << 16);
  const wayIds = new Growable(Float64Array, 1 << 16);
  // … und Flächen, die als Adresse oder POI in die Suche sollen.
  const areaRefs = new Growable(Float64Array, 1 << 18);
  const areaStart = new Growable(Uint32Array, 1 << 14);
  const areaCount = new Growable(Uint8Array, 1 << 14);
  const areaName = new Growable(Uint32Array, 1 << 14);
  const areaCat = new Growable(Uint8Array, 1 << 14);
  const areaHn = new Growable(Uint32Array, 1 << 14);
  const areaStreet = new Growable(Uint32Array, 1 << 14);
  const AREA_REF_CAP = 32;

  const restrictions = [];
  const skipped = { viaWay: 0, unknown: 0 };
  const trails = [];

  readPbf(pbfPath, {
    progress: (f) => process.stdout.write(`\r   Wege … ${Math.round(f * 100)} %   `),
    relation(id, members, tags) {
      const parsed = parseRestriction(tags, members);
      if (parsed === 'via-way') skipped.viaWay++;
      else if (parsed === 'unknown') skipped.unknown++;
      else if (parsed) restrictions.push(parsed);
      const trail = parseTrail(tags, members);
      if (trail) trails.push(trail);
    },
    way(id, wayRefs, tags) {
      const road = classifyRoad(tags);
      if (road && wayRefs.length >= 2) {
        wayIds.push(id);
        wayStart.push(refs.length);
        wayCount.push(Math.min(65535, wayRefs.length));
        wayFlags.push(road.flags);
        wayCls.push(road.cls);
        waySpeed.push(road.speed);
        wayName.push(strings.intern(road.name));
        for (const r of wayRefs) refs.push(r);
      }
      const hn = tags['addr:housenumber'];
      const cat = poiCategory(tags);
      const name = tags.name;
      if ((hn || (cat && name)) && wayRefs.length >= 2) {
        const take = Math.min(wayRefs.length, AREA_REF_CAP);
        areaStart.push(areaRefs.length);
        areaCount.push(take);
        areaName.push(strings.intern(cat ? (name ?? null) : null));
        areaCat.push(catIndex(cat ?? 'address'));
        areaHn.push(strings.intern(hn ?? null));
        areaStreet.push(strings.intern(tags['addr:street'] ?? tags['addr:place'] ?? null));
        for (let i = 0; i < take; i++) areaRefs.push(wayRefs[i]);
      }
    },
  });
  process.stdout.write('\n');
  return {
    refs,
    wayStart,
    wayCount,
    wayFlags,
    wayCls,
    waySpeed,
    wayName,
    wayIds,
    restrictions,
    restrictionsSkipped: skipped,
    trails,
    areaRefs,
    areaStart,
    areaCount,
    areaName,
    areaCat,
    areaHn,
    areaStreet,
  };
}

/* ------------------------------------------------------------------ */
/* Durchlauf 2 — Knoten                                                */
/* ------------------------------------------------------------------ */

function passNodes(pbfPath, needIds, strings) {
  const n = needIds.length;
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  const has = new Uint8Array(n);
  let ptr = 0;
  let unsorted = false;
  let lastId = -1;

  // Punktförmige Adressen, POIs und Ortsmittelpunkte.
  const pois = [];
  const addrs = [];
  const places = [];

  readPbf(pbfPath, {
    progress: (f) => process.stdout.write(`\r   Knoten … ${Math.round(f * 100)} %   `),
    node(id, la, lo, tags) {
      if (!unsorted && id < lastId) unsorted = true;
      lastId = id;
      let idx;
      if (unsorted) {
        idx = lookupId(needIds, id);
      } else {
        while (ptr < n && needIds[ptr] < id) ptr++;
        idx = ptr < n && needIds[ptr] === id ? ptr : -1;
      }
      if (idx >= 0) {
        lat[idx] = Math.round(la * 1e7);
        lon[idx] = Math.round(lo * 1e7);
        has[idx] = 1;
      }
      if (!tags) return;

      const place = tags.place;
      if (place && tags.name && PLACE_RANK[place]) {
        places.push({
          lat: la,
          lon: lo,
          name: tags.name,
          weight: PLACE_RANK[place],
          population: Number(tags.population) || 0,
        });
        return;
      }
      // Ein Punkt kann beides sein: Hausnummer und benannter POI.
      const hn = tags['addr:housenumber'];
      if (hn) {
        addrs.push({
          lat: la,
          lon: lo,
          hn,
          street: strings.intern(tags['addr:street'] ?? tags['addr:place'] ?? null),
        });
      }
      const cat = poiCategory(tags);
      const poiLabel = cat ? poiName(tags, cat) : null;
      if (cat && poiLabel) pois.push({ lat: la, lon: lo, name: poiLabel, cat: catIndex(cat) });
    },
  });
  process.stdout.write('\n');
  return { lat, lon, has, pois, addrs, places };
}

/* ------------------------------------------------------------------ */
/* Graph bauen                                                         */
/* ------------------------------------------------------------------ */

function buildGraph(w, coords, needIds) {
  const { lat, lon, has } = coords;
  const wayN = w.wayStart.length;
  const refCount = new Uint8Array(needIds.length);

  // Wie oft wird ein Knoten von Straßen benutzt? (≥2 → Kreuzung)
  for (let i = 0; i < w.refs.length; i++) {
    const idx = lookupId(needIds, w.refs.get(i));
    w.refs.set(i, idx); // ab hier stehen Indizes statt OSM-IDs im Pool
    if (idx >= 0 && refCount[idx] < 255) refCount[idx]++;
  }

  // Kreuzungen und Wegenden werden Graphknoten.
  const graphIdx = new Int32Array(needIds.length).fill(-1);
  const nodeLat = new Growable(Int32Array, 1 << 18);
  const nodeLon = new Growable(Int32Array, 1 << 18);
  const nodeOf = (idx) => {
    let g = graphIdx[idx];
    if (g < 0) {
      g = nodeLat.length;
      graphIdx[idx] = g;
      nodeLat.push(lat[idx]);
      nodeLon.push(lon[idx]);
    }
    return g;
  };

  const edgeA = new Growable(Uint32Array, 1 << 18);
  const edgeB = new Growable(Uint32Array, 1 << 18);
  const edgeLen = new Growable(Uint32Array, 1 << 18);
  const edgeFlags = new Growable(Uint8Array, 1 << 18);
  const edgeCls = new Growable(Uint8Array, 1 << 18);
  const edgeSpeed = new Growable(Uint8Array, 1 << 18);
  const edgeName = new Growable(Uint32Array, 1 << 18);
  const edgeGeomOff = new Growable(Uint32Array, 1 << 18);
  const edgeGeomLen = new Growable(Uint16Array, 1 << 18);
  const edgeWay = new Growable(Uint32Array, 1 << 18);
  const geom = new Growable(Uint8Array, 1 << 20);

  // Straßenmittelpunkte je Name — Grundlage der Straßen-Sucheinträge.
  const streetPieces = new Map();

  for (let wi = 0; wi < wayN; wi++) {
    const start = w.wayStart.get(wi);
    const count = w.wayCount.get(wi);
    const flags = w.wayFlags.get(wi);
    const cls = w.wayCls.get(wi);
    const speed = w.waySpeed.get(wi);
    const nameId = w.wayName.get(wi);

    let segStart = -1; // Index im Pool, an dem die aktuelle Kante beginnt
    let pts = [];
    let length = 0;
    let prevIdx = -1;
    let midSum = null;

    const flush = (endIdx) => {
      if (segStart < 0 || length < 0.2 || pts.length < 4) return;
      const a = nodeOf(segStart);
      const b = nodeOf(endIdx);
      if (a === b && length < 5) return; // entartete Schleife
      const simplified = simplify(pts, SIMPLIFY_M);
      // Nur die Zwischenpunkte speichern — Anfang und Ende stehen im Knoten.
      const inner = simplified.length / 2 - 2;
      const off = geom.length;
      // In ganzzahligen Mikrograd rechnen — genau so summiert der Leser wieder
      // auf, sonst würde sich der Rundungsfehler über die Punkte aufaddieren.
      let plat = Math.round(simplified[0] * 1e6);
      let plon = Math.round(simplified[1] * 1e6);
      for (let i = 1; i <= inner; i++) {
        const clat = Math.round(simplified[i * 2] * 1e6);
        const clon = Math.round(simplified[i * 2 + 1] * 1e6);
        writeSVarint(geom, clat - plat);
        writeSVarint(geom, clon - plon);
        plat = clat;
        plon = clon;
      }
      edgeA.push(a);
      edgeB.push(b);
      edgeLen.push(Math.min(0xffffffff, Math.round(length * 10)));
      edgeFlags.push(flags);
      edgeCls.push(cls);
      edgeSpeed.push(speed);
      edgeName.push(nameId);
      edgeGeomOff.push(off);
      edgeGeomLen.push(Math.max(0, Math.min(65535, inner)));
      edgeWay.push(wi);
    };

    for (let k = 0; k < count; k++) {
      const idx = w.refs.get(start + k);
      if (idx < 0 || !has[idx]) {
        // Knoten außerhalb des Auszugs → Weg hier abschneiden.
        if (prevIdx >= 0) flush(prevIdx);
        segStart = -1;
        pts = [];
        length = 0;
        prevIdx = -1;
        continue;
      }
      const la = lat[idx] / 1e7;
      const lo = lon[idx] / 1e7;
      if (segStart < 0) {
        segStart = idx;
        pts = [la, lo];
        length = 0;
      } else {
        length += distM(pts[pts.length - 2], pts[pts.length - 1], la, lo);
        pts.push(la, lo);
        const isJunction = refCount[idx] >= 2 || k === count - 1;
        if (isJunction) {
          flush(idx);
          if (midSum === null) midSum = [0, 0, 0];
          midSum[0] += la;
          midSum[1] += lo;
          midSum[2] += 1;
          segStart = idx;
          pts = [la, lo];
          length = 0;
        }
      }
      prevIdx = idx;
    }

    // Namensträger für die Suche merken (Dienstwege bleiben außen vor).
    if (nameId !== 0xffffffff && midSum && cls !== 8) {
      const key = nameId;
      let piece = streetPieces.get(key);
      if (!piece) streetPieces.set(key, (piece = []));
      piece.push({ lat: midSum[0] / midSum[2], lon: midSum[1] / midSum[2] });
    }
  }

  return {
    nodeLat,
    nodeLon,
    edgeA,
    edgeB,
    edgeLen,
    edgeFlags,
    edgeCls,
    edgeSpeed,
    edgeName,
    edgeGeomOff,
    edgeGeomLen,
    edgeWay,
    geom,
    streetPieces,
    // Zuordnung „Knoten im Auszug" → „Knoten im Graphen" (für Abbiegeverbote).
    graphIdx,
  };
}

/**
 * Verwirft winzige, vom Netz abgehängte Teilgraphen (Datenfehler, Inselwege).
 * Ohne das schnappt die Suche gelegentlich auf einen Stummel, von dem aus es
 * keine Route gibt.
 */
function pruneComponents(g, minNodes = 12) {
  const n = g.nodeLat.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const eN = g.edgeA.length;
  for (let e = 0; e < eN; e++) {
    const a = find(g.edgeA.get(e));
    const b = find(g.edgeB.get(e));
    if (a !== b) parent[a] = b;
  }
  const size = new Int32Array(n);
  for (let i = 0; i < n; i++) size[find(i)]++;

  const keepEdge = new Uint8Array(eN);
  let kept = 0;
  for (let e = 0; e < eN; e++) {
    if (size[find(g.edgeA.get(e))] >= minNodes) {
      keepEdge[e] = 1;
      kept++;
    }
  }
  if (kept === eN) return { g: { ...g, nodeMap: null }, dropped: 0 };

  // Kanten und Knoten neu durchnummerieren.
  const nodeMap = new Int32Array(n).fill(-1);
  const nodeLat = new Growable(Int32Array, 1 << 18);
  const nodeLon = new Growable(Int32Array, 1 << 18);
  const remapNode = (i) => {
    if (nodeMap[i] < 0) {
      nodeMap[i] = nodeLat.length;
      nodeLat.push(g.nodeLat.get(i));
      nodeLon.push(g.nodeLon.get(i));
    }
    return nodeMap[i];
  };
  const out = {
    nodeLat,
    nodeLon,
    edgeA: new Growable(Uint32Array, 1 << 18),
    edgeB: new Growable(Uint32Array, 1 << 18),
    edgeLen: new Growable(Uint32Array, 1 << 18),
    edgeFlags: new Growable(Uint8Array, 1 << 18),
    edgeCls: new Growable(Uint8Array, 1 << 18),
    edgeSpeed: new Growable(Uint8Array, 1 << 18),
    edgeName: new Growable(Uint32Array, 1 << 18),
    edgeGeomOff: new Growable(Uint32Array, 1 << 18),
    edgeGeomLen: new Growable(Uint16Array, 1 << 18),
    edgeWay: new Growable(Uint32Array, 1 << 18),
    geom: g.geom,
    streetPieces: g.streetPieces,
    graphIdx: g.graphIdx,
    /** Alte → neue Knotennummer (Abbiegeverbote hängen daran). */
    nodeMap,
  };
  for (let e = 0; e < eN; e++) {
    if (!keepEdge[e]) continue;
    out.edgeA.push(remapNode(g.edgeA.get(e)));
    out.edgeB.push(remapNode(g.edgeB.get(e)));
    out.edgeLen.push(g.edgeLen.get(e));
    out.edgeFlags.push(g.edgeFlags.get(e));
    out.edgeCls.push(g.edgeCls.get(e));
    out.edgeSpeed.push(g.edgeSpeed.get(e));
    out.edgeName.push(g.edgeName.get(e));
    out.edgeGeomOff.push(g.edgeGeomOff.get(e));
    out.edgeGeomLen.push(g.edgeGeomLen.get(e));
    out.edgeWay.push(g.edgeWay.get(e));
  }
  return { g: out, dropped: eN - kept };
}

/* ------------------------------------------------------------------ */
/* Abbiegeverbote auf Kanten abbilden                                  */
/* ------------------------------------------------------------------ */

/**
 * Übersetzt die gesammelten Relationen in Kantenpaare:
 * „von Kante A kommend darf man am Knoten V nicht auf Kante B" (bzw. bei
 * `only_*`: man darf nur auf Kante B).
 */
function resolveRestrictions(w, g, needIds, log) {
  const list = w.restrictions;
  if (!list.length) return { from: new Uint32Array(0), to: new Uint32Array(0), via: new Uint32Array(0), flags: new Uint8Array(0), resolved: 0 };

  // Nur die tatsächlich gebrauchten Wege nachschlagen — eine Tabelle über alle
  // Wege wäre bei großen Ländern zu teuer.
  const needed = new Set();
  for (const r of list) {
    needed.add(r.from);
    needed.add(r.to);
  }
  const wayIndexById = new Map();
  for (let i = 0; i < w.wayIds.length; i++) {
    const id = w.wayIds.get(i);
    if (needed.has(id)) wayIndexById.set(id, i);
  }

  // Kanten je Weg (Zählsortierung).
  const edgeCount = g.edgeA.length;
  const wayCount = w.wayIds.length;
  const counts = new Uint32Array(wayCount + 1);
  for (let e = 0; e < edgeCount; e++) counts[g.edgeWay.get(e)]++;
  const off = new Uint32Array(wayCount + 1);
  let sum = 0;
  for (let i = 0; i < wayCount; i++) {
    off[i] = sum;
    sum += counts[i];
  }
  off[wayCount] = sum;
  const fill = off.slice();
  const wayEdges = new Uint32Array(sum);
  for (let e = 0; e < edgeCount; e++) wayEdges[fill[g.edgeWay.get(e)]++] = e;

  /** Kante des Weges, die den Knoten berührt. */
  const edgeAt = (wayIdx, node) => {
    for (let i = off[wayIdx]; i < off[wayIdx + 1]; i++) {
      const e = wayEdges[i];
      if (g.edgeA.get(e) === node || g.edgeB.get(e) === node) return e;
    }
    return -1;
  };

  const outFrom = new Growable(Uint32Array, 1024);
  const outTo = new Growable(Uint32Array, 1024);
  const outVia = new Growable(Uint32Array, 1024);
  const outFlags = new Growable(Uint8Array, 1024);
  let missed = 0;

  for (const r of list) {
    const fromWay = wayIndexById.get(r.from);
    const toWay = wayIndexById.get(r.to);
    if (fromWay === undefined || toWay === undefined) {
      missed++;
      continue;
    }
    const idx = lookupId(needIds, r.via);
    if (idx < 0) {
      missed++;
      continue;
    }
    let node = g.graphIdx[idx];
    if (node < 0) {
      missed++;
      continue;
    }
    // Nach dem Verwerfen der Insellagen sind die Knoten neu nummeriert.
    if (g.nodeMap) {
      node = g.nodeMap[node];
      if (node < 0) {
        missed++;
        continue;
      }
    }
    const fromEdge = edgeAt(fromWay, node);
    const toEdge = edgeAt(toWay, node);
    if (fromEdge < 0 || toEdge < 0 || fromEdge === toEdge) {
      missed++;
      continue;
    }
    outFrom.push(fromEdge);
    outTo.push(toEdge);
    outVia.push(node);
    outFlags.push((r.only ? 128 : 0) | r.mask);
  }

  log(
    `   Abbiegeverbote: ${outFrom.length} übernommen, ${missed} ohne Treffer, ` +
      `${w.restrictionsSkipped.viaWay} über Wege (nicht unterstützt), ${w.restrictionsSkipped.unknown} unklar`,
  );
  return {
    from: outFrom.view(),
    to: outTo.view(),
    via: outVia.view(),
    flags: outFlags.view(),
    resolved: outFrom.length,
  };
}

/* ------------------------------------------------------------------ */
/* Suchindex bauen                                                     */
/* ------------------------------------------------------------------ */

function buildSearch(strings, graph, nodes, areas, code, stateName) {
  // Orte: gleiche Namen zusammenfassen (Doppelnennungen in OSM).
  const places = nodes.places;
  places.sort((a, b) => b.population - a.population || b.weight - a.weight);
  const grid = new PlaceGrid(places);
  const placeName = (i) => (i >= 0 ? places[i].name : null);

  /** Eintrag: type 0 = Ort, 1 = Straße, 2 = POI. */
  const entries = [];
  const addrGroups = new Map(); // key → Adressliste

  for (const p of places) {
    entries.push({ type: 0, cat: catIndex('place'), lat: p.lat, lon: p.lon, name: p.name, city: null });
  }

  // Straßen: je Name und zugeordnetem Ort ein Eintrag.
  for (const [nameId, pieces] of graph.streetPieces) {
    const name = strings.get(nameId);
    if (!name) continue;
    const byPlace = new Map();
    for (const piece of pieces) {
      const pi = grid.nearest(piece.lat, piece.lon);
      const key = pi;
      let acc = byPlace.get(key);
      if (!acc) byPlace.set(key, (acc = { lat: 0, lon: 0, n: 0 }));
      acc.lat += piece.lat;
      acc.lon += piece.lon;
      acc.n++;
    }
    for (const [pi, acc] of byPlace) {
      entries.push({
        type: 1,
        cat: catIndex('street'),
        lat: acc.lat / acc.n,
        lon: acc.lon / acc.n,
        name,
        city: placeName(pi),
        key: `${normalize(name)}|${pi}`,
      });
    }
  }

  const streetByKey = new Map();
  for (const e of entries) if (e.type === 1) streetByKey.set(e.key, e);

  /** Adresse einsortieren: an die passende Straße hängen. */
  const addAddress = (lat, lon, hn, streetId) => {
    const street = strings.get(streetId);
    if (!street || !hn) return;
    const pi = grid.nearest(lat, lon);
    const key = `${normalize(street)}|${pi}`;
    let group = addrGroups.get(key);
    if (!group) addrGroups.set(key, (group = { street, city: placeName(pi), list: [] }));
    if (group.list.length < 20000) group.list.push({ lat, lon, hn });
  };

  for (const a of nodes.addrs) addAddress(a.lat, a.lon, a.hn, a.street);
  for (const a of areas.addrs) addAddress(a.lat, a.lon, a.hn, a.street);

  // POIs (Punkte und Flächen).
  for (const p of nodes.pois) {
    entries.push({ type: 2, cat: p.cat, lat: p.lat, lon: p.lon, name: p.name, city: null });
  }
  for (const p of areas.pois) {
    entries.push({ type: 2, cat: p.cat, lat: p.lat, lon: p.lon, name: p.name, city: null });
  }

  // Adressgruppen ohne passende Straße bekommen einen eigenen Eintrag.
  for (const [key, group] of addrGroups) {
    let street = streetByKey.get(key);
    if (!street) {
      let lat = 0;
      let lon = 0;
      for (const a of group.list) {
        lat += a.lat;
        lon += a.lon;
      }
      street = {
        type: 1,
        cat: catIndex('street'),
        lat: lat / group.list.length,
        lon: lon / group.list.length,
        name: group.street,
        city: group.city,
        key,
      };
      entries.push(street);
      streetByKey.set(key, street);
    }
    street.addresses = group.list;
  }

  // Ortsnamen an POIs hängen (für „Apotheke Bremen").
  for (const e of entries) {
    if (e.city == null && e.type !== 0) e.city = placeName(grid.nearest(e.lat, e.lon));
  }

  log(`   Sucheinträge: ${entries.length}, Adressgruppen: ${addrGroups.size}`);

  /* --- Serialisieren --- */
  const pool = new StringPool();
  const catKeys = Object.keys(CATEGORIES);
  const n = entries.length;
  const eType = new Uint8Array(n);
  const eCat = new Uint8Array(n);
  const eLat = new Int32Array(n);
  const eLon = new Int32Array(n);
  const eName = new Uint32Array(n);
  const eCity = new Uint32Array(n);
  const eAddrOff = new Uint32Array(n);
  const eAddrCount = new Uint32Array(n);
  const addrBytes = new Growable(Uint8Array, 1 << 20);
  const postings = new Map();

  for (let i = 0; i < n; i++) {
    const e = entries[i];
    eType[i] = e.type;
    eCat[i] = e.cat;
    eLat[i] = Math.round(e.lat * 1e7);
    eLon[i] = Math.round(e.lon * 1e7);
    eName[i] = pool.intern(e.name);
    eCity[i] = pool.intern(e.city);

    if (e.addresses && e.addresses.length) {
      e.addresses.sort((a, b) => {
        const ka = houseKey(a.hn);
        const kb = houseKey(b.hn);
        return ka[0] - kb[0] || String(ka[1]).localeCompare(String(kb[1]));
      });
      eAddrOff[i] = addrBytes.length;
      eAddrCount[i] = e.addresses.length;
      for (const a of e.addresses) {
        const hnBytes = Buffer.from(a.hn, 'utf8');
        writeVarint(addrBytes, hnBytes.length);
        for (const b of hnBytes) addrBytes.push(b);
        writeSVarint(addrBytes, Math.round(a.lat * 1e7) - eLat[i]);
        writeSVarint(addrBytes, Math.round(a.lon * 1e7) - eLon[i]);
      }
    } else {
      eAddrOff[i] = 0xffffffff;
    }

    // Suchbegriffe: Name, Ort und (bei POIs) die Kategoriebezeichnung.
    const words = terms(e.name);
    if (e.city) for (const t of terms(e.city)) words.add(t);
    if (e.type === 2) for (const t of terms(CATEGORIES[catKeys[e.cat]].label)) words.add(t);
    for (const t of words) {
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      list.push(i);
    }
  }

  const termList = [...postings.keys()].sort();
  const termPool = new StringPool();
  for (const t of termList) termPool.intern(t);
  let postCount = 0;
  for (const t of termList) postCount += postings.get(t).length;
  const postOff = new Uint32Array(termList.length + 1);
  const postData = new Uint32Array(postCount);
  let pos = 0;
  for (let i = 0; i < termList.length; i++) {
    postOff[i] = pos;
    const list = postings.get(termList[i]);
    for (const v of list) postData[pos++] = v;
  }
  postOff[termList.length] = pos;

  const str = pool.serialize();
  const term = termPool.serialize();
  return {
    meta: {
      format: 'search',
      code,
      state: stateName,
      entries: n,
      addresses: eAddrCount.reduce((a, b) => a + b, 0),
      terms: termList.length,
      categories: CATEGORIES,
      categoryKeys: catKeys,
    },
    sections: [
      { name: 'entryType', data: eType },
      { name: 'entryCat', data: eCat },
      { name: 'entryLat', data: eLat },
      { name: 'entryLon', data: eLon },
      { name: 'entryName', data: eName },
      { name: 'entryCity', data: eCity },
      { name: 'entryAddrOff', data: eAddrOff },
      { name: 'entryAddrCount', data: eAddrCount },
      { name: 'strOff', data: str.offsets },
      { name: 'strBytes', data: str.bytes },
      { name: 'termOff', data: term.offsets },
      { name: 'termBytes', data: term.bytes },
      { name: 'postOff', data: postOff },
      { name: 'postings', data: postData },
      { name: 'addrBytes', data: addrBytes.view() },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Ein Bundesland bauen                                                */
/* ------------------------------------------------------------------ */

async function buildState(code, stateName, slug) {
  const pbfPath = await ensurePbf(slug);
  log(`${code} ${stateName}: Durchlauf 1 (Wege)`);
  const strings = new StringPool();
  const w = passWays(pbfPath, strings);
  log(`   Straßen: ${w.wayStart.length}, Flächen für die Suche: ${w.areaStart.length}`);

  // Alle benötigten Knoten-IDs sortiert und ohne Dubletten.
  log('   Knotenliste sortieren …');
  const all = new Float64Array(w.refs.length + w.areaRefs.length);
  all.set(w.refs.view(), 0);
  all.set(w.areaRefs.view(), w.refs.length);
  all.sort();
  let uniqueCount = 0;
  for (let i = 0; i < all.length; i++) {
    if (i === 0 || all[i] !== all[i - 1]) all[uniqueCount++] = all[i];
  }
  const needIds = all.subarray(0, uniqueCount);
  log(`   benötigte Knoten: ${uniqueCount}`);

  log(`${code} ${stateName}: Durchlauf 2 (Knoten)`);
  const nodes = passNodes(pbfPath, needIds, strings);

  // Flächen → Schwerpunkt (Adressen und POIs auf Gebäuden).
  const areas = { addrs: [], pois: [] };
  for (let i = 0; i < w.areaStart.length; i++) {
    const start = w.areaStart.get(i);
    const count = w.areaCount.get(i);
    let lat = 0;
    let lon = 0;
    let hits = 0;
    for (let k = 0; k < count; k++) {
      const idx = lookupId(needIds, w.areaRefs.get(start + k));
      if (idx >= 0 && nodes.has[idx]) {
        lat += nodes.lat[idx];
        lon += nodes.lon[idx];
        hits++;
      }
    }
    if (!hits) continue;
    const la = lat / hits / 1e7;
    const lo = lon / hits / 1e7;
    const hn = strings.get(w.areaHn.get(i));
    const name = strings.get(w.areaName.get(i));
    if (hn) areas.addrs.push({ lat: la, lon: lo, hn, street: w.areaStreet.get(i) });
    if (name) areas.pois.push({ lat: la, lon: lo, name, cat: w.areaCat.get(i) });
  }
  log(`   Adressen: ${nodes.addrs.length + areas.addrs.length}, POIs: ${nodes.pois.length + areas.pois.length}, Orte: ${nodes.places.length}`);

  log('   Graph bauen …');
  const built = buildGraph(w, nodes, needIds);
  const { g, dropped } = pruneComponents(built);
  log(
    `   Knoten: ${g.nodeLat.length}, Kanten: ${g.edgeA.length}` +
      (dropped ? ` (${dropped} in Insellagen verworfen)` : ''),
  );

  // Bounding-Box des Graphen.
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  const nl = g.nodeLat.view();
  const no = g.nodeLon.view();
  for (let i = 0; i < nl.length; i++) {
    const la = nl[i] / 1e7;
    const lo = no[i] / 1e7;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }

  const restrictions = resolveRestrictions(w, g, needIds, log);

  // Straßennamen als eigene Zeichenkettentabelle (nur die benutzten).
  const namePool = new StringPool();
  /* --- Wander- und Radwegenetz auf die Kanten legen --- */
  // Die Relationen stehen in der PBF hinter den Wegen; nachgeschlagen wird
  // deshalb erst hier, und zwar nur für die Wege, die im Graphen gelandet
  // sind — eine Map über alle Wege des Landes wäre unnötig groß.
  const trailByWay = new Map();
  for (const t of w.trails) {
    for (const id of t.ways) {
      const found = trailByWay.get(id);
      if (!found) trailByWay.set(id, { mask: t.mask, label: t.label, rank: t.rank });
      else {
        found.mask |= t.mask;
        // Die überregionalere Route gibt den Namen — sonst gewönne eine
        // beliebige Ortsrunde gegen den Europäischen Fernwanderweg.
        if (t.rank < found.rank || (found.label == null && t.label != null)) {
          found.label = t.label ?? found.label;
          found.rank = Math.min(found.rank, t.rank);
        }
      }
    }
  }
  const edgeTrail = new Uint8Array(g.edgeA.length);
  const edgeTrailName = new Uint32Array(g.edgeA.length);
  let trailEdges = 0;
  if (trailByWay.size) {
    for (let e = 0; e < g.edgeA.length; e++) {
      const found = trailByWay.get(w.wayIds.get(g.edgeWay.get(e)));
      if (!found) continue;
      edgeTrail[e] = found.mask;
      edgeTrailName[e] = namePool.intern(found.label ?? null);
      trailEdges++;
    }
  }
  log(
    `   Wegenetz: ${w.trails.length} Routen, ${trailEdges} Kanten (${Math.round((trailEdges / Math.max(1, g.edgeA.length)) * 100)} %)`,
  );

  const edgeName = new Uint32Array(g.edgeName.length);
  for (let i = 0; i < g.edgeName.length; i++) {
    edgeName[i] = namePool.intern(strings.get(g.edgeName.get(i)));
  }
  const nameTable = namePool.serialize();

  const nodesXY = new Int32Array(nl.length * 2);
  for (let i = 0; i < nl.length; i++) {
    nodesXY[i * 2] = nl[i];
    nodesXY[i * 2 + 1] = no[i];
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const routePath = join(OUT_DIR, `${code}.route`);
  await writeContainer(
    routePath,
    {
      format: 'route',
      code,
      state: stateName,
      builtAt: new Date().toISOString(),
      nodeCount: nl.length,
      edgeCount: g.edgeA.length,
      restrictionCount: restrictions.resolved,
      trailEdges,
      trails: TRAIL,
      bbox: [minLon, minLat, maxLon, maxLat],
      classes: ROAD_CLASSES,
      flags: FLAG,
      geomScale: 1e6,
      coordScale: 1e7,
    },
    [
      { name: 'nodes', data: nodesXY },
      { name: 'edgeA', data: g.edgeA.view() },
      { name: 'edgeB', data: g.edgeB.view() },
      { name: 'edgeLen', data: g.edgeLen.view() },
      { name: 'edgeFlags', data: g.edgeFlags.view() },
      { name: 'edgeClass', data: g.edgeCls.view() },
      { name: 'edgeSpeed', data: g.edgeSpeed.view() },
      { name: 'edgeName', data: edgeName },
      { name: 'edgeTrail', data: edgeTrail },
      { name: 'edgeTrailName', data: edgeTrailName },
      { name: 'edgeGeomOff', data: g.edgeGeomOff.view() },
      { name: 'edgeGeomLen', data: g.edgeGeomLen.view() },
      { name: 'geom', data: g.geom.view() },
      { name: 'nameOff', data: nameTable.offsets },
      { name: 'nameBytes', data: nameTable.bytes },
      { name: 'restrFrom', data: restrictions.from },
      { name: 'restrTo', data: restrictions.to },
      { name: 'restrVia', data: restrictions.via },
      { name: 'restrFlags', data: restrictions.flags },
    ],
  );
  log(`   ${routePath} — ${human(statSync(routePath).size)}`);

  log('   Suchindex bauen …');
  const search = buildSearch(strings, g, nodes, areas, code, stateName);
  const searchPath = join(OUT_DIR, `${code}.search`);
  await writeContainer(searchPath, { ...search.meta, builtAt: new Date().toISOString(), bbox: [minLon, minLat, maxLon, maxLat] }, search.sections);
  log(`   ${searchPath} — ${human(statSync(searchPath).size)}`);

  if (!KEEP_PBF && !process.env.PBF) unlinkSync(pbfPath);
}

/* ------------------------------------------------------------------ */

async function main() {
  const want = process.argv.slice(2).filter((a) => /^\d{2}$/.test(a));
  const list = STATES.filter(([code]) => want.length === 0 || want.includes(code));
  if (!list.length) {
    console.error('Keine gültigen Bundesland-Codes angegeben (01–16).');
    process.exit(1);
  }
  console.log(`Ziel: ${OUT_DIR}`);
  for (const [code, name, slug] of list) {
    await buildState(code, name, slug);
  }
  console.log('\nFertig. Der API-Server liefert die Dateien unter /api/maps aus.');
}

// Große Länder brauchen mehr Heap, als Node standardmäßig gibt.
if (!process.env.LAGEBILD_RESPAWNED) {
  const res = spawnSync(
    process.execPath,
    ['--max-old-space-size=6144', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, LAGEBILD_RESPAWNED: '1' } },
  );
  process.exit(res.status ?? 1);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
