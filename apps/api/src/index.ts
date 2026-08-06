import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { weatherRoute } from './routes/weather.js';
import { alertsRoute } from './routes/alerts.js';
import { warningsRoute } from './routes/warnings.js';
import { trafficRoute } from './routes/traffic.js';
import { newsRoute } from './routes/news.js';
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
import { authRoute, requireAuth } from './routes/auth.js';
import { authRequired } from './lib/auth.js';

const app = new Hono();

app.use('*', logger());

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
app.route('/api/auth', authRoute);
// Alles andere hinter dem gemeinsamen Passwort. Das statische PWA-Bundle
// bleibt bewusst frei: Sonst könnte sich die App weder installieren noch
// aktualisieren, und ein gesperrtes Gerät bekäme eine leere Seite statt des
// Passwortfelds.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path.startsWith('/api/auth')) return next();
  return requireAuth(c, next);
});

// --- API ---
app.get('/api/health', async (c) =>
  c.json({
    ok: true,
    service: 'lagebild-api',
    ts: new Date().toISOString(),
    auth: authRequired(),
    features: {
      flow: await flowUsable(),
      ais: aisUsable(),
      aprs: aprsUsable(),
      lightning: lightningUsable(),
    },
  }),
);
app.route('/api/weather', weatherRoute);
app.route('/api/alerts', alertsRoute);
app.route('/api/warnings', warningsRoute);
app.route('/api/traffic', trafficRoute);
app.route('/api/news', newsRoute);
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
// Offline-PMTiles pro Bundesland ausliefern (Download in den OPFS des Browsers).
app.use(
  '/api/maps/*',
  serveStatic({ root: config.mapsDir, rewriteRequestPath: (p) => p.replace(/^\/api\/maps\//, '/') }),
);

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
