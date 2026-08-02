import type {
  ApiEnvelope,
  WeatherNow,
  WeatherForecast,
  RadarForecast,
  WarningFeature,
  TrafficIncident,
  NewsItem,
  WaterLevel,
  WaterLevelHistory,
  AirQuality,
  RadarData,
  GeoResult,
  HfSpaceWeather,
  HfMufGrid,
  TransitVehicle,
  LightningStrike,
  CivilWarning,
  FireDetection,
  RadiationStation,
  PollenForecast,
  EarthquakeItem,
  AuroraGrid,
  FireDangerGrid,
  TransitStop,
  TransitStopPoint,
  TransitDeparture,
  TransitTrip,
  TransitItinerary,
  Aircraft,
  AircraftDetails,
  Vessel,
  AprsStation,
  WindField,
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

/** Nachrichten; mit Standort kommen die Meldungen des Regionalprogramms dazu. */
export const fetchNews = (near?: Coords): Promise<ApiEnvelope<NewsItem[]>> =>
  getJson(`/api/news${near ? `?${q(near)}` : ''}`);

export const fetchAir = (c: Coords): Promise<ApiEnvelope<AirQuality>> =>
  getJson(`/api/air?${q(c)}`);

export const fetchTransit = (c: Coords): Promise<ApiEnvelope<TransitStop[]>> =>
  getJson(`/api/transit?${q(c)}`);

/** Haltestellen im Ausschnitt — aus den Fahrplandaten, nicht aus OSM. */
export const fetchStops = (b: Bbox): Promise<ApiEnvelope<TransitStopPoint[]>> =>
  getJson(`/api/stops?${bboxQ(b)}`);

/**
 * ÖPNV-Verbindungen zwischen zwei Punkten. Braucht Netz — Fahrpläne und
 * Echtzeit liegen nicht im Gerät.
 */
export const fetchPlan = (
  from: Coords,
  to: Coords,
  time?: string | null,
  arriveBy = false,
): Promise<ApiEnvelope<TransitItinerary[]>> =>
  getJson(
    `/api/transit/plan?from=${from.lat},${from.lon}&to=${to.lat},${to.lon}` +
      `${time ? `&time=${encodeURIComponent(time)}` : ''}${arriveBy ? '&arriveBy=1' : ''}`,
  );

/** Laufweg einer Fahrt (alle Halte mit Zeiten). */
export const fetchTrip = (tripId: string): Promise<ApiEnvelope<TransitTrip | null>> =>
  getJson(`/api/stops/trip?id=${encodeURIComponent(tripId)}`);

/** Nächste Abfahrten einer Haltestelle (alle Steige). */
export const fetchStopDepartures = (ids: string[]): Promise<ApiEnvelope<TransitDeparture[]>> =>
  getJson(`/api/stops/departures?id=${encodeURIComponent(ids.join(','))}`);

export const fetchRadar = (): Promise<ApiEnvelope<RadarData>> => getJson(`/api/radar`);

/** DWD-Radarvorhersage (5-Min-Schritte bis +2 h) rund um einen Punkt. */
export const fetchRadarForecast = (c: Coords): Promise<ApiEnvelope<RadarForecast>> =>
  getJson(`/api/radar/forecast?${q(c)}&distance=150000`);

/** Online-Ortssuche; mit Bezugspunkt bevorzugt Photon nahe Treffer. */
/** Fahrzeuge des öffentlichen Verkehrs im Ausschnitt (Position geschätzt). */
export const fetchVehicles = (b: Bbox): Promise<ApiEnvelope<TransitVehicle[]>> =>
  getJson(`/api/vehicles?${bboxQ(b)}`);

/** Behördenwarnungen (BBK/NINA), die den Ausschnitt berühren. */
export const fetchNina = (b: Bbox): Promise<ApiEnvelope<CivilWarning[]>> =>
  getJson(`/api/nina?${bboxQ(b)}`);

/** Blitzentladungen im Ausschnitt (Blitzortung.org, letzte Minuten). */
export const fetchLightning = (b: Bbox, minutes = 30): Promise<ApiEnvelope<LightningStrike[]>> =>
  getJson(`/api/lightning?${bboxQ(b)}&minutes=${minutes}`);

/** Erdbeben der letzten Woche ab Stärke 2,5. */
export const fetchQuakes = (): Promise<ApiEnvelope<EarthquakeItem[]>> =>
  getJson(`/api/hazards/quakes`);

/** Wärmeanomalien der letzten 24 h im Ausschnitt (NASA FIRMS). */
export const fetchFires = (b: Bbox): Promise<ApiEnvelope<FireDetection[]>> =>
  getJson(`/api/hazards/fires?${bboxQ(b)}`);

/** Ortsdosisleistung im Ausschnitt (BfS). */
export const fetchRadiation = (b: Bbox): Promise<ApiEnvelope<RadiationStation[]>> =>
  getJson(`/api/radiation?${bboxQ(b)}`);

/** Pollenbelastung in der Region des Standorts (DWD). */
export const fetchPollen = (c: Coords): Promise<ApiEnvelope<PollenForecast | null>> =>
  getJson(`/api/pollen?lat=${c.lat}&lon=${c.lon}`);

/** Polarlicht-Wahrscheinlichkeit als weltweites Gitter. */
export const fetchAurora = (): Promise<ApiEnvelope<AuroraGrid>> => getJson(`/api/hazards/aurora`);

/** Waldbrandgefahr in Deutschland (DWD, Stufe 1–5). */
export const fetchFireDanger = (): Promise<ApiEnvelope<FireDangerGrid>> =>
  getJson(`/api/hazards/fire`);

/** Funkwetter: Kennzahlen und Bandbewertungen (stündlich erneuert). */
export const fetchHfSpace = (): Promise<ApiEnvelope<HfSpaceWeather>> => getJson(`/api/hf/space`);

/** Weltweites MUF-Gitter für die Ausbreitungsebene. */
export const fetchHfMuf = (): Promise<ApiEnvelope<HfMufGrid>> => getJson(`/api/hf/muf`);

export const fetchGeocode = (query: string, near?: Coords): Promise<ApiEnvelope<GeoResult[]>> =>
  getJson(`/api/geocode?q=${encodeURIComponent(query)}${near ? `&${q(near)}` : ''}`);

export interface Health {
  ok: boolean;
  features?: { flow?: boolean; ais?: boolean; aprs?: boolean; lightning?: boolean };
}
export const fetchHealth = (): Promise<Health> => getJson(`/api/health`);

/** Auf dem Server bereitliegende Offline-Pakete je Bundesland (Bytes). */
export interface MapsList {
  data: { code: string; map?: number; route?: number; search?: number }[];
}
export const fetchMaps = (): Promise<MapsList> => getJson(`/api/maps`);

// Kartenausschnitt-bezogen (alles im sichtbaren Bereich):
export const fetchWarnings = (b: Bbox): Promise<ApiEnvelope<WarningFeature[]>> =>
  getJson(`/api/warnings?${bboxQ(b)}`);

export const fetchTraffic = (b: Bbox): Promise<ApiEnvelope<TrafficIncident[]>> =>
  getJson(`/api/traffic?${bboxQ(b)}`);

export const fetchPegel = (b: Bbox): Promise<ApiEnvelope<WaterLevel[]>> =>
  getJson(`/api/pegel?${bboxQ(b)}`);

/** Verlauf einer Messstelle (ausgedünnt auf ~120 Punkte). */
export const fetchPegelHistory = (id: string, days = 3): Promise<ApiEnvelope<WaterLevelHistory>> =>
  getJson(`/api/pegel/history?id=${encodeURIComponent(id)}&days=${days}`);

export const fetchAircraft = (b: Bbox): Promise<ApiEnvelope<Aircraft[]>> =>
  getJson(`/api/aircraft?${bboxQ(b)}`);

/** Halter, Muster und Flugroute eines einzelnen Flugzeugs (adsbdb.com). */
export const fetchAircraftDetails = (
  icao: string,
  callsign?: string | null,
): Promise<ApiEnvelope<AircraftDetails>> =>
  getJson(`/api/aircraft/${encodeURIComponent(icao)}${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ''}`);

export const fetchVessels = (b: Bbox): Promise<ApiEnvelope<Vessel[]>> =>
  getJson(`/api/vessels?${bboxQ(b)}`);

/** Windfeld (Gitter aus Open-Meteo) über dem Kartenausschnitt. */
export const fetchWind = (b: Bbox): Promise<ApiEnvelope<WindField>> =>
  getJson(`/api/wind?${bboxQ(b)}`);

/** APRS: aprs.fi beantwortet nur gezielte Rufzeichen-Abfragen (max. 20). */
export const fetchAprs = (targets: string[]): Promise<ApiEnvelope<AprsStation[]>> =>
  getJson(`/api/aprs?targets=${encodeURIComponent(targets.join(','))}`);
