import type {
  ApiEnvelope,
  WeatherNow,
  WeatherForecast,
  RadarForecast,
  WarningFeature,
  TrafficIncident,
  NewsItem,
  WaterLevel,
  AirQuality,
  RadarData,
  GeoResult,
  TransitStop,
  Aircraft,
  Vessel,
  AprsStation,
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

export const fetchForecast = (c: Coords): Promise<ApiEnvelope<WeatherForecast>> =>
  getJson(`/api/weather/forecast?${q(c)}`);

export const fetchNews = (): Promise<ApiEnvelope<NewsItem[]>> => getJson(`/api/news`);

export const fetchAir = (c: Coords): Promise<ApiEnvelope<AirQuality>> =>
  getJson(`/api/air?${q(c)}`);

export const fetchTransit = (c: Coords): Promise<ApiEnvelope<TransitStop[]>> =>
  getJson(`/api/transit?${q(c)}`);

export const fetchRadar = (): Promise<ApiEnvelope<RadarData>> => getJson(`/api/radar`);

/** DWD-Radarvorhersage (5-Min-Schritte bis +2 h) rund um einen Punkt. */
export const fetchRadarForecast = (c: Coords): Promise<ApiEnvelope<RadarForecast>> =>
  getJson(`/api/radar/forecast?${q(c)}&distance=150000`);

export const fetchGeocode = (query: string): Promise<ApiEnvelope<GeoResult[]>> =>
  getJson(`/api/geocode?q=${encodeURIComponent(query)}`);

export interface Health {
  ok: boolean;
  features?: { flow?: boolean; ais?: boolean; aprs?: boolean };
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

export const fetchAircraft = (b: Bbox): Promise<ApiEnvelope<Aircraft[]>> =>
  getJson(`/api/aircraft?${bboxQ(b)}`);

export const fetchVessels = (b: Bbox): Promise<ApiEnvelope<Vessel[]>> =>
  getJson(`/api/vessels?${bboxQ(b)}`);

/** APRS: aprs.fi beantwortet nur gezielte Rufzeichen-Abfragen (max. 20). */
export const fetchAprs = (targets: string[]): Promise<ApiEnvelope<AprsStation[]>> =>
  getJson(`/api/aprs?targets=${encodeURIComponent(targets.join(','))}`);
