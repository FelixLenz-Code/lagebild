/**
 * Gemeinsame Datentypen zwischen Backend-Proxy und PWA-Frontend.
 * Der Proxy normalisiert jede externe Quelle auf genau diese Formate,
 * damit das Frontend (und der Offline-Cache) ein stabiles Schema kennt.
 */

/** Geografische Koordinaten (WGS84). */
export interface Coords {
  lat: number;
  lon: number;
}

/** Warnstufe, angelehnt an die DWD/NINA-Skala. */
export type Severity = 'minor' | 'moderate' | 'severe' | 'extreme';

/** Wetter-Zustand, normalisiert (Bright Sky `condition`). */
export type WeatherCondition =
  | 'dry'
  | 'fog'
  | 'rain'
  | 'sleet'
  | 'snow'
  | 'hail'
  | 'thunderstorm'
  | 'clear-day'
  | 'clear-night'
  | 'partly-cloudy-day'
  | 'partly-cloudy-night'
  | 'cloudy'
  | null;

/** Aktueller Wetterwert für einen Standort. */
export interface WeatherNow {
  tempC: number | null;
  feelsLikeC: number | null;
  condition: WeatherCondition;
  icon: string | null;
  windKmh: number | null;
  windGustKmh: number | null;
  windDirDeg: number | null;
  humidityPct: number | null;
  precipitationMm: number | null;
  pressureHpa: number | null;
  observedAt: string | null;
}

/** Ein Vorhersage-Zeitschritt (stündlich oder täglich aggregiert). */
export interface WeatherForecastStep {
  time: string;
  tempC: number | null;
  tempMinC?: number | null;
  tempMaxC?: number | null;
  condition: WeatherCondition;
  precipitationProbabilityPct: number | null;
  windKmh: number | null;
}

/** Amtliche Warnung (DWD-Unwetter oder NINA/BBK). */
export interface Warning {
  id: string;
  provider: 'dwd' | 'mowas' | 'katwarn' | 'biwapp' | 'lhp' | 'police' | string;
  event: string;
  headline: string;
  description?: string;
  severity: Severity;
  onset?: string | null;
  expires?: string | null;
  /** GeoJSON-Geometrie des Warngebiets, falls vorhanden. */
  area?: GeoJsonGeometry | null;
}

/** Amtliche Warnung mit Geometrie fürs Kartenlayer (DWD-GeoServer). Eine
 *  Warnung (gleiche `id`) kann als mehrere Gemeinde-Flächen vorliegen. */
export interface WarningFeature {
  id: string;
  event: string;
  headline: string;
  description?: string;
  instruction?: string;
  severity: Severity;
  regionName?: string;
  onset: string | null;
  expires: string | null;
  geometry: GeoJsonGeometry;
}

/** Verkehrsmeldung (Autobahn-API: Baustelle, Sperrung, Stau). */
export interface TrafficIncident {
  id: string;
  road: string;
  kind: 'roadworks' | 'closure' | 'warning' | 'jam';
  title: string;
  description?: string;
  coordinates?: Coords | null;
  startsAt?: string | null;
}

/** Pegelstand (PEGELONLINE). */
export interface WaterLevel {
  station: string;
  water: string;
  levelCm: number | null;
  trend: 'rising' | 'falling' | 'steady' | null;
  measuredAt: string | null;
  coordinates?: Coords | null;
}

/** Luftqualität nach European Air Quality Index (EAQI). */
export type AirCategory = 'good' | 'fair' | 'moderate' | 'poor' | 'very-poor' | 'extremely-poor';

export interface AirQuality {
  aqi: number | null;
  category: AirCategory | null;
  pm10: number | null;
  pm25: number | null;
  no2: number | null;
  o3: number | null;
  measuredAt: string | null;
}

/** Regenradar-Frames (RainViewer). `forecast` = Nowcast statt Vergangenheit. */
export interface RadarFrame {
  time: number;
  path: string;
  forecast: boolean;
}
export interface RadarData {
  host: string;
  frames: RadarFrame[];
}

/** Nachrichten-/Ereignismeldung (Tagesschau). */
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: string | null;
  topic?: string;
}

/** Öffentlich dokumentierte GeoJSON-Geometrie (vereinfacht). */
export type GeoJsonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

/**
 * Standard-Hülle jeder Proxy-Antwort. `fetchedAt` erlaubt dem Frontend die
 * "aktualisiert vor …"-Anzeige und die Offline-Frische-Bewertung.
 */
export interface ApiEnvelope<T> {
  data: T;
  source: string;
  fetchedAt: string;
  /** true, wenn der Proxy die Daten aus seinem Cache statt live geliefert hat. */
  stale?: boolean;
}

/** Ergebnis einer Ortssuche (Geocoding). */
export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
}

/** Amtlicher Gemeindeschlüssel → die ersten zwei Ziffern kennzeichnen das Bundesland. */
export type StateCode =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08'
  | '09' | '10' | '11' | '12' | '13' | '14' | '15' | '16';

export interface FederalState {
  code: StateCode;
  name: string;
}

export const FEDERAL_STATES: readonly FederalState[] = [
  { code: '01', name: 'Schleswig-Holstein' },
  { code: '02', name: 'Hamburg' },
  { code: '03', name: 'Niedersachsen' },
  { code: '04', name: 'Bremen' },
  { code: '05', name: 'Nordrhein-Westfalen' },
  { code: '06', name: 'Hessen' },
  { code: '07', name: 'Rheinland-Pfalz' },
  { code: '08', name: 'Baden-Württemberg' },
  { code: '09', name: 'Bayern' },
  { code: '10', name: 'Saarland' },
  { code: '11', name: 'Berlin' },
  { code: '12', name: 'Brandenburg' },
  { code: '13', name: 'Mecklenburg-Vorpommern' },
  { code: '14', name: 'Sachsen' },
  { code: '15', name: 'Sachsen-Anhalt' },
  { code: '16', name: 'Thüringen' },
] as const;
