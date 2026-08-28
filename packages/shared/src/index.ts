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

/**
 * Warnung der Behörden aus dem Warnsystem des Bundes (BBK/NINA) — alles außer
 * dem DWD-Kanal, der schon in `WarningFeature` steckt.
 */
export interface CivilWarning {
  id: string;
  /** Woher die Meldung kommt (Behördenwarnung, KATWARN, Polizei …). */
  channel: string;
  event: string;
  headline: string;
  description?: string;
  instruction?: string;
  severity: Severity;
  /** true bei „sofort handeln". */
  urgent: boolean;
  /** Beschreibung des betroffenen Gebiets im Klartext. */
  areaDesc: string | null;
  sender: string | null;
  web: string | null;
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
  /** PEGELONLINE-Kennung der Messstelle (für den Verlauf). */
  id?: string;
  station: string;
  water: string;
  levelCm: number | null;
  trend: 'rising' | 'falling' | 'steady' | null;
  measuredAt: string | null;
  coordinates?: Coords | null;
  /**
   * Einstufung gegen die amtlichen Kennwerte der Messstelle. `null`, wenn die
   * Stelle keine Vergleichswerte führt — dann steht nur die Zahl da.
   */
  stage?: WaterStage | null;
  /** Woran die Einstufung hängt, im Klartext („über Marke I (620 cm)"). */
  stageNote?: string | null;
  /** Die Kennwerte selbst (MNW, MW, MHW, M_I, M_II, HSW, HHW, MThw …) in cm. */
  marks?: Record<string, number>;
}

/**
 * Stufen von niedrig bis sehr hoch. Bewusst grob: Die Länder führen ihre
 * Meldestufen 1–4 uneinheitlich, die WSV-Kennwerte gibt es dagegen überall.
 */
export type WaterStage = 'low' | 'normal' | 'raised' | 'flood' | 'severe';

/** Ein Messpunkt im Pegelverlauf. */
export interface WaterLevelPoint {
  /** Zeitpunkt (ISO). */
  t: string;
  /** Wasserstand in cm. */
  v: number;
}

/** Verlauf einer Pegel-Messstelle. */
export interface WaterLevelHistory {
  points: WaterLevelPoint[];
  minCm: number;
  maxCm: number;
  /** Änderung der letzten drei Stunden in cm. */
  change3hCm: number | null;
  trend: 'rising' | 'falling' | 'steady' | null;
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
  /**
   * Wo der angefragte Punkt im Gitter liegt (Bruchteile von Zellen). Die
   * Schnittstelle sagt es selbst — verlässlicher, als die Mitte anzunehmen.
   */
  position?: { x: number; y: number };
  frames: RadarForecastFrame[];
}

/** Ein Halt im Verlauf einer Fahrt. */
export interface TransitTripStop {
  name: string;
  lat: number;
  lon: number;
  /** Tatsächliche bzw. geplante Abfahrt (am Ziel: Ankunft). */
  when: string | null;
  plannedWhen: string | null;
  delayMin: number | null;
  cancelled: boolean;
  /** Gleis bzw. Steig, soweit die Fahrplandaten es hergeben. */
  track: string | null;
  /**
   * An- und Abfahrt getrennt — nur bei einer verfolgten Fahrt gesetzt. Bei
   * längeren Aufenthalten sind das zwei verschiedene Zeiten, und genau die
   * braucht, wer am Bahnsteig auf den Zug wartet.
   */
  arrival?: string | null;
  plannedArrival?: string | null;
}

/** Der Laufweg einer Fahrt: alle Halte von Start bis Ziel. */
export interface TransitTrip {
  line: string;
  product: string | null;
  /** Zielbeschilderung der Fahrt. */
  direction: string;
  stops: TransitTripStop[];
  /** Linienzug der ganzen Fahrt [lon, lat] — für die Karte. */
  geometry: [number, number][];
}

/**
 * Ein Ende eines Abschnitts. Neben dem Ort steht hier der **Steig**: die
 * Angabe, nach der man am Bahnhof sucht. `track` ist der aktuelle Stand,
 * `plannedTrack` der des Fahrplans — weichen sie ab, wurde kurzfristig
 * umgelegt, und genau das muss man vor der Abfahrt wissen.
 */
export interface TransitLegPlace {
  name: string;
  lat: number;
  lon: number;
  track: string | null;
  plannedTrack: string | null;
}

/** Ein Abschnitt einer ÖPNV-Verbindung: Fußweg oder Fahrt. */
export interface TransitLeg {
  /** 'WALK' oder ein Verkehrsmittel (BUS, TRAM, …). */
  mode: string;
  /** Deutsche Bezeichnung des Verkehrsmittels (null beim Fußweg). */
  product: string | null;
  line: string | null;
  headsign: string | null;
  from: TransitLegPlace;
  to: TransitLegPlace;
  departure: string | null;
  plannedDeparture: string | null;
  arrival: string | null;
  plannedArrival: string | null;
  delayMin: number | null;
  durationS: number;
  distanceM: number | null;
  cancelled: boolean;
  /** Halte zwischen Ein- und Ausstieg. */
  intermediateStops: TransitTripStop[];
  /** Linienzug [lon, lat] für die Karte. */
  geometry: [number, number][];
}

/** Eine Reisemöglichkeit von A nach B. */
export interface TransitItinerary {
  startTime: string;
  endTime: string;
  durationS: number;
  transfers: number;
  legs: TransitLeg[];
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
  /** Kennung der Fahrt — damit lässt sich ihr Laufweg nachladen. */
  tripId?: string;
}

/** Eine Haltestelle für die Kartenebene (aus den Fahrplandaten). */
export interface TransitStopPoint {
  /** Alle Steig-Kennungen dieser Haltestelle (Richtungen zusammengefasst). */
  ids: string[];
  name: string;
  /** Name ohne vorangestellten Ortsnamen — für die Beschriftung auf der Karte. */
  shortName?: string;
  lat: number;
  lon: number;
  /** Grobe Art für Symbol und Filter. */
  kind: 'bus' | 'tram' | 'rail' | 'ferry' | 'other';
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
  /** Gesetzt, wenn das Luftfahrzeug als BOS-Mittel erkannt wurde. */
  bos?: BosInfo | null;
}

/**
 * Aufgabe eines Behörden-Luftfahrzeugs (BOS = Behörden und Organisationen mit
 * Sicherheitsaufgaben). Bestimmt Symbol und Farbe auf der Karte.
 */
export type BosRole = 'hems' | 'police' | 'sar' | 'fire' | 'customs';

/** Erkennung eines Luftfahrzeugs als BOS-Mittel. */
export interface BosInfo {
  role: BosRole;
  /** Sprechender Name, sofern ableitbar — z.B. „Christoph 43". */
  name: string | null;
  /** Halter aus der Luftfahrzeugrolle, z.B. „DRF Luftrettung". */
  operator: string | null;
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
  /** Ort der Meldung, sofern sie einem Ort zugeordnet werden konnte. */
  place?: NewsPlace;
  /** true bei Meldungen der Regionalprogramme (hessenschau, NDR, BR …). */
  regional?: boolean;
  /** Einordnung nach Inhalt (Schlagzeile, Anriss, Schlagworte). */
  category?: NewsCategory;
}

/**
 * Grobe Einordnung einer Meldung — steuert Symbol und Farbe auf der Karte.
 * `danger` und `crime` sind die für ein Lagebild wichtigen.
 */
export type NewsCategory =
  | 'danger'
  | 'crime'
  | 'traffic'
  | 'weather'
  | 'health'
  | 'politics'
  | 'economy'
  | 'sport'
  | 'culture'
  | 'other';

/**
 * Herausgeber einer Blaulicht-Meldung. Ergibt sich aus dem Kürzel vor dem
 * Doppelpunkt in der Überschrift („POL-BI:", „FW-EN:").
 */
export type BlaulichtKind = 'police' | 'fire' | 'thw' | 'customs' | 'other';

/**
 * Pressemeldung einer Behörde oder Organisation mit Sicherheitsaufgaben
 * (Presseportal/news aktuell). Bewusst nur Kopf und Anriss — der Volltext
 * gehört dem Herausgeber und steht unter `url`.
 */
export interface BlaulichtItem {
  id: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: string | null;
  /** Herausgebende Dienststelle, z.B. „Feuerwehr Herdecke". */
  agency: string;
  kind: BlaulichtKind;
  /**
   * Meldung zu einem tatsächlichen Vorfall — im Unterschied zu Zeugenaufrufen,
   * Pressegesprächen, Verkehrsaktionen und Nachwuchswerbung.
   */
  incident: boolean;
  place?: NewsPlace;
  /** true, wenn die Meldung aus dem Landesfeed am Standort stammt. */
  regional?: boolean;
}

/** Verorteter Bezug einer Meldung. */
export interface NewsPlace {
  name: string;
  lat: number;
  lon: number;
  /** Bundesland-Code der Meldung (Tagesschau-Region). */
  state?: StateCode;
  /** true, wenn nur das Bundesland bekannt ist (Mittelpunkt statt Ort). */
  approximate: boolean;
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

/* ------------------------------------------------------------------ */
/* Funkwetter (Kurzwelle)                                              */
/* ------------------------------------------------------------------ */

/** Bewertung einer Bandgruppe zu Tag oder Nacht. */
export interface HfBandCondition {
  /** Bandgruppe, z.B. „80m-40m". */
  band: string;
  time: 'day' | 'night';
  level: 'good' | 'fair' | 'poor' | 'unknown';
  /** Bezeichnung der Quelle im Original (Good/Fair/Poor). */
  text: string;
}

/** Sonnen- und Erdmagnetdaten mit Bandbewertungen. */
export interface HfSpaceWeather {
  updated: string | null;
  /** Solarer Fluss (10,7 cm) — Maß für die Ionisierung. */
  solarFluxIndex: number | null;
  sunspots: number | null;
  aIndex: number | null;
  kIndex: number | null;
  /** Röntgenklasse, z.B. „B8.3". */
  xray: string | null;
  aurora: number | null;
  geomagField: string | null;
  signalNoise: string | null;
  solarWindKmS: number | null;
  bands: HfBandCondition[];
}

/** Eine Ionosonde mit ihrem gemessenen MUF-Wert. */
export interface HfStation {
  lat: number;
  lon: number;
  mufMHz: number;
  name: string;
}

/**
 * Weltweites Gitter der höchsten brauchbaren Frequenz (MUF, 3000 km Sprung).
 * `values` liegt zeilenweise von Nord (90°) nach Süd, je Zeile von -180° an.
 */
export interface HfMufGrid {
  generatedAt: string;
  solarFluxIndex: number;
  cellDeg: number;
  cols: number;
  rows: number;
  values: number[];
  stations: HfStation[];
}

/** Ein Fahrzeug des öffentlichen Verkehrs in Fahrt. */
export interface TransitVehicle {
  id: string;
  line: string;
  /** MOTIS-Verkehrsmittel (BUS, TRAM, HIGHSPEED_RAIL …). */
  mode: string;
  product: string | null;
  lat: number;
  lon: number;
  /** Fahrtrichtung in Grad. */
  bearing: number;
  towards: string;
  delayMin: number | null;
  realTime: boolean;
}

/**
 * Ein Treffer der Fahrtensuche — eine bestimmte Fahrt, die zur Eingabe passt.
 *
 * Zwei Herkünfte, die sich für den Suchenden deutlich unterscheiden:
 * `live` heißt „fährt gerade und steht mit Position auf der Karte",
 * `stop` heißt „ist an dem genannten Halt für später angekündigt".
 */
export interface TransitFind {
  /** Kennung der Fahrt — damit wird sie verfolgt. */
  tripId: string;
  line: string;
  mode: string;
  product: string | null;
  /** Zielbeschilderung bzw. Endhalt der Fahrt. */
  towards: string;
  /** Startort der Fahrt, soweit bekannt. */
  origin: string | null;
  via: 'live' | 'stop';
  /** Aktuelle Position (nur bei `via: 'live'`). */
  lat: number | null;
  lon: number | null;
  /** Zuletzt bedienter und nächster Halt (nur bei `via: 'live'`). */
  lastStop: string | null;
  nextStop: string | null;
  /** Halt, an dem der Treffer gefunden wurde (nur bei `via: 'stop'`). */
  stopName: string | null;
  /** Abfahrt an diesem Halt (nur bei `via: 'stop'`). */
  when: string | null;
  track: string | null;
  delayMin: number | null;
  realTime: boolean;
  cancelled: boolean;
  /** Entfernung zum Bezugspunkt in Metern (Fahrzeug bzw. Halt). */
  distanceM: number | null;
}

/** Wo eine Fahrt im Ablauf steht. */
export type TransitJourneyState = 'planned' | 'running' | 'done';

/**
 * Eine verfolgte Fahrt: der ganze Laufweg samt gerechneter Position. Alles,
 * was die Fahrplandaten zu dieser einen Fahrt hergeben.
 */
export interface TransitJourney {
  tripId: string;
  line: string;
  mode: string;
  product: string | null;
  /** Zielbeschilderung. */
  towards: string;
  origin: string;
  destination: string;
  /** Verkehrsunternehmen. */
  operator: string | null;
  /** Fahrradmitnahme / Barrierefreiheit, soweit gemeldet (sonst null). */
  bikes: boolean | null;
  wheelchair: boolean | null;
  cancelled: boolean;
  /** true, wenn zu dieser Fahrt Echtzeitmeldungen vorliegen. */
  realTime: boolean;
  /** Verspätung am nächsten Halt (Minuten). */
  delayMin: number | null;
  state: TransitJourneyState;
  /** Gerechnete Position; null, wenn kein Linienzug vorliegt. */
  position: { lat: number; lon: number; bearing: number } | null;
  /** Index des nächsten Halts in `stops` (null, wenn die Fahrt durch ist). */
  nextStopIndex: number | null;
  /** true, wenn die Fahrt gerade an einem Halt steht. */
  atStop: boolean;
  /** Zurückgelegter Anteil der Strecke (0–1). */
  progress: number;
  /** Planmäßige Abfahrt am Start und Ankunft am Ziel. */
  startTime: string | null;
  endTime: string | null;
  stops: TransitTripStop[];
  /** Linienzug [lon, lat] der ganzen Fahrt. */
  geometry: [number, number][];
  /** Zeitpunkt, für den die Position gerechnet wurde. */
  at: string;
}

/** Eine Blitzentladung (Blitzortung.org). */
export interface LightningStrike {
  time: string;
  lat: number;
  lon: number;
  /** Wie viele Empfangsstationen den Blitz gehört haben. */
  stations: number;
  /** Ortungsgenauigkeit in Metern (soweit gemeldet). */
  accuracyM: number | null;
}

/** Rastanlage oder Ladepunkt an einer Autobahn. */
export interface RestFacility {
  id: string;
  road: string;
  kind: 'parking' | 'charging';
  title: string;
  subtitle: string | null;
  lat: number;
  lon: number;
  /** Stellplätze (nur Rastanlagen). */
  carSpaces: number | null;
  lorrySpaces: number | null;
  /** Ladepunkte, Leistung und Betreiber (nur Ladestationen). */
  chargePoints: number | null;
  chargePower: string | null;
  operator: string | null;
  /** Ausstattung im Klartext, soweit gemeldet. */
  features: string[];
}

/**
 * Rettungspunkt: festes, nummeriertes Schild, dessen Kennung man dem
 * Rettungsdienst durchgibt.
 */
export interface RescuePoint {
  id: string;
  /** Kennung auf dem Schild, z. B. „DA-703". */
  ref: string | null;
  name: string | null;
  operator: string | null;
  /** Notrufnummer, falls am Schild vermerkt. */
  phone: string | null;
  lat: number;
  lon: number;
}

/** Standort einer öffentlichen Webcam (Bild bleibt auf der Betreiberseite). */
export interface WebcamSpot {
  id: string;
  name: string;
  title: string | null;
  lat: number;
  lon: number;
  elevationM: number | null;
  /** Blickrichtung in Grad. */
  bearing: number | null;
  country: string;
  offline: boolean;
  url: string;
}

/** Eine Wärmeanomalie aus dem Satellitenblick (NASA FIRMS, VIIRS 375 m). */
export interface FireDetection {
  lat: number;
  lon: number;
  /** Zeitpunkt der Überfliegung (UTC). */
  at: string;
  satellite: string;
  /** Vertrauensgrad der Detektion: low | nominal | high. */
  confidence: string;
  /** Strahlungsleistung des Feuers in Megawatt — grobes Maß für die Stärke. */
  frpMW: number;
  night: boolean;
}

/** Eine Messstelle des ODL-Messnetzes (Bundesamt für Strahlenschutz). */
export interface RadiationStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Gamma-Ortsdosisleistung in µSv/h (Stundenmittel). */
  microSievertPerHour: number;
  /** Anteile des natürlichen Untergrunds, soweit gemeldet. */
  cosmic: number | null;
  terrestrial: number | null;
  measuredAt: string | null;
  validated: boolean;
}

/** Ein Stundenwert der Ortsdosisleistung. */
export interface RadiationPoint {
  t: string;
  /** µSv/h */
  v: number;
}

/** Verlauf einer Sonde für die Kurve im Popup. */
export interface RadiationHistory {
  points: RadiationPoint[];
  min: number;
  max: number;
  average: number;
}

/** Pollenarten des DWD-Gefahrenindex. */
export type PollenKind =
  | 'Hasel'
  | 'Erle'
  | 'Esche'
  | 'Birke'
  | 'Gräser'
  | 'Roggen'
  | 'Beifuß'
  | 'Ambrosia';

/** Belastungsstufe (0 keine … 3 hoch; Zwischenstufen mit ,5). */
export interface PollenLoad {
  value: number;
  text: string;
}

/** Pollenflug für die Region des Standorts. */
export interface PollenForecast {
  regionName: string;
  /** Teilregionen, über die der höchste Wert gebildet wurde. */
  partRegions: string[];
  updatedAt: string | null;
  nextUpdate: string | null;
  kinds: { kind: PollenKind; today: PollenLoad; tomorrow: PollenLoad; dayAfter: PollenLoad }[];
}

/** Ein Erdbeben (USGS). */
export interface EarthquakeItem {
  id: string;
  magnitude: number;
  place: string;
  time: string | null;
  depthKm: number;
  lat: number;
  lon: number;
  url: string;
  tsunami: boolean;
}

/**
 * Polarlicht-Wahrscheinlichkeit als weltweites Gitter (NOAA OVATION).
 * `values` liegt zeilenweise von Nord (90°) nach Süd, je Zeile ab 0° östlicher
 * Länge — Werte in Prozent.
 */
export interface AuroraGrid {
  observedAt: string | null;
  forecastAt: string | null;
  cols: number;
  rows: number;
  values: number[];
  maxPercent: number;
}

/**
 * Waldbrandgefahrenindex des DWD als Fläche über Deutschland (Stufe 1–5).
 * `values` zeilenweise von `north` nach Süden, je Zeile ab `west`.
 */
export interface FireDangerGrid {
  day: string;
  /** Zahl der ausgewerteten Messstationen. */
  stations: number;
  west: number;
  north: number;
  cellDeg: number;
  cols: number;
  rows: number;
  values: number[];
}

/** Ergebnis einer Ortssuche (Geocoding). */
export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
  /** Ergänzender Ort/Adresszusatz für die zweite Zeile. */
  detail?: string | null;
  /** Kategorie-Schlüssel (z.B. 'fuel', 'street', 'place') für Symbol und Filter. */
  category?: string;
  /** Woher der Treffer stammt — offline aus dem Suchindex oder online. */
  source?: 'offline' | 'online';
  /** Interne Kennung im Offline-Index (für die Hausnummern-Auflösung). */
  entryId?: number;
  /** Anzahl bekannter Hausnummern zu dieser Straße (nur offline). */
  addressCount?: number;
  /** Luftlinie zum Bezugspunkt in Metern. */
  distanceM?: number;
}

/* ------------------------------------------------------------------ */
/* Routenplanung (offline)                                             */
/* ------------------------------------------------------------------ */

/** Fortbewegungsart der Routenplanung. */
export type RouteProfile = 'car' | 'bike' | 'foot';

/** Art einer Fahranweisung. */
export type ManeuverType =
  | 'depart'
  | 'turn'
  | 'continue'
  | 'roundabout'
  | 'merge'
  | 'fork'
  /** Zwischenziel erreicht — die Fahrt geht danach weiter. */
  | 'waypoint'
  | 'arrive';

/** Richtung einer Fahranweisung. */
export type ManeuverModifier =
  | 'left'
  | 'slight-left'
  | 'sharp-left'
  | 'right'
  | 'slight-right'
  | 'sharp-right'
  | 'straight'
  | 'uturn';

/** Ein Abschnitt der Route bis zur nächsten Anweisung. */
export interface RouteStep {
  type: ManeuverType;
  modifier: ManeuverModifier | null;
  /** Straßenname des folgenden Abschnitts. */
  name: string | null;
  /** Länge des Abschnitts in Metern. */
  distanceM: number;
  /** Dauer des Abschnitts in Sekunden. */
  durationS: number;
  /** Ort der Anweisung. */
  lat: number;
  lon: number;
  /** Index des Anweisungspunkts in der Routengeometrie. */
  index: number;
  /** Ausfahrt im Kreisverkehr (1-basiert). */
  exit?: number;
  /** Fertiger deutscher Anweisungstext. */
  text: string;
}

/**
 * Warum eine Route (nicht) zustande kam. `start-off-grid`/`end-off-grid`
 * bedeuten: Der Punkt liegt nicht im gespeicherten Straßennetz — dann fehlt
 * die Region, nicht die Verbindung.
 */
export type RouteStatus =
  | 'ok'
  | 'start-off-grid'
  | 'end-off-grid'
  /** Ein Zwischenziel liegt nicht im gespeicherten Netz. */
  | 'via-off-grid'
  | 'no-path';

/** Antwort der Routenberechnung inklusive Begründung. */
export interface RouteOutcome {
  status: RouteStatus;
  /** Beste Route (identisch mit `routes[0]`). */
  route: RouteResult | null;
  /** Bis zu drei deutlich verschiedene Wege, der schnellste zuerst. */
  routes: RouteResult[];
  /** Abstand der Eingabepunkte zum nächsten Weg (Meter). */
  startOffRoadM: number | null;
  endOffRoadM: number | null;
  /** Bei `via-off-grid`: das wievielte Zwischenziel (0-basiert) klemmt. */
  offGridVia?: number;
}

/** Ein Abschnitt zwischen zwei aufeinanderfolgenden Zielen. */
export interface RouteLeg {
  distanceM: number;
  durationS: number;
  /** Erste Anweisung des Abschnitts. */
  stepIndex: number;
  /** Erster Geometriepunkt des Abschnitts. */
  coordIndex: number;
}

/** Ergebnis einer Routenberechnung. */
export interface RouteResult {
  profile: RouteProfile;
  distanceM: number;
  durationS: number;
  /** Linienzug [lon, lat] — direkt als GeoJSON verwendbar. */
  coordinates: [number, number][];
  steps: RouteStep[];
  /** Tatsächlich benutzte Start-/Zielpunkte auf dem Straßennetz. */
  snappedStart: Coords;
  snappedEnd: Coords;
  /** Angefahrene Zwischenziele auf dem Straßennetz (leer ohne Zwischenziele). */
  waypoints?: Coords[];
  /** Abschnitte zwischen den Zielen — nur gesetzt, wenn es Zwischenziele gibt. */
  legs?: RouteLeg[];
}

/**
 * Bahnelemente eines Satelliten im klassischen Zwei-Zeilen-Format (TLE).
 * Sie gelten einige Tage; die Überflugrechnung läuft danach ohne Netz.
 */
export interface SatelliteTle {
  name: string;
  line1: string;
  line2: string;
  /** Aus welcher Gruppe der Eintrag stammt (Stationen, Wetter, Amateurfunk …). */
  group?: string;
}

/** Ein herunterladbares Paket Bahnelemente. */
export interface SatelliteSet {
  satellites: SatelliteTle[];
  /** Wann der Server die Daten geholt hat. */
  updatedAt: string;
}

/** Amtlicher Gemeindeschlüssel → die ersten zwei Ziffern kennzeichnen das Bundesland. */
export type StateCode =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08'
  | '09' | '10' | '11' | '12' | '13' | '14' | '15' | '16';

export interface FederalState {
  code: StateCode;
  name: string;
}

/**
 * Grobe Rechtecke der Bundesländer [west, süd, ost, nord]. Nur genau genug,
 * um zu prüfen, ob ein Punkt plausibel in einem Land liegt.
 */
export const FEDERAL_STATE_BOUNDS: Record<StateCode, [number, number, number, number]> = {
  '01': [7.8, 53.3, 11.4, 55.1],
  '02': [9.7, 53.4, 10.35, 53.75],
  '03': [6.6, 51.3, 11.6, 53.9],
  '04': [8.4, 53.0, 9.0, 53.65],
  '05': [5.8, 50.3, 9.5, 52.6],
  '06': [7.7, 49.4, 10.25, 51.7],
  '07': [6.1, 48.9, 8.55, 50.95],
  '08': [7.5, 47.5, 10.5, 49.8],
  '09': [8.9, 47.2, 13.9, 50.6],
  '10': [6.3, 49.1, 7.45, 49.65],
  '11': [13.05, 52.3, 13.8, 52.7],
  '12': [11.2, 51.3, 14.8, 53.6],
  '13': [10.5, 53.1, 14.45, 54.7],
  '14': [11.8, 50.1, 15.1, 51.7],
  '15': [10.5, 50.9, 13.3, 53.05],
  '16': [9.8, 50.2, 12.7, 51.65],
};

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

/* ------------------------------------------------------------------ */
/* Lawinenlage (EAWS)                                                  */
/* ------------------------------------------------------------------ */

/** Europäische Lawinengefahrenskala 1–5. */
export type AvalancheDanger = 1 | 2 | 3 | 4 | 5;

/** Lage einer Region, wie sie die Karte braucht. */
export interface AvalancheRegion {
  /** EAWS-Kennung, z. B. `DE-BY-12`. */
  id: string;
  /** Höchste Stufe der Region (für Farbe und Sortierung). */
  danger: AvalancheDanger;
  /** Stufe unterhalb bzw. oberhalb der Höhengrenze, falls geteilt. */
  dangerBelow?: AvalancheDanger;
  dangerAbove?: AvalancheDanger;
  /** Höhengrenze im Klartext („Waldgrenze", „1800 m"). */
  boundary?: string;
  /** Lawinenprobleme im Klartext. */
  problems: string[];
  /** Kurzfassung des Berichts. */
  text?: string;
  /** Wer den Bericht herausgibt. */
  source: string;
  validUntil: string | null;
}

export interface AvalancheReport {
  /** Tag, für den die Berichte gelten (ISO-Datum). */
  day: string;
  regions: AvalancheRegion[];
  /** true, wenn außerhalb der Saison nichts veröffentlicht wird. */
  offSeason: boolean;
}

/**
 * Ein geografisches Gebiet nach § 21h LuftVO, wie dipul es an einem Punkt
 * meldet. Enthält bewusst **keine Geometrie** — abgefragt wird immer nur der
 * angetippte Punkt, gezeichnet wird die Ebene als Bild.
 */
export interface DroneZone {
  /** Kennung der Gebietsart beim Dienst, z. B. `kontrollzonen`. */
  kind: string;
  /** Gebietsart im Klartext. */
  art: string;
  name: string;
  /** Untere und obere Grenze („0 m AGL", „2500 ft MSL"), falls angegeben. */
  lower: string | null;
  upper: string | null;
  /** Fundstelle der Festlegung (NfL-Nummer). */
  legalRef: string | null;
  /** Kurzer Hinweis, warum das Gebiet eingetragen ist — keine Rechtsauskunft. */
  note: string | null;
}

/** Löschwasserentnahmestelle aus OpenStreetMap. */
export interface FireWaterPoint {
  id: string;
  kind: 'hydrant' | 'suction' | 'tank';
  /** Bauform des Hydranten (Über-/Unterflur, Wand). */
  form: string | null;
  ref: string | null;
  /** Nennweite, wie am Schild vermerkt. */
  diameter: string | null;
  couplings: string | null;
  /** Fördermenge, wie in den Daten angegeben (nicht umgerechnet). */
  flowRate: string | null;
  operator: string | null;
  lat: number;
  lon: number;
}
