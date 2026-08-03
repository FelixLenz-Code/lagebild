/**
 * Ein gemeinsames Passwort vor dem Server.
 *
 * Bewusst **ohne Sitzungsverwaltung**: Der Schlüssel für das Merkmal wird aus
 * dem Passwort abgeleitet, nicht gespeichert. Der Server bleibt damit
 * zustandslos wie bisher — und ein geändertes Passwort meldet nebenbei alle
 * Geräte ab, ganz ohne Buchführung.
 *
 * Ist `APP_PASSWORD` leer, ist der Schutz aus. Das ist Absicht: Die Entwicklung
 * läuft weiter wie bisher, und niemand sperrt sich beim Ausprobieren aus.
 */

import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Laufzeit des Merkmals. Bewusst lang — niemand soll unterwegs herausfliegen. */
export const TOKEN_DAYS = 400;
/** Ab diesem Alter wird das Merkmal bei einer gültigen Anfrage erneuert. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const COOKIE_NAME = 'lagebild_auth';

/**
 * Festes Salz: Der Schlüssel soll allein vom Passwort abhängen, damit ein
 * Neustart des Servers niemanden abmeldet. Für ein einzelnes gemeinsames
 * Passwort ist das der richtige Tausch — gegen Wörterbuchangriffe schützt hier
 * die Länge des Passworts, nicht das Salz.
 */
const SALT = Buffer.from('lagebild.auth.v1');

let cachedKey: Buffer | null = null;
let cachedFor = '';

/** HMAC-Schlüssel aus dem Passwort (einmal gerechnet, scrypt ist absichtlich langsam). */
function key(): Buffer {
  if (cachedKey && cachedFor === config.password) return cachedKey;
  cachedFor = config.password;
  cachedKey = scryptSync(config.password, SALT, 32);
  return cachedKey;
}

/** Ist überhaupt ein Passwort gesetzt? */
export const authRequired = (): boolean => config.password.length > 0;

/** Vergleich in fester Zeit — die Antwortzeit soll nichts verraten. */
export function checkPassword(input: string): boolean {
  if (!authRequired()) return true;
  const a = Buffer.from(input ?? '', 'utf8');
  const b = Buffer.from(config.password, 'utf8');
  // timingSafeEqual verlangt gleiche Länge; über den Hash sind sie das immer.
  const ha = createHmac('sha256', SALT).update(a).digest();
  const hb = createHmac('sha256', SALT).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Merkmal `<gültig-bis>.<HMAC>`, beides in Base64url. */
export function sign(expiresAt = Date.now() + TOKEN_DAYS * 86_400_000): string {
  const payload = String(expiresAt);
  const mac = createHmac('sha256', key()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export interface TokenState {
  valid: boolean;
  /** Wann das Merkmal ausgestellt wurde bzw. abläuft (für die Erneuerung). */
  expiresAt: number;
}

export function verify(token: string | undefined): TokenState {
  if (!token) return { valid: false, expiresAt: 0 };
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { valid: false, expiresAt: 0 };
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return { valid: false, expiresAt: 0 };

  const want = createHmac('sha256', key()).update(payload).digest('base64url');
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, expiresAt: 0 };
  if (expiresAt < Date.now()) return { valid: false, expiresAt };
  return { valid: true, expiresAt };
}

/** Lohnt sich ein frisches Merkmal? So gleitet die Laufzeit mit der Nutzung. */
export const shouldRefresh = (expiresAt: number): boolean =>
  expiresAt - Date.now() < (TOKEN_DAYS * 86_400_000 - REFRESH_AFTER_MS);

/* ------------------------------------------------------------------ *
 * Bremse gegen Durchprobieren
 * ------------------------------------------------------------------ */

/** Fehlversuche je Absender, im Speicher. Muster wie der Backoff in aprs.ts. */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_FREE_TRIES = 5;
const MAX_WAIT_MS = 5 * 60 * 1000;

/** Wie lange muss dieser Absender noch warten? (0 = darf sofort) */
export function waitFor(who: string): number {
  const found = attempts.get(who);
  if (!found) return 0;
  return Math.max(0, found.until - Date.now());
}

export function noteFailure(who: string): void {
  const found = attempts.get(who) ?? { count: 0, until: 0 };
  found.count++;
  if (found.count > MAX_FREE_TRIES) {
    // 1 s, 2 s, 4 s … bis höchstens fünf Minuten.
    const wait = Math.min(MAX_WAIT_MS, 1000 * 2 ** (found.count - MAX_FREE_TRIES - 1));
    found.until = Date.now() + wait;
  }
  attempts.set(who, found);
}

export function noteSuccess(who: string): void {
  attempts.delete(who);
}

/** Nur für Prüfläufe. */
export function resetAttempts(): void {
  attempts.clear();
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

/** Cookie-Kopfzeile bauen. `secure` nur bei HTTPS — sonst nimmt es kein Browser an. */
export function cookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TOKEN_DAYS * 86_400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Ein Cookie aus der Kopfzeile fischen (Hono bringt dafür nichts Eigenes mit). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
