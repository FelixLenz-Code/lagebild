import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verzeichnis der laufenden Server-Datei. Im Release-Tarball liegt das
// gebaute PWA-Bundle als `public/` direkt daneben.
const here = dirname(fileURLToPath(import.meta.url));

// Minimaler .env-Loader (ohne Abhängigkeit), damit der Single-File-Bundle
// keine node_modules braucht. Setzt nur Variablen, die nicht schon existieren.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(join(process.cwd(), '.env'));
loadEnvFile(join(here, '.env'));

/** Laufzeit-Konfiguration aus Umgebungsvariablen (siehe .env.example). */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  /** Sekunden, die eine Proxy-Antwort im Speicher-Cache frisch bleibt. */
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),
  /** Pfad zum gebauten PWA-Bundle, das der Server im Prod-Betrieb ausliefert. */
  webRoot: process.env.WEB_ROOT ?? join(here, 'public'),
  /** TomTom-API-Key für die Verkehrsfluss-Kacheln (bleibt serverseitig). */
  tomtomKey: process.env.TOMTOM_KEY ?? '',
  /** Verzeichnis mit den Offline-PMTiles pro Bundesland (z.B. 04.pmtiles). */
  mapsDir: process.env.MAPS_DIR ?? join(process.cwd(), 'maps'),
  isProd: process.env.NODE_ENV === 'production',
};
