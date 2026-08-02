import { Hono } from 'hono';
import type { TransitVehicle } from '@lagebild/shared';
import { readBbox } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { MODE_DE, MOTIS_BASE, decodePolyline } from '../lib/motis.js';

/**
 * Fahrzeuge des öffentlichen Verkehrs in Bewegung (transitous.org / MOTIS).
 *
 * `map/trips` liefert **keine Positionen**, sondern die Fahrtabschnitte im
 * Ausschnitt mit Abfahrt, Ankunft und Linienzug. Die Position wird daraus
 * gerechnet: Anteil der verstrichenen Zeit → Punkt auf der Strecke. Genau so
 * arbeiten auch die Live-Karten der Verkehrsverbünde; ohne echte
 * Fahrzeugortung ist es eine Schätzung, aber eine gute.
 */
export const vehiclesRoute = new Hono();

/** Größere Ausschnitte liefern zu viele Fahrten — die Ebene ist zoom-begrenzt. */
const MAX_SPAN_DEG = 2.5;
const MAX_VEHICLES = 400;
/** Flugzeuge kommen aus dem ADS-B-Netz, nicht aus dem Fahrplan. */
const SKIP_MODES = new Set(['AIRPLANE']);

interface TripSegment {
  trips?: { tripId?: string; routeShortName?: string }[];
  mode?: string;
  from?: { name?: string };
  to?: { name?: string };
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  realTime?: boolean;
  polyline?: string;
}

/** Kurs zwischen zwei Punkten in Grad. */
function bearing(a: [number, number], b: [number, number]): number {
  const RAD = Math.PI / 180;
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

vehiclesRoute.get('/', async (c) => {
  const bbox = readBbox(c);
  if (!bbox) return c.json({ error: 'bbox erforderlich' }, 400);
  if (bbox.east - bbox.west > MAX_SPAN_DEG || bbox.north - bbox.south > MAX_SPAN_DEG) {
    return c.json(envelope([] as TransitVehicle[], 'transitous.org'));
  }

  // Positionen veralten in Sekunden — kurz cachen, aber nicht gar nicht.
  const key = `vehicles:${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`;
  const cache = cached<TransitVehicle[]>(key, 15);
  if (cache.hit) return c.json(envelope(cache.hit, 'transitous.org', true));

  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
  const url =
    `${MOTIS_BASE}/map/trips?min=${bbox.south},${bbox.west}&max=${bbox.north},${bbox.east}` +
    `&zoom=12&startTime=${iso(now - 60_000)}&endTime=${iso(now + 60_000)}`;

  try {
    const segments = await fetchJson<TripSegment[]>(url, { timeoutMs: 12000 });
    const out: TransitVehicle[] = [];
    for (const s of segments) {
      if (out.length >= MAX_VEHICLES) break;
      if (!s.polyline || !s.departure || !s.arrival) continue;
      if (SKIP_MODES.has(s.mode ?? '')) continue;
      const start = Date.parse(s.departure);
      const end = Date.parse(s.arrival);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      // Nur Abschnitte, die gerade befahren werden.
      if (now < start || now > end) continue;

      // Achtung: `map/trips` liefert Genauigkeit 5 — anders als die
      // Verbindungen aus `/plan`, die ihre Genauigkeit selbst mitschicken.
      const line = decodePolyline(s.polyline, 5);
      if (line.length < 2) continue;
      const fraction = (now - start) / (end - start);

      // Punkt auf der Strecke nach zurückgelegtem Anteil der Länge.
      let total = 0;
      const steps: number[] = [0];
      for (let i = 1; i < line.length; i++) {
        total += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
        steps.push(total);
      }
      const target = total * fraction;
      let idx = 1;
      while (idx < steps.length - 1 && steps[idx]! < target) idx++;
      const span = steps[idx]! - steps[idx - 1]!;
      const t = span > 0 ? (target - steps[idx - 1]!) / span : 0;
      const a = line[idx - 1]!;
      const b = line[idx]!;
      const lon = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue;

      const trip = s.trips?.[0];
      const planned = s.scheduledDeparture ? Date.parse(s.scheduledDeparture) : NaN;
      out.push({
        id: trip?.tripId ?? `${s.from?.name}-${s.departure}`,
        line: trip?.routeShortName ?? MODE_DE[s.mode ?? ''] ?? '?',
        mode: s.mode ?? 'OTHER',
        product: MODE_DE[s.mode ?? ''] ?? null,
        lat,
        lon,
        bearing: Math.round(bearing(a, b)),
        towards: s.to?.name ?? '',
        delayMin: Number.isFinite(planned) ? Math.round((start - planned) / 60000) : null,
        realTime: Boolean(s.realTime),
      });
    }
    cache.set(out);
    return c.json(envelope(out, 'transitous.org'));
  } catch {
    return c.json(envelope([] as TransitVehicle[], 'transitous.org'));
  }
});
