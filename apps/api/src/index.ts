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
import { flowRoute, flowUsable } from './routes/flow.js';
import { mapsRoute } from './routes/maps.js';

const app = new Hono();

app.use('*', logger());
app.use('/api/*', cors());

// --- API ---
app.get('/api/health', async (c) =>
  c.json({
    ok: true,
    service: 'lagebild-api',
    ts: new Date().toISOString(),
    features: { flow: await flowUsable() },
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
app.route('/api/flow', flowRoute);
app.route('/api/maps', mapsRoute);
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

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`lagebild-api läuft auf http://${config.host}:${info.port}`);
});
