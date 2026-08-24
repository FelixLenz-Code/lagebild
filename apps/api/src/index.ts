import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requestIsSecure } from './lib/proxy.js';
import { config } from './config.js';
import { weatherRoute } from './routes/weather.js';
import { alertsRoute } from './routes/alerts.js';
import { warningsRoute } from './routes/warnings.js';
import { trafficRoute } from './routes/traffic.js';
import { newsRoute } from './routes/news.js';
import { blaulichtRoute } from './routes/blaulicht.js';
import { pegelRoute } from './routes/pegel.js';
import { airRoute } from './routes/air.js';
import { radarRoute } from './routes/radar.js';
import { geocodeRoute } from './routes/geocode.js';
import { transitRoute } from './routes/transit.js';
import { stopsRoute } from './routes/stops.js';
import { flowRoute, flowUsable } from './routes/flow.js';
import { mapsRoute } from './routes/maps.js';
import { aircraftRoute } from './routes/aircraft.js';
import { vesselsRoute, startAisCollector, aisUsable } from './routes/vessels.js';
import { aprsRoute, aprsUsable } from './routes/aprs.js';
import { windRoute } from './routes/wind.js';
import { hfRoute } from './routes/hf.js';
import { vehiclesRoute } from './routes/vehicles.js';
import { hazardsRoute } from './routes/hazards.js';
import { lightningRoute, startLightningCollector, lightningUsable } from './routes/lightning.js';
import { ninaRoute } from './routes/nina.js';
import { radiationRoute } from './routes/radiation.js';
import { pollenRoute } from './routes/pollen.js';
import { restRoute } from './routes/rest.js';
import { webcamsRoute } from './routes/webcams.js';
import { rescueRoute } from './routes/rescue.js';
import { avalancheRoute } from './routes/avalanche.js';
import { satRoute } from './routes/sat.js';
import { dronesRoute } from './routes/drones.js';
import { waterRoute } from './routes/water.js';
import { authRoute, isAuthed, requireAuth } from './routes/auth.js';
import { authRequired } from './lib/auth.js';

const app = new Hono();

/**
 * Protokoll **ohne Query**.
 *
 * Honos Logger schreibt den Pfad samt Query. Genau darin stehen hier die
 * Koordinaten des Nutzers (`?lat=52.51631&lon=13.37770`) und jeder getippte
 * Suchbegriff — beides landete damit dauerhaft im Journal. Für „läuft der
 * Server, wie schnell antwortet er" genügt der Pfad, und die App verspricht
 * ausdrücklich, niemandem nachzulaufen.
 */
app.use('*', logger((nachricht, ...rest) => {
  console.log(nachricht.replace(/(\s\/\S*?)\?\S*/, '$1'), ...rest);
}));

/**
 * Kopfzeilen zur Absicherung.
 *
 * Die Fachdaten kommen aus rund zwanzig fremden Quellen und werden in den
 * Kartenblasen zu HTML zusammengesetzt. Dort wird jeder fremde Text kodiert —
 * die Richtlinie ist die zweite Reihe dahinter: Sie verbietet eingebettete
 * Skripte und `javascript:`-Adressen, sodass ein vergessenes `esc()` nicht
 * gleich fremden Code im Ursprung dieser App ausführt.
 *
 * `img-src`/`connect-src` bleiben bei `https:` statt einer Aufzählung: Die
 * Kachelserver stehen nicht fest — RainViewer nennt seinen Host erst in der
 * Antwort, und die Kartenschriften kommen je nach Bauzustand vom eigenen Server
 * oder von Protomaps. Eine zu enge Regel bräche die Karte, und eine schwarze
 * Karte hilft niemandem. `http:` bleibt trotzdem draußen.
 */
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    // MapLibre baut seine Arbeiter über blob:-Adressen.
    scriptSrc: ["'self'", 'blob:'],
    workerSrc: ["'self'", 'blob:'],
    // React und MapLibre setzen Stile am Element (`style="…"`).
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'", 'data:', 'blob:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    manifestSrc: ["'self'"],
  },
  // Setzt Hono sonst selbst; beides brauchen wir hier nicht.
  crossOriginEmbedderPolicy: false,
  xFrameOptions: 'DENY',
  // Nur über HTTPS ansagen. Über HTTP überginge der Browser die Zeile ohnehin,
  // aber so steht auch nichts Irreführendes in der Antwort.
  strictTransportSecurity: false,
}));

app.use('*', async (c, next) => {
  await next();
  if (requestIsSecure(c)) {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
});

/**
 * CORS ist **standardmäßig aus**.
 *
 * Oberfläche und Schnittstelle kommen vom selben Server, im Entwicklungsbetrieb
 * reicht der Proxy des Vite-Servers — beides braucht kein CORS. Vorher wurde
 * jede fremde Herkunft zurückgespiegelt, und das zusammen mit
 * `credentials: true`: Damit hätte jede beliebige Seite im Browser eines
 * angemeldeten Nutzers auf diesen Server zugreifen und die Antworten lesen
 * können. Dass das SameSite-Cookie es praktisch verhindert hat, war Glück und
 * keine Absicht.
 *
 * Wer die Schnittstelle wirklich von einer anderen Herkunft aus braucht, trägt
 * sie in `CORS_ORIGINS` ein — als Liste, nie als `*`.
 */
if (config.corsOrigins.length > 0) {
  app.use(
    '/api/*',
    cors({
      origin: (o) => (config.corsOrigins.includes(o) ? o : null),
      credentials: true,
    }),
  );
}

// Anmeldung selbst und die Erreichbarkeitsprüfung bleiben offen — sonst käme
// niemand mehr an das Passwortfeld heran.
/*
 * Rumpfgrenze für den einzigen Weg, der ohne Anmeldung offen steht. Ohne sie
 * nimmt der Server jeden Rumpf an und packt ihn vollständig in den Speicher,
 * ehe er ihn als JSON liest — ein Passwort braucht dafür keine zwei Kilobyte.
 */
app.use('/api/auth/login', bodyLimit({ maxSize: 2 * 1024, onError: (c) => c.json({ ok: false, error: 'Rumpf zu groß' }, 413) }));
app.route('/api/auth', authRoute);
// Alles andere hinter dem gemeinsamen Passwort. Das statische PWA-Bundle
// bleibt bewusst frei: Sonst könnte sich die App weder installieren noch
// aktualisieren, und ein gesperrtes Gerät bekäme eine leere Seite statt des
// Passwortfelds.
app.use('/api/*', async (c, next) => {
  // Genauer Vergleich: `startsWith('/api/auth')` ließe auch `/api/authfoo`
  // durch. Heute liegt dort nichts, aber die Ausnahme soll genau das treffen,
  // was sie meint.
  const pfad = c.req.path;
  if (pfad === '/api/health' || pfad === '/api/auth' || pfad.startsWith('/api/auth/')) return next();
  return requireAuth(c, next);
});

// --- API ---
/**
 * Erreichbarkeitsprüfung.
 *
 * Bleibt **offen**, weil Proxy, Installer und jede Überwachung sie brauchen —
 * aber sie erzählt Fremden nur, dass der Dienst lebt. Vorher stand hier
 * ungeschützt, ob überhaupt ein Passwort gesetzt ist und welche kostenpflichtigen
 * Schlüssel der Betreiber hält (`flow: true` heißt: gültiger TomTom-Key). Das
 * ist kostenlose Aufklärung für jeden, der die Adresse kennt.
 *
 * Die Ebenen-Merkmale bekommt nur, wer angemeldet ist — dort braucht die App
 * sie auch, denn vor dem Entsperren wird sie gar nicht erst aufgebaut.
 */
app.get('/api/health', async (c) => {
  const basis = { ok: true, service: 'lagebild-api', ts: new Date().toISOString() };
  if (!isAuthed(c)) return c.json(basis);
  return c.json({
    ...basis,
    auth: authRequired(),
    features: {
      flow: await flowUsable(),
      ais: aisUsable(),
      aprs: aprsUsable(),
      lightning: lightningUsable(),
    },
  });
});
app.route('/api/weather', weatherRoute);
app.route('/api/alerts', alertsRoute);
app.route('/api/warnings', warningsRoute);
app.route('/api/traffic', trafficRoute);
app.route('/api/news', newsRoute);
app.route('/api/blaulicht', blaulichtRoute);
app.route('/api/pegel', pegelRoute);
app.route('/api/air', airRoute);
app.route('/api/radar', radarRoute);
app.route('/api/geocode', geocodeRoute);
app.route('/api/transit', transitRoute);
app.route('/api/stops', stopsRoute);
app.route('/api/flow', flowRoute);
app.route('/api/maps', mapsRoute);
app.route('/api/aircraft', aircraftRoute);
app.route('/api/vessels', vesselsRoute);
app.route('/api/aprs', aprsRoute);
app.route('/api/wind', windRoute);
app.route('/api/hf', hfRoute);
app.route('/api/vehicles', vehiclesRoute);
app.route('/api/hazards', hazardsRoute);
app.route('/api/lightning', lightningRoute);
app.route('/api/nina', ninaRoute);
app.route('/api/radiation', radiationRoute);
app.route('/api/pollen', pollenRoute);
app.route('/api/rest', restRoute);
app.route('/api/webcams', webcamsRoute);
app.route('/api/rescue', rescueRoute);
app.route('/api/avalanche', avalancheRoute);
app.route('/api/sat', satRoute);
app.route('/api/drones', dronesRoute);
app.route('/api/water', waterRoute);
// Offline-PMTiles pro Bundesland ausliefern (Download in den OPFS des Browsers).
app.use(
  '/api/maps/*',
  serveStatic({ root: config.mapsDir, rewriteRequestPath: (p) => p.replace(/^\/api\/maps\//, '/') }),
);

/*
 * Unbekannte Schnittstellenpfade sind ein Fehler, keine Oberfläche. Ohne diese
 * Zeile fiele `/api/tippfehler` durch bis zum SPA-Rückfall und käme als
 * `index.html` mit 200 zurück — was jeden Abruf, der sich verschreibt, als
 * Erfolg aussehen lässt.
 */
app.all('/api/*', (c) => c.json({ error: 'Unbekannter Pfad' }, 404));

// --- statisches PWA-Bundle (nur wenn gebaut vorhanden) ---
if (existsSync(config.webRoot)) {
  app.use('/*', serveStatic({ root: config.webRoot }));
  // SPA-Fallback: unbekannte Pfade auf index.html
  app.get('/*', serveStatic({ path: `${config.webRoot}/index.html` }));
}

// AIS kommt als Push-Stream — der Sammler läuft ab Start im Hintergrund.
startAisCollector();
// Blitzortung braucht keinen Schlüssel — eine Verbindung für den ganzen Server.
startLightningCollector();

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`lagebild-api läuft auf http://${config.host}:${info.port}`);
});
