/*
 * Hintergrund-Warnungen.
 *
 * Dieses Stück läuft **im Service Worker**, nicht in der App: Es wird von
 * `workbox.importScripts` in den erzeugten Worker hineingezogen und meldet sich
 * auf `periodicsync`. Der Browser weckt den Worker dann von sich aus — auch
 * wenn die App geschlossen ist — und wir sehen nach, ob an den beobachteten
 * Orten eine neue Warnung liegt.
 *
 * **Warum nicht Web Push?** Echte Push-Benachrichtigungen brauchen einen
 * Server, der Abonnements speichert und VAPID-Schlüssel führt. Dieser Server
 * ist bewusst zustandslos (nur Proxy und kurzer Cache) — das wäre der erste
 * Zustand, den er dauerhaft halten müsste, samt Frage, wer welche Orte
 * beobachtet. `periodicsync` braucht davon nichts: Das Gerät fragt selbst,
 * und niemand außer ihm weiß, wonach.
 *
 * **Grenze, die ehrlich benannt gehört:** Die Schnittstelle gibt es heute nur
 * in Chromium-Browsern und nur für installierte Anwendungen; der Browser
 * entscheidet zudem selbst, wie oft er weckt (die Angabe unten ist ein Wunsch,
 * keine Zusage). Auf iOS gibt es sie gar nicht. Deshalb steht in den
 * Einstellungen, dass dies eine Zugabe ist und die Warnung im Zweifel dort
 * gesehen wird, wo sie herkommt: in der Warn-App des Bundes.
 */

/* global self, caches, indexedDB, fetch, clients */

const TAG = 'lagebild-warnungen';
/** Wo App und Worker sich verständigen (Dexie-Datenbank der App). */
const DB_NAME = 'lagebild';
const STORE = 'cache';
/** Schlüssel in dieser Tabelle. */
const TARGETS_KEY = 'bg:targets';
const SEEN_KEY = 'bg:seen';
/** Kantenlänge des abgefragten Rechtecks um einen Ort (Grad). */
const BOX = 0.05;
/** So viele Kennungen bereits gemeldeter Warnungen werden vorgehalten. */
const SEEN_MAX = 200;

/** Ein Wert aus der Dexie-Tabelle der App (dieselbe Form wie dort). */
function readRow(key) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => finish(null);
      req.onsuccess = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.close();
          finish(null);
          return;
        }
        const tx = database.transaction(STORE, 'readonly');
        const get = tx.objectStore(STORE).get(key);
        get.onsuccess = () => {
          finish(get.result ? get.result.value : null);
          database.close();
        };
        get.onerror = () => {
          finish(null);
          database.close();
        };
      };
    } catch {
      finish(null);
    }
  });
}

function writeRow(key, value) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.close();
          resolve();
          return;
        }
        const tx = database.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, value, savedAt: Date.now() });
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onerror = () => {
          database.close();
          resolve();
        };
      };
    } catch {
      resolve();
    }
  });
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * Warnungen an einem Ort. Beim Wetterdienst zählen nur `severe` und `extreme` —
 * eine Windwarnung der untersten Stufe ist keine Meldung wert, die jemanden
 * nachts weckt. Behördenwarnungen kommen dagegen in jeder Stufe durch: Die gibt
 * es nur, wenn wirklich etwas vorgefallen ist.
 */
async function warningsAt(place) {
  const bbox = [place.lon - BOX, place.lat - BOX, place.lon + BOX, place.lat + BOX].join(',');
  const out = [];
  try {
    const dwd = await getJson(`/api/warnings?bbox=${bbox}`);
    for (const w of dwd.data || []) {
      if (w.severity !== 'severe' && w.severity !== 'extreme') continue;
      out.push({ id: `dwd:${w.id}`, title: w.headline || w.event, place: place.name });
    }
  } catch {
    /* Kein Netz oder Server weg — beim nächsten Wecken erneut. */
  }
  try {
    const nina = await getJson(`/api/nina?bbox=${bbox}`);
    for (const w of nina.data || []) {
      out.push({ id: `nina:${w.id}`, title: w.headline || w.event, place: place.name });
    }
  } catch {
    /* dito */
  }
  return out;
}

async function checkWarnings() {
  const targets = await readRow(TARGETS_KEY);
  if (!Array.isArray(targets) || targets.length === 0) return;

  const seen = (await readRow(SEEN_KEY)) || [];
  const known = new Set(seen);
  const fresh = [];

  for (const place of targets.slice(0, 8)) {
    if (typeof place?.lat !== 'number' || typeof place?.lon !== 'number') continue;
    for (const w of await warningsAt(place)) {
      if (known.has(w.id)) continue;
      known.add(w.id);
      fresh.push(w);
    }
  }

  if (fresh.length > 0) {
    // Eine Meldung, auch bei mehreren Warnungen: Wer geweckt wird, soll einen
    // Satz lesen und dann selbst nachsehen.
    const first = fresh[0];
    const more = fresh.length - 1;
    await self.registration.showNotification(
      more > 0 ? `${fresh.length} neue Warnungen` : 'Neue Warnung',
      {
        body: `${first.title}${first.place ? ` — ${first.place}` : ''}${more > 0 ? ` (und ${more} weitere)` : ''}`,
        tag: 'lagebild-warnung',
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: '/' },
      },
    );
  }

  // Die jüngsten Kennungen behalten — sonst wächst die Liste unbegrenzt, und
  // eine abgelaufene Warnung mit derselben Kennung kommt ohnehin nicht wieder.
  await writeRow(SEEN_KEY, [...known].slice(-SEEN_MAX));
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === TAG) event.waitUntil(checkWarnings());
});

// Beim Antippen die App öffnen statt eines neuen Fensters, wenn sie schon läuft.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    }),
  );
});
