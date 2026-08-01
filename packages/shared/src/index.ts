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

/** Ein stündlicher Vorhersage-Zeitschritt. */
export interface WeatherForecastStep {
  time: string;
  tempC: number | null;
  condition: WeatherCondition;
  icon: string | null;
  precipitationProbabilityPct: number | null;
  precipitationMm: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
}

/** Ein Vorhersage-Tag (aus den Stundenwerten aggregiert). */
export interface WeatherDay {
  /** Kalendertag lokal, `YYYY-MM-DD`. */
  date: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  /** Prägendes Wetter des Tages (schwerwiegendste Tagstunde). */
  condition: WeatherCondition;
  icon: string | null;
  precipitationProbabilityPct: number | null;
  precipitationMm: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
}

/** Vorhersage für einen Standort: Stundenverlauf + Tagesübersicht. */
export interface WeatherForecast {
  hourly: WeatherForecastStep[];
  daily: WeatherDay[];
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

/**
 * Radar-Vorhersage des DWD (RADOLAN-RV via Bright Sky): 5-Minuten-Raster von
 * ~-30 min bis +2 h. Jeder Frame ist ein zlib-komprimiertes uint16-Gitter
 * (Little Endian, zeilenweise von Nord nach Süd), base64-kodiert. Einheit:
 * 0,01 mm Niederschlag pro 5 Minuten.
 */
export interface RadarForecastFrame {
  time: string;
  /** true = Vorhersage, false = bereits gemessen. */
  forecast: boolean;
  data: string;
}
export interface RadarForecast {
  width: number;
  height: number;
  /** Bildecken im Uhrzeigersinn ab Nordwest: NW, NO, SO, SW. */
  corners: [number, number][];
  frames: RadarForecastFrame[];
}

/** Eine Abfahrt an einem Halt (DB/ÖPNV) mit Echtzeit-Verspätung. */
export interface TransitDeparture {
  line: string;
  product: string | null;
  direction: string;
  when: string | null;
  plannedWhen: string | null;
  delayMin: number | null;
  platform: string | null;
  cancelled: boolean;
  remark?: string;
}

/** Ein Halt in der Nähe mit seinen nächsten Abfahrten. */
export interface TransitStop {
  id: string;
  name: string;
  distanceM: number | null;
  coordinates: Coords | null;
  departures: TransitDeparture[];
}

/**
 * Grobe Musterklasse aus der ADS-B-Kategorie — steuert das Kartensymbol.
 * `light` = Kleinflugzeug, `jet` = Verkehrsflugzeug, `heavy` = Großraumflugzeug,
 * `helicopter` = Drehflügler, `glider` = Segelflug/Ballon, `other` = Rest.
 */
export type AircraftClass = 'light' | 'jet' | 'heavy' | 'helicopter' | 'glider' | 'other';

/** Flugzeug aus dem ADS-B-Netz (Position, Höhe, Kurs). */
export interface Aircraft {
  /** ICAO-24-Adresse (hex) — eindeutige Kennung des Transponders. */
  icao: string;
  callsign: string | null;
  registration: string | null;
  /** ICAO-Musterkürzel, z.B. „A320". */
  type: string | null;
  /** Klartext-Muster, z.B. „AIRBUS A220-300". */
  description: string | null;
  /** ADS-B-Kategorie (A1–A7, B1–B7, C1–C3). */
  category: string | null;
  aircraftClass: AircraftClass;
  coordinates: Coords;
  /** Barometrische Höhe in Fuß; null wenn am Boden gemeldet. */
  altitudeFt: number | null;
  /** Vom Autopiloten eingestellte Zielhöhe in Fuß. */
  selectedAltitudeFt: number | null;
  /** Steig-/Sinkrate in Fuß pro Minute. */
  verticalRateFpm: number | null;
  /** Geschwindigkeit über Grund in Knoten. */
  groundSpeedKt: number | null;
  /** Angezeigte Eigengeschwindigkeit in Knoten. */
  indicatedSpeedKt: number | null;
  /** Machzahl (in Reiseflughöhe aussagekräftig). */
  mach: number | null;
  /** Kurs über Grund in Grad (0 = Nord). */
  trackDeg: number | null;
  /** Außentemperatur in der Flughöhe (°C). */
  outsideTempC: number | null;
  /** Wind in der Flughöhe: Richtung in Grad, Stärke in Knoten. */
  windDirDeg: number | null;
  windKt: number | null;
  /** Entfernung zum Abfragemittelpunkt in Kilometern. */
  distanceKm: number | null;
  /** Sekunden seit der letzten empfangenen Meldung. */
  seenSec: number | null;
  onGround: boolean;
  squawk: string | null;
  /** Notfall-Transpondercode: 7500 Entführung, 7600 Funkausfall, 7700 Notfall. */
  emergency: 'hijack' | 'radio-failure' | 'general' | null;
}

/** Ein Flughafen einer Flugroute. */
export interface Airport {
  name: string;
  municipality: string | null;
  iata: string | null;
  icao: string | null;
  countryName: string | null;
}

/** Nachschlagbare Zusatzdaten zu einem Flug (Halter, Muster, Route). */
export interface AircraftDetails {
  icao: string;
  registration: string | null;
  /** Klartext-Muster, z.B. „A320 271NSL". */
  type: string | null;
  manufacturer: string | null;
  /** Eingetragener Halter, z.B. „Lufthansa". */
  owner: string | null;
  ownerCountry: string | null;
  airline: string | null;
  origin: Airport | null;
  destination: Airport | null;
}

/** Navigationsstatus eines Schiffs (AIS-Feld, vereinfacht). */
export type VesselStatus = 'under-way' | 'anchored' | 'moored' | 'not-under-command' | 'fishing' | 'aground' | 'other';

/** Schiff aus dem AIS-Netz. */
export interface Vessel {
  /** Maritime Mobile Service Identity — eindeutige Schiffskennung. */
  mmsi: number;
  name: string | null;
  /** Schiffsart aus der AIS-Typnummer, bereits eingedeutscht gruppiert. */
  kind: 'cargo' | 'tanker' | 'passenger' | 'tug' | 'fishing' | 'sailing' | 'pleasure' | 'high-speed' | 'authority' | 'other';
  coordinates: Coords;
  /** Geschwindigkeit über Grund in Knoten. */
  speedKt: number | null;
  /** Kurs über Grund in Grad. */
  courseDeg: number | null;
  /** Anliegender Bug-Kurs in Grad (falls gemeldet). */
  headingDeg: number | null;
  status: VesselStatus | null;
  destination: string | null;
  /** Länge über alles in Metern, aus den AIS-Abmessungen. */
  lengthM: number | null;
  reportedAt: string;
}

/**
 * Ein Windpunkt des Vorhersagegitters (10 m über Grund). Die Richtung ist
 * meteorologisch: Grad, aus denen der Wind weht (0 = aus Nord).
 */
export interface WindPoint {
  coordinates: Coords;
  speedKmh: number;
  gustKmh: number | null;
  directionDeg: number;
}

/**
 * Windfeld über dem Kartenausschnitt. Die Punkte liegen als regelmäßiges
 * Gitter vor (zeilenweise von Süd nach Nord, je Zeile von West nach Ost) —
 * damit lässt sich zwischen ihnen sauber interpolieren.
 */
export interface WindField {
  points: WindPoint[];
  cols: number;
  rows: number;
  /** Gültigkeitszeitpunkt des Modells. */
  time: string | null;
}

/** Wetterwerte einer APRS-Wetterstation (aprs.fi liefert metrisch). */
export interface AprsWeather {
  tempC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  windDirDeg: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  rain1hMm: number | null;
  reportedAt: string | null;
}

/**
 * Ein APRS-Ziel (Amateurfunk) von aprs.fi. Die API kennt nur gezielte
 * Rufzeichen-Abfragen — es gibt also immer eine Beobachtungsliste, nie
 * „alles im Ausschnitt".
 */
export interface AprsStation {
  /** Eindeutiges Rufzeichen/Objektname, z.B. „DL1ABC-9". */
  name: string;
  /** Anzeigename, falls abweichend. */
  showname: string | null;
  kind: 'station' | 'object' | 'item' | 'weather' | 'ais' | 'other';
  coordinates: Coords;
  courseDeg: number | null;
  speedKmh: number | null;
  altitudeM: number | null;
  /** APRS-Symbolkennung (Tabelle + Code), z.B. „/>" für ein Auto. */
  symbol: string | null;
  comment: string | null;
  status: string | null;
  path: string | null;
  /** Zeitpunkt der letzten Meldung von dieser Position. */
  lastHeard: string;
  weather: AprsWeather | null;
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
