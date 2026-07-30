import type {
  ApiEnvelope,
  WeatherNow,
  WarningFeature,
  TrafficIncident,
  NewsItem,
  WaterLevel,
  AirQuality,
  RadarData,
  GeoResult,
  TransitStop,
  Coords,
} from '@lagebild/shared';

/** Standard-Standort, solange keine Geolocation vorliegt (Berlin-Mitte). */
export const DEFAULT_COORDS: Coords = { lat: 52.52, lon: 13.405 };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Kartenausschnitt (WGS84). */
export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

const q = (c: Coords) => `lat=${c.lat}&lon=${c.lon}`;
const bboxQ = (b: Bbox) =>
  `bbox=${b.west.toFixed(3)},${b.south.toFixed(3)},${b.east.toFixed(3)},${b.north.toFixed(3)}`;

// Punktbezogen (dein Standort):
export const fetchWeather = (c: Coords): Promise<ApiEnvelope<WeatherNow>> =>
  getJson(`/api/weather?${q(c)}`);

export const fetchNews = (): Promise<ApiEnvelope<NewsItem[]>> => getJson(`/api/news`);

export const fetchAir = (c: Coords): Promise<ApiEnvelope<AirQuality>> =>
  getJson(`/api/air?${q(c)}`);

export const fetchTransit = (c: Coords): Promise<ApiEnvelope<TransitStop[]>> =>
  getJson(`/api/transit?${q(c)}`);

export const fetchRadar = (): Promise<ApiEnvelope<RadarData>> => getJson(`/api/radar`);

export const fetchGeocode = (query: string): Promise<ApiEnvelope<GeoResult[]>> =>
  getJson(`/api/geocode?q=${encodeURIComponent(query)}`);

export interface Health {
  ok: boolean;
  features?: { flow?: boolean };
}
export const fetchHealth = (): Promise<Health> => getJson(`/api/health`);

export interface MapsList {
  data: { code: string; bytes: number }[];
}
export const fetchMaps = (): Promise<MapsList> => getJson(`/api/maps`);

// Kartenausschnitt-bezogen (alles im sichtbaren Bereich):
export const fetchWarnings = (b: Bbox): Promise<ApiEnvelope<WarningFeature[]>> =>
  getJson(`/api/warnings?${bboxQ(b)}`);

export const fetchTraffic = (b: Bbox): Promise<ApiEnvelope<TrafficIncident[]>> =>
  getJson(`/api/traffic?${bboxQ(b)}`);

export const fetchPegel = (b: Bbox): Promise<ApiEnvelope<WaterLevel[]>> =>
  getJson(`/api/pegel?${bboxQ(b)}`);
