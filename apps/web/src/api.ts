import type {
  ApiEnvelope,
  WeatherNow,
  Warning,
  TrafficIncident,
  NewsItem,
  WaterLevel,
  Coords,
} from '@lagebild/shared';

/** Standard-Standort, solange keine Geolocation vorliegt (Berlin-Mitte). */
export const DEFAULT_COORDS: Coords = { lat: 52.52, lon: 13.405 };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

const q = (c: Coords) => `lat=${c.lat}&lon=${c.lon}`;

export const fetchWeather = (c: Coords): Promise<ApiEnvelope<WeatherNow>> =>
  getJson(`/api/weather?${q(c)}`);

export const fetchAlerts = (c: Coords): Promise<ApiEnvelope<Warning[]>> =>
  getJson(`/api/alerts?${q(c)}`);

export const fetchTraffic = (c: Coords): Promise<ApiEnvelope<TrafficIncident[]>> =>
  getJson(`/api/traffic?${q(c)}`);

export const fetchPegel = (c: Coords): Promise<ApiEnvelope<WaterLevel[]>> =>
  getJson(`/api/pegel?${q(c)}`);

export const fetchNews = (): Promise<ApiEnvelope<NewsItem[]>> => getJson(`/api/news`);
