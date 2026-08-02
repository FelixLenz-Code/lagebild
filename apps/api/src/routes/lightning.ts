import { Hono } from 'hono';
import { WebSocket } from 'ws';
import type { LightningStrike } from '@lagebild/shared';
import { envelope } from '../lib/envelope.js';
import { readBbox } from '../lib/geo.js';

/**
 * Blitzortung: Entladungen in Echtzeit.
 *
 * Quelle ist das **Blitzortung.org**-Netz — ein ehrenamtlicher Verbund
 * privater Empfangsstationen, dessen Live-Karte ihre Daten über einen
 * WebSocket bezieht. Genau der wird hier angezapft: eine Verbindung für den
 * ganzen Server, die Treffer liegen im Speicher und werden von dort nach
 * Ausschnitt beantwortet.
 *
 * **Bitte des Betreibers (eingehalten):** Die Daten stammen von Freiwilligen
 * und sind für private, nicht gewerbliche Nutzung gedacht; Quellenangabe ist
 * erwünscht. Deshalb: nur **eine** Verbindung statt einer je Besucher,
 * Wiederaufbau mit wachsendem Abstand, keine Archivierung über die
 * Anzeigedauer hinaus, Nennung samt Rücklink in der App.
 * https://www.blitzortung.org/
 */
export const lightningRoute = new Hono();

/** Nach dieser Zeit verschwindet ein Blitz von der Karte. */
const TTL_MS = 30 * 60_000;
/** Obergrenze für den Speicher (bei Gewitterlagen kommen viele). */
const MAX_STRIKES = 20000;
/** Reihum, damit nicht immer derselbe Knoten belastet wird. */
const HOSTS = ['wss://ws1.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'];

/**
 * Die Nachrichten sind wörterbuchkomprimiert (LZW-Abkömmling), genau wie sie
 * die eigene Live-Karte auspackt: Zeichen unter 256 sind sie selbst, alles
 * darüber verweist auf eine zuvor gebildete Kette.
 */
function inflate(input: string): string {
  const dict = new Map<number, string>();
  let next = 256;
  let previous = input[0] ?? '';
  const out: string[] = [previous];
  for (let i = 1; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const entry =
      code < 256 ? input[i]! : (dict.get(code) ?? previous + previous[0]);
    out.push(entry);
    dict.set(next++, previous + entry[0]);
    previous = entry;
  }
  return out.join('');
}

interface RawStrike {
  /** Zeitpunkt in **Nanosekunden** seit 1970. */
  time?: number;
  lat?: number;
  lon?: number;
  /** Beteiligte Empfangsstationen — grobes Maß für die Verlässlichkeit. */
  sig?: unknown[];
  /** Abweichung der Ortung in Metern. */
  mds?: number;
  status?: number;
}

interface Entry extends LightningStrike {
  at: number;
  key: string;
}

const strikes: Entry[] = [];
/**
 * Derselbe Blitz kommt gelegentlich mehrfach herein (mehrere Knoten, erneute
 * Verbindung). Schlüssel aus Zeit und Ort halten die Karte sauber.
 */
const seenKeys = new Set<string>();
let socket: WebSocket | null = null;
let hostIndex = 0;
let retryMs = 2000;
let seen = 0;

function handle(raw: string): void {
  let msg: RawStrike;
  try {
    msg = JSON.parse(inflate(raw)) as RawStrike;
  } catch {
    return;
  }
  if (typeof msg.lat !== 'number' || typeof msg.lon !== 'number') return;
  // Der Zeitstempel kommt in Nanosekunden; ohne ihn zählt die Ankunft.
  const t = typeof msg.time === 'number' ? Math.round(msg.time / 1e6) : Date.now();
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > TTL_MS) return;
  const key = `${t}:${msg.lat.toFixed(4)}:${msg.lon.toFixed(4)}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  strikes.push({
    at: t,
    key,
    time: new Date(t).toISOString(),
    lat: msg.lat,
    lon: msg.lon,
    stations: Array.isArray(msg.sig) ? msg.sig.length : 0,
    accuracyM: typeof msg.mds === 'number' ? Math.round(msg.mds) : null,
  });
  seen++;
  if (strikes.length > MAX_STRIKES) {
    for (const gone of strikes.splice(0, strikes.length - MAX_STRIKES)) seenKeys.delete(gone.key);
  }
}

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  let i = 0;
  while (i < strikes.length && strikes[i]!.at < cutoff) i++;
  if (i > 0) for (const gone of strikes.splice(0, i)) seenKeys.delete(gone.key);
}

function connect(): void {
  if (socket) return;
  const host = HOSTS[hostIndex % HOSTS.length]!;
  hostIndex++;
  const ws = new WebSocket(host, { headers: { Origin: 'https://map.blitzortung.org' } });
  socket = ws;

  ws.on('open', () => {
    retryMs = 2000;
    // Anmeldung wie bei der Live-Karte: alles, was hereinkommt.
    ws.send('{"a":111}');
  });
  ws.on('message', (data: Buffer) => handle(data.toString()));
  ws.on('error', () => {
    /* der close-Handler baut neu auf */
  });
  ws.on('close', () => {
    socket = null;
    setTimeout(connect, retryMs).unref?.();
    retryMs = Math.min(retryMs * 2, 60_000);
  });
}

/** Sammler starten (einmal beim Serverstart). */
export function startLightningCollector(): void {
  connect();
  setInterval(prune, 60_000).unref();
}

/** true, sobald wirklich Treffer eingehen — steuert die Ebene im Menü. */
export function lightningUsable(): boolean {
  return seen > 0;
}

/**
 *   GET /api/lightning?bbox=west,süd,ost,nord[&minutes=30]
 *
 * Liefert die Entladungen im Ausschnitt, neueste zuerst.
 */
lightningRoute.get('/', (c) => {
  const bbox = readBbox(c);
  const minutes = Math.min(60, Math.max(1, Number(c.req.query('minutes') ?? 30) || 30));
  const cutoff = Date.now() - minutes * 60_000;

  let list = strikes.filter((s) => s.at >= cutoff);
  if (bbox) {
    list = list.filter(
      (s) => s.lon >= bbox.west && s.lon <= bbox.east && s.lat >= bbox.south && s.lat <= bbox.north,
    );
  }
  // Neueste zuerst und begrenzt — die Karte zeichnet ohnehin nicht mehr.
  const data: LightningStrike[] = list
    .slice(-4000)
    .reverse()
    .map(({ time, lat, lon, stations, accuracyM }) => ({ time, lat, lon, stations, accuracyM }));

  return c.json(envelope(data, 'Blitzortung.org'));
});
