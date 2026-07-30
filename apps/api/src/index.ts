import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { weatherRoute } from './routes/weather.js';

const app = new Hono();

app.use('*', logger());
app.use('/api/*', cors());

// --- API ---
app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'lagebild-api', ts: new Date().toISOString() }),
);
app.route('/api/weather', weatherRoute);

// --- statisches PWA-Bundle (nur wenn gebaut vorhanden) ---
if (existsSync(config.webRoot)) {
  app.use('/*', serveStatic({ root: config.webRoot }));
  // SPA-Fallback: unbekannte Pfade auf index.html
  app.get('/*', serveStatic({ path: `${config.webRoot}/index.html` }));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`lagebild-api läuft auf http://${config.host}:${info.port}`);
});
