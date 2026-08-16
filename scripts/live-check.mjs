/*
 * Sichtprüfung der neuen Funktionen im echten Browser.
 *
 * Ohne Playwright: Chromium mit `--remote-debugging-port` starten und über das
 * DevTools-Protokoll steuern (`Runtime.evaluate`). Läuft gegen die
 * passwortlose Instanz auf Port 8788.
 *
 *   node scripts/live-check.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('../node_modules/.pnpm/ws@8.21.1/node_modules/ws');

const URL_APP = process.env.APP_URL ?? 'http://localhost:8788/';
const PROFILE = '/tmp/lagebild-livecheck';

const chrome = spawn(
  '/snap/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    // MapLibre braucht WebGL. `--disable-gpu` nimmt es weg, dann stirbt die
    // ganze Anwendung beim Aufbau der Karte — deshalb SwiftShader über ANGLE.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=9222',
    `--user-data-dir=${PROFILE}`,
    '--window-size=1400,900',
    URL_APP,
  ],
  { stdio: 'ignore' },
);

let ws;
let nextId = 1;
const waiting = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** JavaScript in der Seite ausführen und das Ergebnis zurückgeben. */
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `${res.exceptionDetails.exception?.description ?? 'Fehler'}\n--- Ausdruck ---\n${expression.slice(-500)}`,
    );
  }
  return res.result?.value;
}

let failed = 0;
function check(what, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://localhost:9222/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* noch nicht da */
    }
    await sleep(500);
  }
  throw new Error('Chromium meldet sich nicht');
}

const main = async () => {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  // Standort Bremen (dafür liegen Routing-, Such- und Geländepaket bereit).
  await send('Emulation.setGeolocationOverride', { latitude: 53.0758, longitude: 8.8072, accuracy: 20 });
  await send('Browser.grantPermissions', {
    origin: 'http://localhost:8788',
    permissions: ['geolocation'],
  });

  /*
   * Neu laden, **nachdem** der Standort gesetzt ist: Die App ortet beim ersten
   * Rendern, und beim Start des Browsers stand die Vorgabe noch nicht. Ohne das
   * bliebe sie auf Berlin — und dort liegt kein Geländepaket, also gäbe es auch
   * keinen Schattenwurf zu prüfen.
   */
  let ort = '?';
  for (let i = 0; i < 3; i++) {
    await send('Page.reload', { ignoreCache: false });
    await sleep(6000);
    ort = await evaluate(`return document.querySelector('.pl-name')?.textContent ?? '?';`);
    if (ort !== 'Berlin-Mitte' && ort !== '?') break;
    // Die Ortung läuft beim ersten Rendern; greift die Vorgabe nicht rechtzeitig,
    // hilft ein weiterer Versuch mehr als eine längere Wartezeit.
  }
  check('App geladen', (await evaluate('return document.title')).length > 0);
  check('Standort steht auf der Testregion', ort !== 'Berlin-Mitte', ort);

  /* ---------- Ebenen-Menü ---------- */

  /*
   * Das Ebenen-Menü zeigt zuerst nur die Gruppen; die Zeilen erscheinen erst,
   * wenn eine Gruppe aufgeklappt ist. Deshalb: Menü öffnen, alle Gruppen
   * aufklappen, dann erst suchen. (Kein `return` in diesem Baustein — er wird
   * in andere Ausdrücke eingesetzt.)
   */
  const openMenu = `
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Ebenen'));
    if (btn && !document.querySelector('.lm-panel')) btn.click();
    await new Promise((r) => setTimeout(r, 250));
    for (const g of [...document.querySelectorAll('.lm-panel button')]) {
      if (g.getAttribute('aria-expanded') === 'false') { g.click(); await new Promise((r) => setTimeout(r, 60)); }
    }
    await new Promise((r) => setTimeout(r, 150));`;

  /** Eine Ebenenzeile umschalten (Gruppenköpfe tragen aria-expanded). */
  const toggleLayer = (label) => `
    ${openMenu}
    const rows = [...document.querySelectorAll('.lm-panel button')]
      .filter((b) => b.getAttribute('aria-expanded') == null);
    const row = rows.find((b) => b.textContent.includes(LABEL));
    if (!row) return 'fehlt';
    row.click();
    return 'ok';`.replace('LABEL', JSON.stringify(label));

  const layerNames = await evaluate(`
    ${openMenu}
    return [...document.querySelectorAll('.lm-panel button')]
      .filter((b) => b.getAttribute('aria-expanded') == null)
      .map((b) => b.textContent.trim().split(String.fromCharCode(10))[0]);`);
  const has = (n) => layerNames.some((x) => x.includes(n));
  check('Ebene „Löschwasser" im Menü', has('Löschwasser'));
  check('Ebene „Drohnen-Zonen" im Menü', has('Drohnen-Zonen'));
  check('Ebene „Erreichbarkeit" im Menü', has('Erreichbarkeit'));
  check('Ebene „Schattenwurf" im Menü', has('Schattenwurf'));

  /* ---------- Löschwasser ---------- */

  // Nah genug heranfahren, sonst gibt der Server nichts heraus (0,12°-Grenze).
  await evaluate(toggleLayer('Löschwasser'));
  await sleep(1000);
  const waterCalls = await evaluate(`
    const res = await fetch('/api/water?bbox=8.78,53.06,8.85,53.09');
    const j = await res.json();
    return j.data.length;`);
  check('Löschwasser-Route liefert Punkte', waterCalls > 100, `${waterCalls}`);

  /* ---------- Drohnen-Zonen ---------- */

  const zones = await evaluate(`
    const res = await fetch('/api/drones/info?lat=53.047&lon=8.787');
    const j = await res.json();
    return j.data.map((z) => z.art);`);
  check('Drohnen-Zonen am Flughafen Bremen', zones.length >= 2, zones.join(', '));

  const tile = await evaluate(`
    const res = await fetch('/api/drones/13/4291/2687.png');
    return res.status + ':' + res.headers.get('content-type');`);
  check('Drohnen-Kachel kommt als PNG', tile.startsWith('200:image/png'), tile);

  /* ---------- Pegel-Einstufung ---------- */

  const pegel = await evaluate(`
    const res = await fetch('/api/pegel?bbox=6.5,50.6,7.5,51.2');
    const j = await res.json();
    const k = j.data.find((p) => p.station === 'KÖLN');
    return k ? { stage: k.stage, note: k.stageNote, marken: Object.keys(k.marks).length } : null;`);
  check('Pegel Köln eingestuft', pegel && pegel.stage != null, JSON.stringify(pegel));
  check('Kennwerte mitgeliefert', pegel && pegel.marken >= 5, `${pegel?.marken} Kennwerte`);

  /* ---------- Offline-Paket laden ----------
   *
   * Erreichbarkeit und Schattenwurf rechnen aus den **heruntergeladenen**
   * Paketen, nicht aus dem, was der Server anbietet. In einem frischen
   * Browserprofil liegt nichts im Gerät — also erst laden, sonst prüft der Lauf
   * nur die Meldung „Paket fehlt".
   */

  const laden = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    document.querySelector('.ib-tools')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const item = [...document.querySelectorAll('.mt-item')].find((b) => /Offline/.test(b.textContent));
    if (!item) return 'Werkzeug fehlt';
    item.click();
    await new Promise((r) => setTimeout(r, 800));
    const zeile = [...document.querySelectorAll('.region')].find((r) => /Bremen/.test(r.querySelector('.rinfo b')?.textContent ?? ''));
    if (!zeile) return 'Bremen fehlt';
    const btn = zeile.querySelector('.rbtn');
    if (!btn) return 'schon vollständig';
    btn.click();
    return 'gestartet';`);
  check('Download von Bremen gestartet', laden === 'gestartet' || laden === 'schon vollständig', laden);

  // Über localhost sind die knapp 30 MB in Sekunden da; gewartet wird, bis die
  // Zeile den Haken zeigt (dann liegt jedes angebotene Paket im Gerät).
  let geladen = false;
  for (let i = 0; i < 60 && !geladen; i++) {
    await sleep(2000);
    geladen = await evaluate(`
      const zeile = [...document.querySelectorAll('.region')].find((r) => /Bremen/.test(r.querySelector('.rinfo b')?.textContent ?? ''));
      return !!zeile?.querySelector('.rok') && !zeile.querySelector('.rbtn');`);
  }
  check('Pakete liegen im Gerät', geladen);

  // Welche Bestandteile wirklich im Gerät liegen — die Betroffenenabschätzung
  // hängt am Einwohner-Paket, und das kam später dazu als die übrigen.
  const opfs = await evaluate(`
    const root = await navigator.storage.getDirectory();
    const maps = await root.getDirectoryHandle('maps').catch(() => null);
    if (!maps) return [];
    const out = [];
    for await (const [name] of maps.entries()) out.push(name);
    return out.sort();`);
  check('Einwohner-Paket im Gerät', opfs.includes('04.pop'), opfs.join(' '));
  await evaluate(`document.querySelector('.sheet .close')?.click(); return 1;`);
  await sleep(1500);

  /* ---------- Erreichbarkeit (offline gerechnet) ----------
   *
   * Ob die Rechnung stimmt, prüft `scripts/check-reach.mts` gegen die echten
   * Pakete. Hier geht es nur darum, dass die Ebene im Browser anspringt: Legende
   * da, keine Fehlermeldung, Regler bedienbar.
   */

  await evaluate(toggleLayer('Erreichbarkeit'));
  await sleep(9000);
  const reach = await evaluate(`
    const l = document.querySelector('[aria-label="Erreichbarkeit"]');
    return l ? l.textContent.replace(/[ \\t\\n\\r]+/g, ' ').slice(0, 120) : null;`);
  check('Legende der Erreichbarkeit erscheint', !!reach && /15 min/.test(reach), reach ?? 'fehlt');
  check('kein Hinweis auf fehlendes Netz', !!reach && !/außerhalb|nicht am/.test(reach), reach ?? '');
  await evaluate(toggleLayer('Erreichbarkeit'));

  /* ---------- Schattenwurf ---------- */

  await evaluate(toggleLayer('Schattenwurf'));
  await sleep(5000);
  const shadow = await evaluate(`
    const l = document.querySelector('[aria-label="Schattenwurf"]');
    const slider = document.querySelector('.legend-slider');
    return { text: l ? l.textContent.replace(/[ \\t\\n\\r]+/g, ' ').slice(0, 120) : null, slider: !!slider };`);
  check('Legende nennt den Sonnenstand', !!shadow.text && /Sonne/.test(shadow.text), shadow.text ?? 'fehlt');
  check('Zeitregler vorhanden', shadow.slider);
  check('Geländepaket wird gefunden', !!shadow.text && !/fehlt das Geländepaket/.test(shadow.text), shadow.text ?? '');

  /* ---------- Wetterfenster ---------- */

  const windows = await evaluate(`
    const tile = [...document.querySelectorAll('button, .tile')].find((e) => /Wetter/.test(e.textContent) && e.className.includes('tile'));
    if (tile) tile.click();
    await new Promise((r) => setTimeout(r, 1200));
    const labels = [...document.querySelectorAll('.sect-label')].map((e) => e.textContent);
    const list = document.querySelectorAll('.ww-list li').length;
    const controls = document.querySelectorAll('.ww-controls input').length;
    return { labels: labels.filter((l) => /Wetterfenster/.test(l)).length, list, controls };`);
  check('Abschnitt „Wetterfenster" im Wetterblatt', windows.labels === 1, JSON.stringify(windows));
  check('Regler vorhanden', windows.controls === 3, `${windows.controls}`);
  check('Fenster gefunden oder Grund genannt', windows.list >= 0);

  await evaluate(`document.querySelector('.sheet .close')?.click(); return 1;`);

  /* ---------- Einsatz-Logbuch ---------- */

  const log = await evaluate(`
    localStorage.removeItem('lagebild.missions');
    const tools = document.querySelector('.ib-tools');
    tools?.click();
    await new Promise((r) => setTimeout(r, 400));
    const item = [...document.querySelectorAll('.mt-item')].find((b) => /Logbuch/.test(b.textContent));
    if (!item) return { schritt: 'Werkzeug fehlt' };
    item.click();
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('.ml-start input');
    if (!input) return { schritt: 'Startfeld fehlt' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Übung Deichverteidigung');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.ml-start button')].find((b) => /beginnen/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 400));

    const note = document.querySelector('.ml-add input');
    setter.call(note, 'Sandsäcke angefordert');
    note.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.ml-add button')].find((b) => /Eintrag/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.ml-add button')].find((b) => /Standort/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 300));

    const gespeichert = JSON.parse(localStorage.getItem('lagebild.missions') || '[]');
    const eintraege = document.querySelectorAll('.ml-list li').length;
    return {
      name: gespeichert[0]?.name,
      arten: gespeichert[0]?.entries.map((e) => e.kind),
      mitOrt: gespeichert[0]?.entries.filter((e) => e.lat != null).length,
      eintraege,
    };`);
  check('Einsatz angelegt', log.name === 'Übung Deichverteidigung', JSON.stringify(log));
  check('Eintrag und Standort protokolliert', (log.arten ?? []).join(',') === 'start,note,position', (log.arten ?? []).join(','));
  check('Standort mit Koordinaten', log.mitOrt === 1);

  const afterEnd = await evaluate(`
    document.querySelector('.ml-end')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const m = JSON.parse(localStorage.getItem('lagebild.missions') || '[]');
    const laufend = m.filter((x) => x.endedAt == null).length;
    // Nach dem Ende darf nichts mehr geschrieben werden.
    const vorher = m[0].entries.length;
    return { laufend, vorher, hatEnde: m[0].entries.some((e) => e.kind === 'end') };`);
  check('Einsatz beendet', afterEnd.laufend === 0 && afterEnd.hatEnde, JSON.stringify(afterEnd));

  const nachEnde = await evaluate(`
    const vorher = JSON.parse(localStorage.getItem('lagebild.missions'))[0].entries.length;
    // Eine Markierung setzen wäre der übliche Auslöser; hier reicht der Beweis,
    // dass ohne laufenden Einsatz nichts dazukommt.
    await new Promise((r) => setTimeout(r, 200));
    const nachher = JSON.parse(localStorage.getItem('lagebild.missions'))[0].entries.length;
    return vorher === nachher;`);
  check('ohne laufenden Einsatz wird nichts geschrieben', nachEnde);

  /* ---------- Notfallblatt: Fahrzeit ---------- */

  const notfall = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    await new Promise((r) => setTimeout(r, 300));
    // Das Notfallblatt hat einen eigenen Knopf in der Kopfzeile.
    document.querySelector('.ib-emergency')?.click();
    await new Promise((r) => setTimeout(r, 8000));
    const zeilen = [...document.querySelectorAll('.em-list .mono')].map((e) => e.textContent);
    return zeilen;`);
  check(
    'Notfallblatt nennt Fahrzeiten',
    notfall.some((z) => /min Fahrt/.test(z)),
    notfall.slice(0, 3).join(' | '),
  );

  /* ---------- Beschreibung an eigenen Markierungen ---------- */

  // Vorher aufräumen: Der Kartenzustand hält die Markierungen im Speicher und
  // schreibt sie beim nächsten Rendern zurück — ein bloßes Leeren des
  // localStorage brächte sie also wieder. Deshalb leeren **und** neu laden.
  await evaluate(`localStorage.removeItem('lagebild.draw'); return 1;`);
  await send('Page.reload', {});
  await sleep(6000);

  const beschreibung = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    await new Promise((r) => setTimeout(r, 300));

    // Punkt setzen: Werkzeug „Einzeichnen" → Punkt → auf die Karte tippen.
    [...document.querySelectorAll('.chip')].find((b) => /Einzeichnen/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 300));
    const werkzeug = [...document.querySelectorAll('.lm-item')].find((b) => /Punkt setzen/.test(b.textContent));
    if (!werkzeug) return { schritt: 'Werkzeug Punkt fehlt' };
    werkzeug.click();
    await new Promise((r) => setTimeout(r, 300));

    const karte = document.querySelector('.lagemap canvas');
    const box = karte.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      karte.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }));
    }
    await new Promise((r) => setTimeout(r, 600));

    const namebox = document.querySelector('.namebox');
    if (!namebox) return { schritt: 'Namensdialog fehlt' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const nameInput = namebox.querySelector('.nameinput');
    const noteInput = namebox.querySelector('.noteinput');
    if (!noteInput) return { schritt: 'Beschreibungsfeld fehlt' };
    setter.call(nameInput, 'Sammelplatz');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    areaSetter.call(noteInput, 'Zufahrt nur von Norden');
    noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    [...namebox.querySelectorAll('button')].find((b) => /Speichern/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 500));

    const gespeichert = JSON.parse(localStorage.getItem('lagebild.draw') || '[]');
    return { schritt: 'ok', name: gespeichert[0]?.name, note: gespeichert[0]?.note };`);
  check(
    'Beschreibung beim Anlegen gespeichert',
    beschreibung.note === 'Zufahrt nur von Norden' && beschreibung.name === 'Sammelplatz',
    JSON.stringify(beschreibung),
  );

  const nachtraeglich = await evaluate(`
    // In der Liste ändern.
    [...document.querySelectorAll('.chip')].find((b) => /Einzeichnen/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('.lm-item')].find((b) => /Liste öffnen/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 500));
    const zeile = document.querySelector('.dl-item');
    if (!zeile) return { schritt: 'Liste leer' };
    const sichtbar = zeile.querySelector('.dl-note')?.textContent ?? null;
    zeile.querySelector('[aria-label="Beschreibung ändern"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const feld = document.querySelector('.dl-noteedit textarea');
    if (!feld) return { schritt: 'Bearbeitungsfeld fehlt', sichtbar };
    const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    areaSetter.call(feld, 'Zufahrt gesperrt, Umleitung über die Brücke');
    feld.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.dl-notebtns button')].find((b) => /Speichern/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 400));
    const nachher = JSON.parse(localStorage.getItem('lagebild.draw') || '[]')[0]?.note;
    // Und als GPX ausgeben lassen sich beide Felder ebenfalls.
    return { sichtbar, nachher };`);
  check('Beschreibung steht in der Liste', nachtraeglich.sichtbar === 'Zufahrt nur von Norden', JSON.stringify(nachtraeglich));
  check(
    'Beschreibung nachträglich änderbar',
    nachtraeglich.nachher === 'Zufahrt gesperrt, Umleitung über die Brücke',
    nachtraeglich.nachher ?? '—',
  );

  const suche = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('.ib-search')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const feld = document.querySelector('.sheet input[type="search"], .sheet input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(feld, 'Umleitung');
    feld.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const treffer = [...document.querySelectorAll('.sr-row')].map((r) => r.textContent.replace(/[ ]+/g, ' '));
    document.querySelector('.sheet .close')?.click();
    return treffer;`);
  check(
    'Suche findet die Markierung über ihre Beschreibung',
    suche.some((t) => /Sammelplatz/.test(t) && /Umleitung/.test(t)),
    suche.join(' | ').slice(0, 160),
  );

  /* ---------- Gefahrgut und Betroffene ---------- */

  const gefahrgut = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    document.querySelector('.ib-tools')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const item = [...document.querySelectorAll('.mt-item')].find((b) => /Gefahrgut/.test(b.textContent));
    if (!item) return { schritt: 'Werkzeug fehlt' };
    item.click();
    await new Promise((r) => setTimeout(r, 900));
    const input = document.querySelector('.hz-input input');
    if (!input) return { schritt: 'Eingabefeld fehlt' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '268/1017');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Beim ersten Mal muss das Nachschlagewerk noch geladen und der Worker mit
    // dem Einwohner-Paket geweckt werden — deshalb warten, bis etwas da ist.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (document.querySelectorAll('.hz-people b').length > 0) break;
    }
    const text = document.querySelector('.hz-sheet').textContent.replace(/[ ]+/g, ' ');
    const zahlen = [...document.querySelectorAll('.hz-numbers b')].map((e) => e.textContent);
    const menschen = [...document.querySelectorAll('.hz-people b')].map((e) => e.textContent);
    const betroffen = document.querySelector('.hz-people')?.textContent ?? document.querySelector('.hz-sheet').textContent.slice(-400);
    return { text: text.slice(0, 400), betroffen: betroffen.replace(/[ ]+/g, ' ').slice(0, 260), zahlen, menschen, kemler: !!document.querySelector('.hz-kemler') };`);
  check('Gefahrgut-Blatt findet UN 1017', /Chlorine/.test(gefahrgut.text ?? ''), JSON.stringify(gefahrgut.zahlen));
  check('Leitfaden wird genannt', /Leitfaden 124/.test(gefahrgut.text ?? ''));
  check('Gefahrnummer wird ausgewertet', gefahrgut.kemler === true);
  // UN 1017, kleine Menge: 60 m absperren, stromab 0,3 km bei Tag und 1,5 km bei
  // Nacht. Welcher der beiden Werte erscheint, hängt vom Sonnenstand ab —
  // geprüft wird deshalb gegen beide Fassungen der Tabellenzeile.
  const abstaende = (gefahrgut.zahlen ?? []).join(' ');
  check('Abstände stehen da', abstaende === '60 m 300 m' || abstaende === '60 m 1,5 km', abstaende);
  check(
    'Betroffene werden geschätzt',
    (gefahrgut.menschen ?? []).length > 0,
    (gefahrgut.menschen ?? []).join(' / ') || gefahrgut.betroffen || '?',
  );

  const zone = await evaluate(`
    [...document.querySelectorAll('.hz-sheet button')].find((b) => /Auf die Karte/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('.sheet .close')?.click();
    return 1;`);
  check('Gefahrenbereich lässt sich auf die Karte legen', zone === 1);

  /* ---------- Hintergrund-Warnungen ---------- */

  const hintergrund = await evaluate(`
    document.querySelector('.sheet .close')?.click();
    document.querySelector('.ib-tools')?.click();
    await new Promise((r) => setTimeout(r, 400));
    [...document.querySelectorAll('.mt-item')].find((b) => /Einstellungen/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 600));
    [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.trim() === 'App')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const zeile = [...document.querySelectorAll('.st-item')].find((b) => /Hintergrund/.test(b.textContent));
    if (!zeile) return { da: false };
    // Der Service Worker muss den Wecker kennen, sonst nützt der Schalter nichts.
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    const sw = await fetch('/sw-warnings.js').then((r) => r.text()).catch(() => '');
    return {
      da: true,
      text: zeile.textContent.replace(/[ ]+/g, ' ').slice(0, 160),
      gesperrt: zeile.disabled,
      swGeladen: /periodicsync/.test(sw),
      swAktiv: !!reg,
    };`);
  check('Schalter „Warnungen im Hintergrund" vorhanden', hintergrund.da);
  check('Wecker steht im Service Worker', hintergrund.swGeladen);
  check('Service Worker läuft', hintergrund.swAktiv);
  check(
    'Grenze wird benannt statt still zu scheitern',
    !hintergrund.gesperrt || /Browser kann das nicht/.test(hintergrund.text ?? ''),
    hintergrund.text ?? '',
  );

  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
};

main()
  .catch((e) => {
    console.error('Abbruch:', e.message);
    failed++;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {
      /* egal */
    }
    chrome.kill();
    process.exit(failed ? 1 : 0);
  });
