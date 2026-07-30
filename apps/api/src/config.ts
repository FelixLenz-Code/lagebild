import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verzeichnis der laufenden Server-Datei. Im Release-Tarball liegt das
// gebaute PWA-Bundle als `public/` direkt daneben.
const here = dirname(fileURLToPath(import.meta.url));

/** Laufzeit-Konfiguration aus Umgebungsvariablen (siehe .env.example). */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  /** Sekunden, die eine Proxy-Antwort im Speicher-Cache frisch bleibt. */
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),
  /** Pfad zum gebauten PWA-Bundle, das der Server im Prod-Betrieb ausliefert. */
  webRoot: process.env.WEB_ROOT ?? join(here, 'public'),
  isProd: process.env.NODE_ENV === 'production',
};
