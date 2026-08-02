import { Hono } from 'hono';
import type { HfBandCondition, HfMufGrid, HfSpaceWeather } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson, fetchText } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Funkwetter und Ausbreitungsbedingungen auf der Kurzwelle.
 *
 * Zwei Endpunkte:
 *   GET /api/hf/space   Sonnen- und Erdmagnetdaten samt Bandbewertungen
 *   GET /api/hf/muf     Weltweites Gitter der höchsten brauchbaren Frequenz
 *
 * Quellen und ihre Bitten (eingehalten):
 * - **N0NBH / hamqsl.com** liefert die aufbereiteten Kennzahlen und
 *   Bandbewertungen als XML. Die Daten werden stündlich erneuert — deshalb wird
 *   hier eine Stunde zwischengespeichert und die Quelle mit Rücklink genannt.
 * - **prop.kc2g.com** (Ionosonden aus dem GIRO-Netz) aktualisiert etwa alle
 *   15 Minuten; entsprechend wird gecacht und die Quelle genannt.
 * - **NOAA SWPC** ist gemeinfrei, wird aber ebenfalls gecacht.
 */
export const hfRoute = new Hono();

const HAMQSL_URL = process.env.HAMQSL_URL ?? 'https://www.hamqsl.com/solarxml.php';
const KC2G_URL = process.env.KC2G_URL ?? 'https://prop.kc2g.com/api/stations.json';
const NOAA_KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

/* ------------------------------------------------------------------ */
/* Kennzahlen und Bandbewertungen                                      */
/* ------------------------------------------------------------------ */

/** Wert eines einfachen XML-Elements (die Antwort ist flach und klein). */
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  const value = m?.[1]?.trim();
  return value ? value : null;
}

const num = (v: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** „Good/Fair/Poor" → eigene Stufen (auch im Text unterscheidbar, nicht nur farblich). */
function level(raw: string): HfBandCondition['level'] {
  const v = raw.toLowerCase();
  if (v.startsWith('good')) return 'good';
  if (v.startsWith('fair')) return 'fair';
  if (v.startsWith('poor')) return 'poor';
  return 'unknown';
}

hfRoute.get('/space', async (c) => {
  const cache = cached<HfSpaceWeather>('hf:space', 3600);
  if (cache.hit) return c.json(envelope(cache.hit, 'N0NBH (hamqsl.com)', true));

  let xml = '';
  try {
    xml = await fetchText(HAMQSL_URL, { timeoutMs: 9000 });
  } catch {
    /* unten folgt der Rückfall auf NOAA */
  }

  const bands: HfBandCondition[] = [];
  for (const m of xml.matchAll(/<band\s+name="([^"]+)"\s+time="([^"]+)"\s*>([^<]*)<\/band>/gi)) {
    bands.push({
      band: m[1]!,
      time: m[2]!.toLowerCase() === 'night' ? 'night' : 'day',
      level: level(m[3]!),
      text: m[3]!.trim(),
    });
  }

  let sfi = num(tag(xml, 'solarflux'));
  let kIndex = num(tag(xml, 'kindex'));
  let aIndex = num(tag(xml, 'aindex'));

  // Ohne hamqsl bleiben wenigstens die amtlichen Kennzahlen (NOAA, gemeinfrei).
  if (sfi == null || kIndex == null) {
    try {
      const kp = await fetchJson<{ Kp: number; time_tag: string }[]>(NOAA_KP, { timeoutMs: 8000 });
      const last = kp[kp.length - 1];
      if (last && kIndex == null) kIndex = Math.round(last.Kp);
      const flux = await fetchJson<{ flux: number }[]>(
        'https://services.swpc.noaa.gov/json/f107_cm_flux.json',
        { timeoutMs: 8000 },
      );
      const lastFlux = flux[flux.length - 1];
      if (lastFlux && sfi == null) sfi = Math.round(lastFlux.flux);
    } catch {
      /* auch das kann ausfallen — dann bleiben die Werte leer */
    }
  }

  const data: HfSpaceWeather = {
    updated: tag(xml, 'updated'),
    solarFluxIndex: sfi,
    sunspots: num(tag(xml, 'sunspots')),
    aIndex,
    kIndex,
    xray: tag(xml, 'xray'),
    aurora: num(tag(xml, 'aurora')),
    geomagField: tag(xml, 'geomagfield'),
    signalNoise: tag(xml, 'signalnoise'),
    solarWindKmS: num(tag(xml, 'solarwind')),
    bands,
  };
  cache.set(data);
  return c.json(envelope(data, 'N0NBH (hamqsl.com)'));
});

/* ------------------------------------------------------------------ */
/* MUF-Gitter                                                          */
/* ------------------------------------------------------------------ */

interface KcStation {
  mufd?: number | null;
  fof2?: number | null;
  time?: string;
  /** Achtung: Breite und Länge kommen als Zeichenketten, Länge in 0…360. */
  station?: { name?: string; latitude?: string | number; longitude?: string | number };
}

const RAD = Math.PI / 180;

/** Sonnenstand (Kosinus des Zenitwinkels) — grob, aber für ein Modellfeld genug. */
function cosZenith(lat: number, lon: number, date: Date): number {
  const dayOfYear = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  const decl = 23.44 * RAD * Math.sin(((360 / 365) * (dayOfYear - 81) * Math.PI) / 180);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60;
  // Stundenwinkel: 15° je Stunde, Mittag über dem Längengrad der Sonne.
  const hourAngle = (utcHours - 12) * 15 * RAD + lon * RAD;
  return (
    Math.sin(lat * RAD) * Math.sin(decl) + Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(hourAngle)
  );
}

/**
 * Einfaches Modellfeld: die kritische Frequenz folgt im Wesentlichen dem
 * Sonnenstand und der Sonnenaktivität. Das ersetzt kein Ionosphärenmodell,
 * füllt aber die großen Lücken zwischen den Messstellen (Ozeane!), an die
 * anschließend die echten Messwerte angeglichen werden.
 */
function modelMuf(lat: number, lon: number, date: Date, sfi: number): number {
  const cos = Math.max(0, cosZenith(lat, lon, date));
  const f0 = 4.5 + 0.045 * sfi; // Tagesniveau der kritischen Frequenz
  const fof2 = f0 * (0.22 + 0.78 * Math.sqrt(cos));
  return 3.1 * fof2; // M(3000)F2 ≈ 3,1
}

hfRoute.get('/muf', async (c) => {
  const cache = cached<HfMufGrid>('hf:muf', 900);
  if (cache.hit) return c.json(envelope(cache.hit, 'prop.kc2g.com / GIRO', true));

  // Sonnenfluss aus dem (stündlich gecachten) Funkwetter mitbenutzen.
  let sfi = 120;
  try {
    const flux = await fetchJson<{ flux: number }[]>(
      'https://services.swpc.noaa.gov/json/f107_cm_flux.json',
      { timeoutMs: 8000 },
    );
    const last = flux[flux.length - 1];
    if (last?.flux) sfi = Math.round(last.flux);
  } catch {
    /* Standardwert reicht als Grundlage */
  }

  let measured: { lat: number; lon: number; muf: number; name: string }[] = [];
  try {
    const raw = await fetchJson<KcStation[]>(KC2G_URL, { timeoutMs: 12000 });
    const fresh = Date.now() - 3 * 3600_000;
    measured = raw
      .map((s) => {
        const t = s.time ? Date.parse(`${s.time}Z`) : NaN;
        const lat = Number(s.station?.latitude);
        const lonRaw = Number(s.station?.longitude);
        const muf = Number(s.mufd);
        return { t, lat, lonRaw, muf, name: s.station?.name ?? '' };
      })
      .filter(
        (s) =>
          Number.isFinite(s.t) &&
          s.t > fresh &&
          Number.isFinite(s.muf) &&
          s.muf > 1 &&
          s.muf < 60 &&
          Number.isFinite(s.lat) &&
          Number.isFinite(s.lonRaw),
      )
      .map((s) => ({
        lat: s.lat,
        // kc2g zählt die Länge von 0 bis 360 — auf -180…180 bringen.
        lon: ((((s.lonRaw + 180) % 360) + 360) % 360) - 180,
        muf: s.muf,
        name: s.name,
      }));
  } catch {
    /* ohne Messwerte bleibt das reine Modellfeld */
  }

  const now = new Date();
  // Abweichung Messung/Modell je Station — daraus wird ein Korrekturfeld.
  const factors = measured.map((s) => ({
    ...s,
    factor: s.muf / Math.max(1, modelMuf(s.lat, s.lon, now, sfi)),
  }));

  const cell = 5;
  const cols = 360 / cell;
  const rows = 180 / cell + 1;
  const values: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = 90 - r * cell;
    for (let col = 0; col < cols; col++) {
      const lon = -180 + col * cell;
      const model = modelMuf(lat, lon, now, sfi);
      // Inverse Distanzgewichtung der Korrekturfaktoren (Reichweite ~3000 km).
      let sum = 0;
      let weight = 0;
      for (const f of factors) {
        const dLat = (f.lat - lat) * 111;
        const dLon = (f.lon - lon) * 111 * Math.cos(((f.lat + lat) / 2) * RAD);
        const km = Math.sqrt(dLat * dLat + dLon * dLon);
        if (km > 3000) continue;
        const w = 1 / (1 + (km / 600) ** 2);
        sum += f.factor * w;
        weight += w;
      }
      // Ohne Messung in Reichweite bleibt das Modell unverändert (Faktor 1).
      const factor = weight > 0 ? (sum + 1 * 0.35) / (weight + 0.35) : 1;
      values.push(Math.round(model * factor * 10) / 10);
    }
  }

  const data: HfMufGrid = {
    generatedAt: now.toISOString(),
    solarFluxIndex: sfi,
    cellDeg: cell,
    cols,
    rows,
    values,
    stations: measured.map((s) => ({ lat: s.lat, lon: s.lon, mufMHz: Math.round(s.muf * 10) / 10, name: s.name })),
  };
  cache.set(data);
  return c.json(envelope(data, 'prop.kc2g.com / GIRO'));
});
