import { Hono } from 'hono';
import type { WebcamSpot } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchText } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Öffentliche Panorama-Webcams von **Foto-Webcam.eu**.
 *
 * Das Projekt bündelt hochauflösende Bergkameras im Alpenraum und in
 * Deutschland. Eine Datenschnittstelle gibt es nicht; die Übersichtsseite
 * trägt die Liste aber als JSON im Quelltext (`var metadata = {"cams":[…]}`) —
 * genau die wird hier einmal alle sechs Stunden gelesen.
 *
 * **Bitte des Betreibers (eingehalten):** Im Impressum steht, dass Links auf
 * die Seite und ihre Unterseiten „generell gestattet und auch erwünscht" sind,
 * die Nutzung der **Bilder** aber je Kamera geregelt ist. Deshalb zeigt diese
 * App **keine** Kamerabilder, sondern nur Standort, Blickrichtung und einen
 * Link zur jeweiligen Kameraseite — dorthin, wo die Betreiber ihre eigenen
 * Bedingungen nennen. Ein Abruf alle sechs Stunden für alle Nutzer zusammen
 * hält die Last bei ihnen zudem winzig.
 */
export const webcamsRoute = new Hono();

const START_PAGE = process.env.FOTOWEBCAM_URL ?? 'https://www.foto-webcam.eu/';

interface RawCam {
  id?: string;
  name?: string;
  title?: string;
  link?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
  /** Blickrichtung in Grad. */
  direction?: number;
  sector?: number;
  country?: string;
  offline?: boolean;
  hidden?: boolean;
}

/**
 * Das eingebettete Array aus dem Quelltext schneiden: ab `[{"id":"…","name"`
 * bis zur passenden schließenden Klammer. Robuster als ein regulärer Ausdruck
 * über den ganzen Inhalt und ohne Abhängigkeit von der Seitenstruktur.
 */
function extractCams(html: string): RawCam[] {
  const start = html.search(/\[\s*\{"id":"[^"]+","name"/);
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as RawCam[];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

async function loadCams(): Promise<WebcamSpot[]> {
  const cache = cached<WebcamSpot[]>('webcams:list', 21_600);
  if (cache.hit) return cache.hit;
  try {
    const html = await fetchText(START_PAGE, { timeoutMs: 15000 });
    const cams = extractCams(html)
      .filter((c) => !c.hidden && typeof c.latitude === 'number' && typeof c.longitude === 'number')
      .map(
        (c): WebcamSpot => ({
          id: c.id ?? `${c.latitude},${c.longitude}`,
          name: c.name?.trim() || c.title?.trim() || 'Webcam',
          title: c.title?.trim() || null,
          lat: c.latitude!,
          lon: c.longitude!,
          elevationM: typeof c.elevation === 'number' ? Math.round(c.elevation) : null,
          bearing: typeof c.direction === 'number' ? Math.round(c.direction) : null,
          country: (c.country ?? '').toUpperCase(),
          offline: Boolean(c.offline),
          url: c.link ?? START_PAGE,
        }),
      );
    return cache.set(cams);
  } catch {
    return cache.set([]);
  }
}

/**
 *   GET /api/webcams[?bbox=west,süd,ost,nord]
 *
 * Kamerastandorte im Ausschnitt — ohne Bilder, mit Link zur Kameraseite.
 */
webcamsRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  const all = await loadCams();
  const data = bbox
    ? all.filter(
        (w) => w.lon >= bbox.west && w.lon <= bbox.east && w.lat >= bbox.south && w.lat <= bbox.north,
      )
    : all;
  return c.json(envelope(data, 'Foto-Webcam.eu'));
});
