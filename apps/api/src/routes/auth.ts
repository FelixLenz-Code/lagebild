import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  COOKIE_NAME,
  authRequired,
  checkPassword,
  clearCookieHeader,
  cookieHeader,
  noteFailure,
  noteSuccess,
  readCookie,
  shouldRefresh,
  sign,
  verify,
  waitFor,
} from '../lib/auth.js';

/**
 * Anmeldung mit einem gemeinsamen Passwort.
 *
 * Drei Wege: hinein, hinaus und die Frage, ob überhaupt ein Passwort verlangt
 * wird. Mehr braucht es nicht — es gibt keine Konten.
 */
export const authRoute = new Hono();

/** Läuft die Verbindung über HTTPS? Nur dann darf das Cookie `Secure` tragen. */
function isSecure(c: { req: { url: string; header: (n: string) => string | undefined } }): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) return proto.split(',')[0]!.trim() === 'https';
  return new URL(c.req.url).protocol === 'https:';
}

/** Absenderkennung für die Bremse — hinter Caddy steht die echte IP im Kopf. */
const who = (c: { req: { header: (n: string) => string | undefined } }): string =>
  (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'lokal';

authRoute.get('/status', (c) => {
  const state = verify(readCookie(c.req.header('cookie'), COOKIE_NAME));
  return c.json({ required: authRequired(), ok: !authRequired() || state.valid });
});

authRoute.post('/login', async (c) => {
  if (!authRequired()) return c.json({ ok: true, required: false });

  const wait = waitFor(who(c));
  if (wait > 0) {
    return c.json(
      { ok: false, error: `Zu viele Versuche. Bitte ${Math.ceil(wait / 1000)} s warten.` },
      429,
    );
  }

  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: '' }));
  if (!checkPassword(body.password ?? '')) {
    noteFailure(who(c));
    return c.json({ ok: false, error: 'Passwort stimmt nicht.' }, 401);
  }

  noteSuccess(who(c));
  c.header('set-cookie', cookieHeader(sign(), isSecure(c)));
  return c.json({ ok: true, required: true });
});

authRoute.post('/logout', (c) => {
  c.header('set-cookie', clearCookieHeader(isSecure(c)));
  return c.json({ ok: true });
});

/**
 * Wächter für alle Fachrouten.
 *
 * Erneuert das Merkmal nebenbei, sobald es älter als ein Tag ist — dadurch
 * gleitet die Laufzeit mit der Nutzung, und ein Gerät, das regelmäßig benutzt
 * wird, fliegt nie heraus.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!authRequired()) return next();

  const state = verify(readCookie(c.req.header('cookie'), COOKIE_NAME));
  if (!state.valid) {
    return c.json({ error: 'Passwort erforderlich', code: 'auth' }, 401);
  }
  if (shouldRefresh(state.expiresAt)) {
    c.header('set-cookie', cookieHeader(sign(), isSecure(c)));
  }
  return next();
};
