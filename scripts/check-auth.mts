/**
 * Prüflauf für den Passwortschutz:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-auth.mts
 *
 * Braucht weder Netz noch Daten und läuft deshalb in der CI bei jedem Anstoß
 * mit. Geprüft wird das, woran ein selbstgebauter Schutz scheitert: verfälschte
 * und abgelaufene Merkmale, ein geändertes Passwort, und dass ohne gesetztes
 * Passwort wirklich alles offen bleibt.
 */

process.env.APP_PASSWORD = 'prüf-passwort-123';

const auth = await import('../apps/api/src/lib/auth.js');

let failed = 0;
const check = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nMerkmal');
{
  const token = auth.sign();
  const state = auth.verify(token);
  check('frisches Merkmal gilt', state.valid);
  check(
    'Laufzeit rund 400 Tage',
    Math.abs(state.expiresAt - Date.now() - 400 * 86_400_000) < 5000,
    `${Math.round((state.expiresAt - Date.now()) / 86_400_000)} Tage`,
  );

  check('verfälschte Unterschrift fällt durch', !auth.verify(token.slice(0, -1) + 'x').valid);
  check('verfälschte Laufzeit fällt durch', !auth.verify(`${Date.now() + 1e12}.${token.split('.')[1]}`).valid);
  check('leeres Merkmal fällt durch', !auth.verify(undefined).valid && !auth.verify('').valid);
  check('Merkmal ohne Punkt fällt durch', !auth.verify('abcdef').valid);
  check('abgelaufenes Merkmal fällt durch', !auth.verify(auth.sign(Date.now() - 1000)).valid);

  // Frisch ausgestellt braucht es keine Erneuerung, ein Tag später schon.
  check('frisches Merkmal wird nicht erneuert', !auth.shouldRefresh(state.expiresAt));
  check(
    'einen Tag altes Merkmal wird erneuert',
    auth.shouldRefresh(state.expiresAt - 25 * 3_600_000),
  );
}

console.log('\nPasswort');
{
  check('richtiges Passwort', auth.checkPassword('prüf-passwort-123'));
  check('falsches Passwort', !auth.checkPassword('prüf-passwort-124'));
  check('leeres Passwort', !auth.checkPassword(''));
  check('Passwort mit Anhang', !auth.checkPassword('prüf-passwort-123 '));
}

console.log('\nPasswortwechsel meldet alle Geräte ab');
{
  const before = auth.sign();
  process.env.APP_PASSWORD = 'ein-anderes-passwort';
  // config liest die Umgebung nur beim Laden — der Schlüssel hängt aber an
  // config.password, also wird hier direkt daran gedreht.
  const { config } = await import('../apps/api/src/config.js');
  config.password = 'ein-anderes-passwort';
  check('altes Merkmal gilt nicht mehr', !auth.verify(before).valid);
  check('neues Merkmal gilt', auth.verify(auth.sign()).valid);
  check('altes Passwort wird abgelehnt', !auth.checkPassword('prüf-passwort-123'));
  config.password = 'prüf-passwort-123';
  check('zurückgedreht gilt das alte wieder', auth.verify(before).valid);
}

console.log('\nOhne gesetztes Passwort');
{
  const { config } = await import('../apps/api/src/config.js');
  config.password = '';
  check('Schutz ist aus', !auth.authRequired());
  check('jedes Passwort geht durch', auth.checkPassword('irgendwas'));
  config.password = 'prüf-passwort-123';
  check('mit Passwort ist der Schutz an', auth.authRequired());
}

console.log('\nBremse gegen Durchprobieren');
{
  auth.resetAttempts();
  const who = 'prüfer';
  check('zu Beginn keine Wartezeit', auth.waitFor(who) === 0);
  for (let i = 0; i < 5; i++) auth.noteFailure(who);
  check('fünf Fehlversuche bleiben frei', auth.waitFor(who) === 0);
  auth.noteFailure(who);
  const first = auth.waitFor(who);
  check('der sechste kostet Wartezeit', first > 0, `${first} ms`);
  for (let i = 0; i < 4; i++) auth.noteFailure(who);
  check('die Wartezeit wächst', auth.waitFor(who) > first, `${auth.waitFor(who)} ms`);
  auth.noteSuccess(who);
  check('Erfolg setzt zurück', auth.waitFor(who) === 0);
  auth.resetAttempts();
}

console.log('\nCookie');
{
  const header = auth.cookieHeader('abc', true);
  check('HttpOnly gesetzt', header.includes('HttpOnly'));
  check('SameSite gesetzt', header.includes('SameSite=Lax'));
  check('Secure nur bei HTTPS', header.includes('Secure') && !auth.cookieHeader('abc', false).includes('Secure'));
  check('lange Laufzeit', header.includes(`Max-Age=${400 * 86_400}`));
  check('Löschen setzt Max-Age=0', auth.clearCookieHeader(false).includes('Max-Age=0'));

  check('Cookie wird gefunden', auth.readCookie('a=1; lagebild_auth=xyz; b=2', 'lagebild_auth') === 'xyz');
  check('fehlendes Cookie ist undefined', auth.readCookie('a=1', 'lagebild_auth') === undefined);
  check('ohne Kopfzeile undefined', auth.readCookie(undefined, 'lagebild_auth') === undefined);
  // Ein Name, der als Teil eines anderen vorkommt, darf nicht anschlagen.
  check('Teiltreffer zählt nicht', auth.readCookie('xlagebild_auth=nein', 'lagebild_auth') === undefined);
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen\n` : '\nAlle Prüfungen bestanden\n');
process.exit(failed ? 1 : 0);
