/**
 * Wer steht vor dem Server — und darf man ihm glauben?
 *
 * `X-Forwarded-For` und `X-Forwarded-Proto` sind reine Behauptungen des
 * Anfragenden. Auswerten darf man sie nur, wenn die **Verbindung** von einem
 * Proxy kommt, der sie selbst setzt (also überschreibt). Für alles andere gilt
 * die Adresse der Verbindung.
 *
 * Der Unterschied ist keine Feinheit: Zählte die Kopfzeile immer, könnte jeder
 * zu jedem Anmeldeversuch eine andere Absenderkennung erfinden — die Bremse
 * gegen Durchprobieren in `auth.ts` wäre wirkungslos, weil jeder Versuch als
 * erster Versuch eines Unbekannten gälte.
 */

import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config.js';

/**
 * Die Liste als `BlockList` — die bringt Node schon mit, samt richtiger
 * Bitrechnung für IPv4 und IPv6. Einmal gebaut und gemerkt.
 */
let liste: BlockList | null = null;
let listeFuer: string[] | null = null;

function blockList(entries: string[]): BlockList {
  if (liste && listeFuer && listeFuer.length === entries.length && listeFuer.every((e, i) => e === entries[i])) {
    return liste;
  }
  const bl = new BlockList();
  for (const entry of entries) {
    const [addr, prefix] = entry.split('/');
    const ip = (addr ?? '').trim();
    const art = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
    // Unbrauchbares still überspringen: Ein Tippfehler darf kein Vertrauen
    // erschleichen, aber auch nicht den Start verhindern.
    if (!art) continue;
    try {
      if (prefix === undefined) bl.addAddress(ip, art);
      else {
        const bits = Number(prefix);
        if (!Number.isInteger(bits) || bits < 0 || bits > (art === 'ipv4' ? 32 : 128)) continue;
        bl.addSubnet(ip, bits, art);
      }
    } catch {
      /* Node hat den Eintrag abgelehnt — dann gilt er eben nicht. */
    }
  }
  liste = bl;
  listeFuer = [...entries];
  return bl;
}

/**
 * `::ffff:192.0.2.1` → `192.0.2.1`.
 *
 * Auf einem Doppelstapel-Sockel meldet Node IPv4-Verbindungen in dieser Form.
 * Ohne die Umschrift würde ein Eintrag `192.0.2.1` niemals treffen.
 */
function normalisieren(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1]! : addr;
}

/** Adresse der tatsächlichen Verbindung (nicht die behauptete). */
function peer(c: Context): string | undefined {
  const raw = getConnInfo(c).remote.address;
  return raw ? normalisieren(raw) : undefined;
}

/** Kommt diese Verbindung von einem Proxy, dem man glauben darf? */
export function proxyTrusted(c: Context): boolean {
  const trust = config.trustedProxies;
  if (trust.mode === 'none') return false;
  if (trust.mode === 'all') return true;
  const addr = peer(c);
  if (!addr) return false;
  const art = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
  if (!art) return false;
  return blockList(trust.entries).check(addr, art);
}

/**
 * Absenderkennung für die Bremse gegen Durchprobieren.
 *
 * Hinter einem Proxy, dem man glaubt, ist das der erste Eintrag aus
 * `X-Forwarded-For` — sonst die Verbindungsadresse. Ohne Proxy-Vertrauen
 * bekämen hinter einem Proxy **alle Nutzer dieselbe Kennung**, und ein einziger
 * Fremder könnte mit ein paar falschen Passwörtern jeden aussperren.
 */
export function clientKey(c: Context): string {
  if (proxyTrusted(c)) {
    const kopf = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim();
    if (kopf) return normalisieren(kopf);
  }
  return peer(c) ?? 'lokal';
}

/**
 * Läuft die Verbindung über HTTPS? Entscheidet, ob das Anmelde-Merkmal
 * `Secure` tragen darf.
 *
 * Hinter einem TLS-abschließenden Proxy ist der letzte Weg zum Server
 * unverschlüsselt — ohne `X-Forwarded-Proto` bekäme das Cookie deshalb nie
 * `Secure`, obwohl die Seite über HTTPS ausgeliefert wird.
 *
 * Fehlt die Kopfzeile, gilt bewusst wieder das Protokoll der Verbindung:
 * Ein `Secure`-Cookie auf einer HTTP-Seite nimmt der Browser nicht an — dann
 * käme niemand mehr herein.
 */
export function requestIsSecure(c: Context): boolean {
  if (proxyTrusted(c)) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) return proto.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}
