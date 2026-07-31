import { Hono } from 'hono';
import { WebSocket } from 'ws';
import type { Coords, Vessel, VesselStatus } from '@lagebild/shared';
import { config } from '../config.js';
import { envelope } from '../lib/envelope.js';
import { readBbox, inBbox } from '../lib/geo.js';

/**
 * Schiffsverkehr aus dem AIS-Netz über aisstream.io (kostenlos, Key nötig).
 * aisstream schiebt Meldungen per WebSocket — der Server hält deshalb die
 * zuletzt gesehenen Schiffe kurz im Speicher und beantwortet daraus die
 * Ausschnitts-Abfragen. Ohne `AISSTREAM_KEY` bleibt die Ebene einfach aus.
 * https://aisstream.io/documentation
 */
export const vesselsRoute = new Hono();

/** Nach dieser Zeit ohne neue Meldung gilt eine Position als veraltet. */
const TTL_MS = 20 * 60_000;
/** Obergrenze, damit der Speicher auch bei dichtem Verkehr beschränkt bleibt. */
const MAX_VESSELS = 20000;

interface AisMetaData {
  MMSI?: number;
  ShipName?: string;
  latitude?: number;
  longitude?: number;
  time_utc?: string;
}
interface AisMessage {
  MessageType?: string;
  MetaData?: AisMetaData;
  Message?: {
    PositionReport?: {
      Cog?: number;
      Sog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      Name?: string;
      Type?: number;
      Destination?: string;
      Dimension?: { A?: number; B?: number; C?: number; D?: number };
    };
  };
}

/** AIS-Navigationsstatus (Feldwerte 0–15) auf wenige Klassen eindampfen. */
function toStatus(code: number | undefined): VesselStatus | null {
  switch (code) {
    case 0:
    case 8:
      return 'under-way';
    case 1:
      return 'anchored';
    case 2:
      return 'not-under-command';
    case 5:
      return 'moored';
    case 6:
      return 'aground';
    case 7:
      return 'fishing';
    case undefined:
    case 15:
      return null;
    default:
      return 'other';
  }
}

/** AIS-Schiffstyp (Feldwerte 20–99) auf Symbolgruppen abbilden. */
function toKind(type: number | undefined): Vessel['kind'] {
  if (type == null) return 'other';
  if (type >= 80 && type <= 89) return 'tanker';
  if (type >= 70 && type <= 79) return 'cargo';
  if (type >= 60 && type <= 69) return 'passenger';
  if (type >= 40 && type <= 49) return 'high-speed';
  if (type === 30) return 'fishing';
  if (type === 31 || type === 32 || type === 52) return 'tug';
  if (type === 36) return 'sailing';
  if (type === 37) return 'pleasure';
  if (type === 35 || type === 51 || type === 53 || type === 55) return 'authority';
  return 'other';
}

/**
 * Ein Schiff im Speicher. Stammdaten (Name, Typ, Ziel) und Positionen kommen
 * als getrennte Meldungen und in beliebiger Reihenfolge — beides wird hier
 * zusammengeführt. Ausgeliefert werden nur Schiffe mit bekannter Position.
 */
interface Entry extends Omit<Vessel, 'coordinates'> {
  coordinates: Coords | null;
  updatedAt: number;
  /** Zeitpunkt der letzten Positionsmeldung. */
  positionAt: number;
}

const fleet = new Map<number, Entry>();
let socket: WebSocket | null = null;
let connected = false;
let retryMs = 2000;

const EMPTY: Omit<Entry, 'mmsi'> = {
  name: null,
  kind: 'other',
  coordinates: null,
  speedKt: null,
  courseDeg: null,
  headingDeg: null,
  status: null,
  destination: null,
  lengthM: null,
  reportedAt: new Date(0).toISOString(),
  updatedAt: 0,
  positionAt: 0,
};

function upsert(mmsi: number, patch: Partial<Entry>): void {
  fleet.set(mmsi, { ...EMPTY, mmsi, ...fleet.get(mmsi), ...patch, updatedAt: Date.now() });
}

function handle(raw: string): void {
  let msg: AisMessage;
  try {
    msg = JSON.parse(raw) as AisMessage;
  } catch {
    return;
  }
  const meta = msg.MetaData;
  const mmsi = meta?.MMSI;
  if (!mmsi) return;
  const name = meta?.ShipName?.trim().replace(/@+$/, '') || undefined;

  if (msg.MessageType === 'PositionReport' && msg.Message?.PositionReport) {
    const p = msg.Message.PositionReport;
    if (typeof meta?.latitude !== 'number' || typeof meta?.longitude !== 'number') return;
    upsert(mmsi, {
      ...(name ? { name } : {}),
      coordinates: { lat: meta.latitude, lon: meta.longitude },
      speedKt: typeof p.Sog === 'number' && p.Sog < 102.3 ? p.Sog : null,
      courseDeg: typeof p.Cog === 'number' && p.Cog < 360 ? p.Cog : null,
      headingDeg: typeof p.TrueHeading === 'number' && p.TrueHeading < 360 ? p.TrueHeading : null,
      status: toStatus(p.NavigationalStatus),
      reportedAt: new Date().toISOString(),
      positionAt: Date.now(),
    });
  } else if (msg.MessageType === 'ShipStaticData' && msg.Message?.ShipStaticData) {
    const s = msg.Message.ShipStaticData;
    const dim = s.Dimension;
    const lengthM = dim && (dim.A || dim.B) ? (dim.A ?? 0) + (dim.B ?? 0) : null;
    upsert(mmsi, {
      name: s.Name?.trim().replace(/@+$/, '') || name || null,
      kind: toKind(s.Type),
      destination: s.Destination?.trim().replace(/@+$/, '') || null,
      lengthM,
    });
  }
}

/** Zu große/alte Einträge wegräumen — der Speicher bleibt so beschränkt. */
function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [mmsi, v] of fleet) if (v.updatedAt < cutoff) fleet.delete(mmsi);
  if (fleet.size > MAX_VESSELS) {
    const oldest = [...fleet.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [mmsi] of oldest.slice(0, fleet.size - MAX_VESSELS)) fleet.delete(mmsi);
  }
}

/** Verbindet (und hält) den AIS-Stream für den konfigurierten Ausschnitt. */
function connect(): void {
  if (!config.aisKey || socket) return;
  const ws = new WebSocket(config.aisUrl);
  socket = ws;

  ws.on('open', () => {
    connected = true;
    retryMs = 2000;
    ws.send(
      JSON.stringify({
        APIKey: config.aisKey,
        BoundingBoxes: [config.aisBbox],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }),
    );
  });
  ws.on('message', (data: Buffer) => handle(data.toString()));
  ws.on('error', () => {
    /* Der close-Handler übernimmt den Neuaufbau. */
  });
  ws.on('close', () => {
    connected = false;
    socket = null;
    // Mit wachsendem Abstand neu verbinden (max. 1 Minute).
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  });
}

export function startAisCollector(): void {
  if (!config.aisKey) return;
  connect();
  setInterval(prune, 60_000).unref();
}

/** true, sobald der Stream Daten liefert (steuert den Karten-Chip). */
export function aisUsable(): boolean {
  return Boolean(config.aisKey) && connected && fleet.size > 0;
}

vesselsRoute.get('/', (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  if (!config.aisKey) return c.json(envelope([] as Vessel[], 'AIS (kein Key)'));

  const cutoff = Date.now() - TTL_MS;
  const visible: Vessel[] = [];
  for (const v of fleet.values()) {
    // Schiffe ohne (frische) Positionsmeldung bleiben außen vor.
    if (!v.coordinates || v.positionAt < cutoff || !inBbox(v.coordinates, bbox)) continue;
    const { updatedAt: _updatedAt, positionAt: _positionAt, ...vessel } = v;
    visible.push({ ...vessel, coordinates: v.coordinates });
  }
  visible.sort((a, b) => (b.lengthM ?? 0) - (a.lengthM ?? 0));
  return c.json(envelope(visible.slice(0, 1500), 'aisstream.io'));
});
